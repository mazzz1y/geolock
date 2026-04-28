import { loadConfig, saveConfig, validateConfig, defaultConfig, mergeWithDefaults, loadRemoteSettings, saveRemoteSettings, validateRemoteSettings } from './worker/config.js';
import * as enforcer from './worker/enforcer.js';
import * as updater from './worker/updater.js';
import * as geo from './worker/geo/index.js';
import * as dnsCache from './worker/dns-cache.js';

function applyDnsConfig(dns) {
  if (!dns) return;
  dnsCache.setOptions({
    ttlMs: (dns.cache_ttl_seconds ?? 0) * 1000,
    negativeTtlMs: (dns.negative_cache_ttl_seconds ?? 0) * 1000,
    timeoutMs: dns.timeout_ms,
  });
}

async function bootstrap() {
  const config = await loadConfig();
  enforcer.setConfig(config);
  applyDnsConfig(config.dns);
  try { await geo.reloadAll(); }
  catch (error) { console.error('GeoLock geo reload failed:', error); }
  try { await updater.rescheduleAlarms(); }
  catch (error) { console.error('GeoLock alarm scheduling failed:', error); }
  updater.updateIfStale('geoip').catch(() => {});
  updater.updateIfStale('geosite').catch(() => {});
  updater.updateIfStale('remote').catch(() => {});
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  const next = changes.config.newValue;
  if (next) {
    enforcer.setConfig(next);
    applyDnsConfig(next.dns);
    geo.flushWebRequestCache();
  }
  updater.rescheduleAlarms().catch(() => {});
});

browser.alarms.onAlarm.addListener(alarm => {
  updater.handleAlarm(alarm);
});

const handlers = {
  ping: () => ({ ok: true, version: browser.runtime.getManifest().version }),

  'config.get': async () => ({ ok: true, config: await loadConfig() }),

  'config.save': async ({ config }) => {
    const merged = mergeWithDefaults(config);
    const validation = validateConfig(merged);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const saved = await saveConfig(merged);
    enforcer.setConfig(saved);
    applyDnsConfig(saved.dns);
    geo.flushWebRequestCache();
    await updater.rescheduleAlarms();
    return { ok: true, config: saved };
  },

  'config.reset': async () => {
    const fresh = defaultConfig();
    await saveConfig(fresh);
    enforcer.setConfig(fresh);
    applyDnsConfig(fresh.dns);
    geo.flushWebRequestCache();
    await updater.rescheduleAlarms();
    return { ok: true, config: fresh };
  },

  'config.validate': ({ config }) => {
    const merged = mergeWithDefaults(config);
    return { ok: true, validation: validateConfig(merged), normalized: merged };
  },

  'remote.get': async () => ({ ok: true, settings: await loadRemoteSettings() }),

  'remote.save': async ({ settings }) => {
    const merged = { ...await loadRemoteSettings(), ...settings };
    const validation = validateRemoteSettings(merged);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const saved = await saveRemoteSettings(merged);
    await updater.rescheduleAlarms();
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
      const result = target === 'all' ? await updater.updateAll() : await updater.updateDat(target);
      return { ok: true, result, status: geo.status() };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  },

  'data.status': async () => {
    const stored = await browser.storage.local.get(['remote_last_checked_at', 'remote_last_applied_at']);
    return {
      ok: true,
      status: geo.status(),
      errors: {
        geoip: updater.getLastError('geoip') ?? geo.getReloadError('geoip'),
        geosite: updater.getLastError('geosite') ?? geo.getReloadError('geosite'),
        remote: updater.getLastError('remote'),
      },
      updating: updater.getProgress(),
      remoteLastCheckedAt: stored?.remote_last_checked_at ?? null,
      remoteLastAppliedAt: stored?.remote_last_applied_at ?? null,
    };
  },

  'dns.clearCache': () => {
    dnsCache.clearCache();
    geo.flushWebRequestCache();
    return { ok: true };
  },

  'tester.evaluate': async ({ websiteUrl, resourceUrl, resourceIp }) => {
    try {
      const result = await enforcer.probe({ websiteUrl, resourceUrl, resourceIp });
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
