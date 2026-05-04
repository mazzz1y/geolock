import { evaluate } from './rules-engine.js';
import * as geo from './geo/index.js';
import * as dnsCache from './dns-cache.js';
import { parseIp } from '../lib/ip.js';
import * as blockLog from './block-log.js';
import * as badge from './badge.js';

const tabFrames = new Map();
const SELF_ORIGIN_PREFIX = (() => {
  try { return browser.runtime.getURL(''); }
  catch { return ''; }
})();

let activeConfig = null;
let activeConfigHasStripRule = false;
let listenersAttached = false;

const verdictCache = new Map();
const VERDICT_CACHE_MAX = 100;

export function cachePutVerdict(requestId, result) {
  if (requestId == null) return;
  if (verdictCache.size >= VERDICT_CACHE_MAX) {
    const oldest = verdictCache.keys().next().value;
    if (oldest !== undefined) verdictCache.delete(oldest);
  }
  verdictCache.set(requestId, result);
}

export function cacheTakeVerdict(requestId) {
  if (requestId == null) return undefined;
  const cached = verdictCache.get(requestId);
  if (cached !== undefined) verdictCache.delete(requestId);
  return cached;
}

export function _verdictCacheSize() {
  return verdictCache.size;
}

export function _hasStripRule() {
  return activeConfigHasStripRule;
}

export function setConfig(config) {
  activeConfig = config;
  activeConfigHasStripRule = configHasStripRule(config);
}

function configHasStripRule(config) {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  return rules.some(r => r?.enabled !== false && r?.action === 'block' && r?.strip_referrer === true);
}

export function attach() {
  if (listenersAttached) return;
  listenersAttached = true;
  browser.webNavigation.onCommitted.addListener(handleCommitted);
  browser.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ['<all_urls>'] },
    ['blocking'],
  );
  browser.webRequest.onBeforeSendHeaders.addListener(
    handleBeforeSendHeaders,
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['blocking', 'requestHeaders'],
  );
  browser.tabs.onRemoved.addListener(tabId => tabFrames.delete(tabId));
}

function handleCommitted({ tabId, frameId, parentFrameId, url }) {
  const host = extractHost(url);
  if (!host) return;
  let frames = tabFrames.get(tabId);
  if (!frames) {
    frames = new Map();
    tabFrames.set(tabId, frames);
  }
  frames.set(frameId, { host, url, parentFrameId });
  if (frameId === 0) {
    for (const id of frames.keys()) {
      if (id !== 0 && !isDescendant(frames, id, 0)) frames.delete(id);
    }
  }
}

function isDescendant(frames, frameId, ancestorId) {
  let current = frames.get(frameId);
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (current.parentFrameId === ancestorId) return true;
    if (current.parentFrameId < 0) return false;
    current = frames.get(current.parentFrameId);
  }
  return false;
}

export function deriveSourceContext(details, frames = tabFrames) {
  if (details.tabId >= 0) {
    const frame = frames.get(details.tabId)?.get(details.frameId)
      ?? frames.get(details.tabId)?.get(0);
    if (frame) return { host: frame.host, url: frame.url };
  }
  for (const candidate of [details.documentUrl, details.originUrl, details.initiator]) {
    const host = extractHost(candidate);
    if (host) return { host, url: candidate };
  }
  return { host: '', url: '' };
}

async function handleBeforeRequest(details) {
  const result = await evaluateRequest(details, {
    config: activeConfig,
    geo,
    dnsLookup: host => dnsCache.lookup(host),
    frames: tabFrames,
    selfOriginPrefix: SELF_ORIGIN_PREFIX,
    whenReady: () => geo.whenReady(),
    trace: true,
  });
  if (details.type === 'main_frame' && activeConfigHasStripRule && result?.matchedRule) {
    cachePutVerdict(details.requestId, result);
  }
  if (result?.verdict !== 'block') return undefined;
  if (details.type === 'main_frame' && matchedRuleStrips(result.matchedRule)) return undefined;

  const tabId = details.tabId;
  const flush = blockLog.record(tabId, {
    ts: Date.now(),
    destinationUrl: details.url,
    destinationHost: extractHost(details.url),
    destinationType: details.type,
    sourceHost: result.contexts?.source?.host ?? '',
    sourceUrl: result.contexts?.source?.url ?? '',
    matchedRule: result.matchedRule,
    trace: result.trace,
    contexts: result.contexts,
    effect: 'block',
  });
  badge.updateBadge(tabId);
  notifyBlocksChanged(tabId);
  if (flush) await flush;
  return { cancel: true };
}

function matchedRuleStrips(matchedRule) {
  if (!matchedRule || !activeConfig) return false;
  const rule = activeConfig.rules?.[matchedRule.index];
  return !!rule && rule.action === 'block' && rule.strip_referrer === true;
}

