import { saveBlob, loadBlobMeta, updateBlobMeta } from './geo/store.js';
import * as geo from './geo/index.js';
import { scanCatalog } from './geo/dat-reader.js';
import { saveConfig, loadConfig, mergeWithDefaults, validateConfig, loadRemoteSettings } from './config.js';

const DAT_KEY = { geoip: 'geoip.dat', geosite: 'geosite.dat' };
const ALARMS = {
  geoip: 'geolock-update-geoip',
  geosite: 'geolock-update-geosite',
  remote: 'geolock-update-remote',
};

const lastError = { geoip: null, geosite: null, remote: null };
const inFlight = { geoip: null, geosite: null, remote: null };

export function isStale({ lastCheckedAt, intervalHours, now = Date.now() }) {
  if (!lastCheckedAt) return true;
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return true;
  return (now - lastCheckedAt) >= intervalHours * 3600 * 1000;
}

export function shouldAutoUpdate(stream) {
  return !!stream?.url && stream.auto_update !== false;
}

export function updateDat(kind) {
  if (inFlight[kind]) return inFlight[kind];
  const promise = runUpdateDat(kind).finally(() => { inFlight[kind] = null; });
  inFlight[kind] = promise;
  return promise;
}

export function updateRemoteConfig() {
  if (inFlight.remote) return inFlight.remote;
  const promise = runUpdateRemoteConfig().finally(() => { inFlight.remote = null; });
  inFlight.remote = promise;
  return promise;
}

async function runUpdateDat(kind) {
  const key = DAT_KEY[kind];
  if (!key) throw new Error(`unknown dat kind: ${kind}`);
  const config = await loadConfig();
  const source = config.data_sources?.[kind];
  if (!source?.url) throw new Error(`${kind} url not configured`);

  notifyDataChanged();
  try {
    const bytes = await downloadAndVerify(kind, key, source);
    const bodyHash = await sha256Hex(bytes);
    const now = Date.now();
    const previousMeta = await loadBlobMeta(key);

    if (previousMeta?.bodyHash === bodyHash) {
      await updateBlobMeta(key, { lastCheckedAt: now, sourceUrl: source.url, shaVerified: !!source.sha256_url });
      lastError[kind] = null;
      return { unchanged: true, byteLength: bytes.length };
    }

    try {
      scanCatalog(bytes);
    } catch (error) {
      throw await fail(kind, key, `${kind}: parse failed (${error.message ?? error})`);
    }

    await saveBlob(key, bytes, {
      sourceUrl: source.url,
      shaVerified: !!source.sha256_url,
      bodyHash,
      savedAt: now,
      lastCheckedAt: now,
    });
    if (!await geo.reload(kind)) {
      throw await fail(kind, key, `${kind}: reload after save returned no index`);
    }
    lastError[kind] = null;
    return { unchanged: false, byteLength: bytes.length };
  } finally {
    notifyDataChanged();
  }
}

