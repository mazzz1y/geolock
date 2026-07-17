import { loadConfig, saveConfig, validateConfig, defaultConfig, loadRemoteSettings, saveRemoteSettings, validateRemoteSettings } from './worker/config.js';
import { migrate } from './worker/config/migrations.js';
import * as enforcer from './worker/enforcer.js';
import * as updater from './worker/updater.js';
import * as geo from './worker/geo/index.js';
import * as dnsCache from './worker/dns-cache.js';
import * as blockLog from './worker/block-log.js';
import * as badge from './worker/badge.js';

function applyDnsConfig(dns) {
  if (!dns) return;
  const options = {};
  if (dns.cache_ttl_seconds != null) options.ttlMs = dns.cache_ttl_seconds * 1000;
  if (dns.negative_cache_ttl_seconds != null) options.negativeTtlMs = dns.negative_cache_ttl_seconds * 1000;
  if (dns.timeout_ms != null) options.timeoutMs = dns.timeout_ms;
  dnsCache.setOptions(options);
}

async function bootstrap() {
  try {
    let config;
    try {
      config = await loadConfig();
    } catch (error) {
      console.error('GeoLock: loadConfig failed, falling back to defaults:', error);
      config = defaultConfig();
    }

    enforcer.setConfig(config);
    applyDnsConfig(config.dns);
    badge.init();

    try {
      const tabs = await browser.tabs.query({});
      const activeIds = new Set(tabs.map(t => t?.id).filter(id => Number.isInteger(id) && id >= 0));
      await blockLog.restore(activeIds);
      for (const id of activeIds) badge.updateBadge(id);
    } catch (error) {
      console.error('GeoLock block-log restore failed:', error);
      badge.resetAllTabs().catch(() => {});
    }
  } finally {
    enforcer.markReady();
  }

  let rulesetNames = [];
  try {
    const config = await loadConfig();
    rulesetNames = Object.keys(config.data_sources?.rulesets ?? {});
  } catch { /* ... */ }

  try { await geo.reloadAll(rulesetNames); }
  catch (error) {
    console.error('GeoLock geo reload failed:', error);
    geo.forceReady();
  }

  try { await updater.ensureHeartbeatAlarm(); }
  catch (error) { console.error('GeoLock alarm scheduling failed:', error); }

  updater.updateIfStale('geoip').catch(() => {});
  updater.updateIfStale('geosite').catch(() => {});
  updater.updateIfStale('remote').catch(() => {});
  for (const name of rulesetNames) {
    updater.updateIfStale(`ruleset:${name}`).catch(() => {});
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  const next = changes.config.newValue;
  const prev = changes.config.oldValue;
  if (!next) return;
  enforcer.setConfig(next);
  applyDnsConfig(next.dns);
  geo.flushWebRequestCache();
  for (const kind of ['geoip', 'geosite']) {
    const newSource = next.data_sources?.[kind];
    const oldUrl = prev?.data_sources?.[kind]?.url ?? '';
    const newUrl = newSource?.url ?? '';
    if (newUrl && newUrl !== oldUrl && newSource.auto_update !== false) {
      updater.updateDat(kind).catch(() => {});
    }
  }
  const nextRulesets = next.data_sources?.rulesets ?? {};
  const prevRulesets = prev?.data_sources?.rulesets ?? {};
  const prevNames = Object.keys(prevRulesets);
  const nextNames = Object.keys(nextRulesets);
  if (nextNames.join('\n') !== prevNames.join('\n')) {
    geo.reloadAll(nextNames).catch(() => {});
  }
  for (const name of nextNames) {
    const newUrl = nextRulesets[name]?.url ?? '';
    const oldUrl = prevRulesets[name]?.url ?? '';
    if (newUrl && newUrl !== oldUrl && nextRulesets[name].auto_update !== false) {
      updater.updateRuleset(name).catch(() => {});
    }
  }
});