async function handleBeforeSendHeaders(details) {
  if (!activeConfigHasStripRule) return undefined;
  if (details.type !== 'main_frame') return undefined;
  const original = details.requestHeaders ?? [];
  if (!original.some(h => h.name.toLowerCase() === 'referer')) return undefined;
  const cached = cacheTakeVerdict(details.requestId);
  const result = cached ?? await evaluateRequest(details, {
    config: activeConfig,
    geo,
    dnsLookup: host => dnsCache.lookup(host),
    frames: tabFrames,
    selfOriginPrefix: SELF_ORIGIN_PREFIX,
    whenReady: () => geo.whenReady(),
    trace: true,
  });
  if (result?.verdict !== 'block') return undefined;
  if (!matchedRuleStrips(result.matchedRule)) return undefined;
  const tabId = details.tabId;
  const flush = blockLog.record(tabId, {
    ts: Date.now(),
    destinationUrl: details.url,
    destinationHost: extractHost(details.url),
    destinationType: details.type,
    sourceHost: result.contexts?.source?.host ?? '',
    sourceUrl: result.contexts?.source?.url ?? '',
    matchedRule: result.matchedRule,
    trace: result.trace,
    contexts: result.contexts,
    effect: 'referrer-stripped',
  });
  badge.updateBadge(tabId);
  notifyBlocksChanged(tabId);
  if (flush) await flush;
  return { requestHeaders: original.filter(h => h.name.toLowerCase() !== 'referer') };
}

function notifyBlocksChanged(tabId) {
  try {
    browser.runtime.sendMessage({ kind: 'event:blocks.changed', tabId }).catch(() => {});
  } catch { /* ... */ }
}

export async function evaluateRequest(details, { config, geo, dnsLookup, frames, selfOriginPrefix, whenReady, trace = false }) {
  if (!config) return null;
  if (details.type === 'csp_report') return null;
  if (details.type === 'main_frame' && !configHasStripRule(config)) return null;
  if (isSelfOriginated(details, selfOriginPrefix)) return null;

  const destinationHost = extractHost(details.url);
  if (!destinationHost) return null;

  const source = deriveSourceContext(details, frames);
  if (isSameSite(destinationHost, source.host)) return null;
  const sourceContext = { host: source.host, url: source.url, ips: [] };
  const destinationContext = { host: destinationHost, url: details.url, ips: [] };

  if (whenReady) await whenReady();

  const strategy = config?.dns?.match_strategy;
  const resolve = async ctx => {
    await resolveContextIps(ctx, dnsLookup);
    applyMatchStrategy(ctx, strategy);
  };

  try {
    return await evaluate(config, { source: sourceContext, destination: destinationContext }, geo,
      { resolveSource: resolve, resolveDestination: resolve },
      { trace });
  } catch (error) {
    console.error('GeoLock evaluate failed:', error);
    return {
      verdict: config.default_action === 'block' ? 'block' : 'allow',
      matchedRule: null,
      trace: null,
      contexts: null,
    };
  }
}

function applyMatchStrategy(ctx, strategy) {
  if (strategy === 'first' && ctx.ips.length > 1) ctx.ips = [ctx.ips[0]];
}

function extractHost(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

function isSelfOriginated(details, selfOriginPrefix) {
  if (!selfOriginPrefix) return false;
  return [details.documentUrl, details.originUrl, details.initiator]
    .some(candidate => typeof candidate === 'string' && candidate.startsWith(selfOriginPrefix));
}

function isSameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('.' + b) || b.endsWith('.' + a);
}

async function resolveContextIps(ctx, dnsLookup) {
  if (ctx.ips.length || !ctx.host) return;
  const literal = parseIp(ctx.host);
  if (literal) {
    ctx.ips = [literal];
    return;
  }
  try {
    ctx.ips = await dnsLookup(ctx.host) ?? [];
  } catch { ctx.ips = []; }
}

export async function probe({ sourceUrl, destinationUrl, destinationIp }) {
  const sourceContext = { host: hostFromUserInput(sourceUrl), url: normalizeUserUrl(sourceUrl), ips: [] };
  const destinationContext = { host: hostFromUserInput(destinationUrl), url: normalizeUserUrl(destinationUrl), ips: [] };
  if (destinationIp) {
    const parsed = parseIp(destinationIp);
    if (parsed) destinationContext.ips = [parsed];
  }

  const dnsLookup = host => dnsCache.lookup(host);
  await geo.whenReady();

  const strategy = activeConfig?.dns?.match_strategy;
  const resolve = async ctx => {
    await resolveContextIps(ctx, dnsLookup);
    applyMatchStrategy(ctx, strategy);
  };

  return evaluate(
    activeConfig ?? { default_action: 'allow', rules: [] },
    { source: sourceContext, destination: destinationContext },
    geo,
    { resolveSource: resolve, resolveDestination: resolve },
    { trace: true },
  );
}

function hostFromUserInput(text) {
  const normalized = normalizeUserUrl(text);
  return normalized ? extractHost(normalized) : '';
}

function normalizeUserUrl(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const trimmed = text.trim();
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`;
}