async function downloadAndVerify(kind, key, source) {
  let response;
  try {
    response = await fetch(source.url, { credentials: 'omit' });
  } catch (error) {
    lastError[kind] = String(error?.message ?? error);
    await markChecked(key);
    throw error;
  }
  if (!response.ok) {
    throw await fail(kind, key, `${kind} download failed: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 32) {
    throw await fail(kind, key, `${kind}: file suspiciously small`);
  }
  const bytes = new Uint8Array(buffer);

  const shaUrl = (source.sha256_url ?? '').trim();
  if (shaUrl) {
    const expected = await fetchSha256(shaUrl).catch(error => {
      throw fail(kind, key, `${kind}: sha256 fetch failed (${error.message ?? error})`);
    });
    if (!expected) throw await fail(kind, key, `${kind}: sha256 file did not contain a valid hash`);
    const actual = await sha256Hex(bytes);
    if (actual !== expected) {
      throw await fail(kind, key, `${kind}: sha256 mismatch (expected ${expected}, got ${actual})`);
    }
  }
  return bytes;
}

async function fetchSha256(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return parseSha256Sum(await response.text());
}

async function fail(kind, key, message) {
  lastError[kind] = message;
  await markChecked(key);
  return new Error(message);
}

async function markChecked(key) {
  try {
    if (await loadBlobMeta(key)) {
      await updateBlobMeta(key, { lastCheckedAt: Date.now() });
    }
  } catch { /* best-effort */ }
}

function notifyDataChanged() {
  try { browser.runtime.sendMessage({ kind: 'event:data.changed' }).catch(() => {}); }
  catch { /* no listeners */ }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function parseSha256Sum(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /\b([0-9a-fA-F]{64})\b/.exec(line);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

async function runUpdateRemoteConfig() {
  const config = await loadConfig();
  const remote = await loadRemoteSettings();
  if (!remote?.url) throw new Error('remote config url not set');

  notifyDataChanged();
  const now = Date.now();
  const stamp = () => browser.storage.local.set({ remote_last_checked_at: now });
  try {
    let response;
    try { response = await fetch(remote.url, { credentials: 'omit' }); }
    catch (error) { await stamp(); throw error; }

    if (!response.ok) { await stamp(); throw new Error(`remote config fetch failed: ${response.status}`); }

    let parsed;
    try { parsed = JSON.parse(await response.text()); }
    catch { await stamp(); throw new Error('remote config is not valid JSON'); }

    const merged = mergeWithDefaults(parsed);
    const validation = validateConfig(merged);
    if (!validation.ok) {
      await stamp();
      throw new Error('remote config invalid: ' + validation.errors.map(e => `${e.path}: ${e.message}`).join('; '));
    }
    merged.data_sources = mergeDataSources(config.data_sources, merged.data_sources);

    await saveConfig(merged);
    await browser.storage.local.set({ remote_last_checked_at: now, remote_last_applied_at: now });
    lastError.remote = null;
    return { applied: true };
  } catch (error) {
    lastError.remote = String(error?.message ?? error);
    throw error;
  } finally {
    notifyDataChanged();
  }
}

export function mergeDataSources(current, incoming) {
  const merged = {};
  for (const key of ['geoip', 'geosite']) {
    merged[key] = { ...current?.[key], ...(incoming?.[key] ?? {}) };
  }
  return merged;
}

export async function updateAll() {
  const config = await loadConfig();
  const tasks = ['geoip', 'geosite']
    .filter(kind => config.data_sources?.[kind]?.url)
    .map(kind => updateDat(kind)
      .then(value => [kind, value])
      .catch(error => [kind, { error: String(error.message ?? error) }]));
  return Object.fromEntries(await Promise.all(tasks));
}

export async function updateIfStale(kind) {
  const config = await loadConfig();
  if (kind === 'geoip' || kind === 'geosite') {
    const source = config.data_sources?.[kind];
    if (!shouldAutoUpdate(source)) return { skipped: 'disabled' };
    const meta = await loadBlobMeta(DAT_KEY[kind]);
    if (meta?.savedAt && !isStale({ lastCheckedAt: meta.lastCheckedAt, intervalHours: source.interval_hours })) {
      return { skipped: 'fresh' };
    }
    return updateDat(kind);
  }
  if (kind === 'remote') {
    const remote = await loadRemoteSettings();
    if (!shouldAutoUpdate(remote)) return { skipped: 'disabled' };
    const stored = await browser.storage.local.get(['remote_last_checked_at', 'remote_last_applied_at']);
    if (stored?.remote_last_applied_at && !isStale({ lastCheckedAt: stored.remote_last_checked_at, intervalHours: remote.interval_hours })) {
      return { skipped: 'fresh' };
    }
    return updateRemoteConfig();
  }
  throw new Error(`unknown update kind: ${kind}`);
}

export async function rescheduleAlarms() {
  const config = await loadConfig();
  const sources = {
    geoip: config.data_sources?.geoip,
    geosite: config.data_sources?.geosite,
    remote: await loadRemoteSettings(),
  };
  for (const [kind, source] of Object.entries(sources)) {
    await browser.alarms.clear(ALARMS[kind]);
    if (shouldAutoUpdate(source)) {
      browser.alarms.create(ALARMS[kind], {
        periodInMinutes: Math.max(60, (source.interval_hours ?? 24) * 60),
      });
    }
  }
}

export function handleAlarm(alarm) {
  if (alarm.name === ALARMS.geoip)   return updateDat('geoip').catch(() => {});
  if (alarm.name === ALARMS.geosite) return updateDat('geosite').catch(() => {});
  if (alarm.name === ALARMS.remote)  return updateRemoteConfig().catch(() => {});
  return Promise.resolve();
}

export function getLastError(kind) {
  return lastError[kind] ?? null;
}

export function getProgress() {
  return {
    geoip: !!inFlight.geoip,
    geosite: !!inFlight.geosite,
    remote: !!inFlight.remote,
  };
}