browser.alarms.onAlarm.addListener(alarm => {
  updater.handleAlarm(alarm);
});

browser.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const { cleared, flush } = blockLog.noteNavigation(tabId, url);
  if (cleared) badge.updateBadge(tabId);
  if (flush) await flush;
});

browser.tabs.onRemoved.addListener(async tabId => {
  const flush = blockLog.clearTab(tabId);
  if (flush) await flush;
});

browser.webNavigation.onErrorOccurred.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const flush = blockLog.dropMainFrameForUrl(tabId, url);
  if (flush) {
    badge.updateBadge(tabId);
    await flush;
  }
});

function normalizeIncomingConfig(input) {
  return migrate(input ?? {}).config;
}

const handlers = {
  ping: () => ({ ok: true, version: browser.runtime.getManifest().version }),

  'config.get': async () => ({ ok: true, config: await loadConfig() }),

  'config.save': async ({ config }) => {
    const normalized = normalizeIncomingConfig(config);
    const validation = validateConfig(normalized);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const saved = await saveConfig(normalized);
    return { ok: true, config: saved };
  },

  'config.reset': async () => {
    const fresh = defaultConfig();
    await saveConfig(fresh);
    return { ok: true, config: fresh };
  },

  'config.validate': ({ config }) => {
    const normalized = normalizeIncomingConfig(config);
    return { ok: true, validation: validateConfig(normalized), normalized };
  },

  'remote.get': async () => ({ ok: true, settings: await loadRemoteSettings() }),

  'remote.save': async ({ settings }) => {
    const merged = { ...await loadRemoteSettings(), ...settings };
    const validation = validateRemoteSettings(merged);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const saved = await saveRemoteSettings(merged);
    return { ok: true, settings: saved };
  },

  'config.fetchRemote': async () => {
    try {
      const result = await updater.updateRemoteConfig();
      const config = await loadConfig();
      return { ok: true, result, config };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  },

  'data.update': async ({ target }) => {
    try {
      const result = target === 'all' ? await updater.updateAll()
        : typeof target === 'string' && target.startsWith(updater.RULESET_PREFIX) ? await updater.updateRuleset(target.slice(updater.RULESET_PREFIX.length))
        : await updater.updateDat(target);
      return { ok: true, result, status: geo.status() };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  },

  'data.status': async () => {
    await geo.whenReady();
    const stored = await browser.storage.local.get(['remote_last_applied_at']);
    return {
      ok: true,
      status: geo.status(),
      errors: {
        geoip: updater.getLastError('geoip') ?? geo.getReloadError('geoip'),
        geosite: updater.getLastError('geosite') ?? geo.getReloadError('geosite'),
        remote: updater.getLastError('remote'),
        rulesets: updater.getRulesetErrors(),
      },
      updating: updater.getProgress(),
      remoteLastAppliedAt: stored?.remote_last_applied_at ?? null,
    };
  },

  'dns.clearCache': () => {
    dnsCache.clearCache();
    geo.flushWebRequestCache();
    return { ok: true };
  },

  'blocks.get': async ({ tabId }) => {
    await blockLog.whenRestored();
    return { ok: true, entries: blockLog.getForTab(tabId) };
  },

  'tester.evaluate': async ({ sourceUrl, destinationUrl, destinationIp }) => {
    try {
      const result = await enforcer.probe({ sourceUrl, destinationUrl, destinationIp });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  },
};

browser.runtime.onMessage.addListener((message, _sender) => {
  const kind = message?.kind;
  if (typeof kind === 'string' && kind.startsWith('event:')) return undefined;
  const handler = handlers[kind];
  if (!handler) return Promise.resolve({ ok: false, error: 'unknown_message' });
  return Promise.resolve()
    .then(() => handler(message))
    .catch(error => ({ ok: false, error: String(error?.message ?? error) }));
});

enforcer.attach();
bootstrap().catch(error => console.error('GeoLock bootstrap failed:', error));
