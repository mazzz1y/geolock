import { evaluate } from './rules-engine.js';
import * as geo from './geo/index.js';
import * as dnsCache from './dns-cache.js';
import { parseIp } from '../lib/ip.js';

const tabFrames = new Map();
const SELF_ORIGIN_PREFIX = (() => {
  try { return browser.runtime.getURL(''); }
  catch { return ''; }
})();

let activeConfig = null;
let listenersAttached = false;

export function setConfig(config) {
  activeConfig = config;
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

export function deriveWebsiteContext(details, frames = tabFrames) {
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
  });
  return result?.verdict === 'block' ? { cancel: true } : undefined;
}

export async function evaluateRequest(details, { config, geo, dnsLookup, frames, selfOriginPrefix, whenReady, trace = false }) {
  if (!config) return null;
  if (details.type === 'main_frame' || details.type === 'csp_report') return null;
  if (isSelfOriginated(details, selfOriginPrefix)) return null;

  const resourceHost = extractHost(details.url);
  if (!resourceHost) return null;

  const website = deriveWebsiteContext(details, frames);
  const websiteContext = { host: website.host, url: website.url, ips: [] };
  const resourceContext = { host: resourceHost, url: details.url, ips: [] };

  if (whenReady) await whenReady();

  const strategy = config?.dns?.match_strategy;
  const resolve = async ctx => {
    await resolveContextIps(ctx, dnsLookup);
    applyMatchStrategy(ctx, strategy);
  };

  try {
    return await evaluate(config, { website: websiteContext, resource: resourceContext }, geo,
      { resolveWebsite: resolve, resolveResource: resolve },
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

export async function probe({ websiteUrl, resourceUrl, resourceIp }) {
  const websiteContext = { host: hostFromUserInput(websiteUrl), url: websiteUrl, ips: [] };
  const resourceContext = { host: hostFromUserInput(resourceUrl), url: resourceUrl, ips: [] };
  if (resourceIp) {
    const parsed = parseIp(resourceIp);
    if (parsed) resourceContext.ips = [parsed];
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
    { website: websiteContext, resource: resourceContext },
    geo,
    { resolveWebsite: resolve, resolveResource: resolve },
    { trace: true },
  );
}

function hostFromUserInput(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const trimmed = text.trim();
  return extractHost(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
}
