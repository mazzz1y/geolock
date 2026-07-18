import { saveBlob, loadBlobMeta } from './geo/store.js';
import * as geo from './geo/index.js';
import { scanCatalog } from './geo/dat-reader.js';
import { parseRuleSet } from './geo/srs-reader.js';
import { saveConfig, loadConfig, validateConfig, loadRemoteSettings } from './config.js';
import { migrate } from './config/migrations.js';

const DAT_KEY = { geoip: 'geoip.dat', geosite: 'geosite.dat' };
export const RULESET_PREFIX = 'rule-set:';
const HEARTBEAT_ALARM = 'geolock-update-heartbeat';
const HEARTBEAT_PERIOD_MINUTES = 60;
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, readBody = null, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: 'omit', ...init, signal: controller.signal });
    if (!readBody) return response;
    const body = response.ok ? await readBody(response) : null;
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

const lastError = { geoip: null, geosite: null, remote: null };
const inFlight = { geoip: null, geosite: null, remote: null };
const rulesetLastError = {};
const rulesetInFlight = new Map();

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

export function updateRuleset(name) {
  const existing = rulesetInFlight.get(name);
  if (existing) return existing;
  const promise = runUpdateRuleset(name).finally(() => { rulesetInFlight.delete(name); });
  rulesetInFlight.set(name, promise);
  return promise;
}

async function runUpdateRuleset(name) {
  const key = `rule-set:${name}`;
  const config = await loadConfig();
  const source = config.data_sources?.rule_sets?.[name];
  if (!source?.url) throw new Error(`rule-set ${name}: url not configured`);

  notifyDataChanged();
  try {
    const { bytes, bodyHash } = await downloadAndVerify(key, source);
    if (await sourceUrlChanged('rule-set', name, source.url)) {
      return { skipped: 'source-changed' };
    }
    const now = Date.now();
    const previousMeta = await loadBlobMeta(key);

    if (previousMeta?.bodyHash === bodyHash) {
      await saveBlob(key, bytes, {
        ...previousMeta,
        sourceUrl: source.url,
        shaVerified: !!source.sha256_url,
        bodyHash,
        savedAt: now,
      });
      rulesetLastError[name] = null;
      return { unchanged: true, byteLength: bytes.length };
    }

    try {
      await parseRuleSet(bytes);
    } catch (error) {
      throw fail(key, `rule-set ${name}: parse failed (${error.message ?? error})`);
    }

    await saveBlob(key, bytes, {
      sourceUrl: source.url,
      shaVerified: !!source.sha256_url,
      bodyHash,
      savedAt: now,
    });
    if (!await geo.reloadRuleset(name)) {
      throw fail(key, `rule-set ${name}: reload after save returned no index`);
    }
    rulesetLastError[name] = null;
    return { unchanged: false, byteLength: bytes.length };
  } finally {
    notifyDataChanged();
  }
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
    const { bytes, bodyHash } = await downloadAndVerify(kind, source);
    if (await sourceUrlChanged(kind, null, source.url)) {
      return { skipped: 'source-changed' };
    }
    const now = Date.now();
    const previousMeta = await loadBlobMeta(key);

    if (previousMeta?.bodyHash === bodyHash) {
      await saveBlob(key, bytes, {
        ...previousMeta,
        sourceUrl: source.url,
        shaVerified: !!source.sha256_url,
        bodyHash,
        savedAt: now,
      });
      lastError[kind] = null;
      return { unchanged: true, byteLength: bytes.length };
    }

    try {
      scanCatalog(bytes);
    } catch (error) {
      throw fail(kind, `${kind}: parse failed (${error.message ?? error})`);
    }

    await saveBlob(key, bytes, {
      sourceUrl: source.url,
      shaVerified: !!source.sha256_url,
      bodyHash,
      savedAt: now,
    });
    if (!await geo.reload(kind)) {
      throw fail(kind, `${kind}: reload after save returned no index`);
    }
    lastError[kind] = null;
    return { unchanged: false, byteLength: bytes.length };
  } finally {
    notifyDataChanged();
  }
}

async function sourceUrlChanged(kind, name, downloadedUrl) {
  let config;
  try { config = await loadConfig(); }
  catch { return false; }
  const current = kind === 'rule-set'
    ? config.data_sources?.rule_sets?.[name]?.url
    : config.data_sources?.[kind]?.url;
  return current !== downloadedUrl;
}

function setError(kind, message) {
  if (kind.startsWith(RULESET_PREFIX)) rulesetLastError[kind.slice(RULESET_PREFIX.length)] = message;
  else lastError[kind] = message;
}

async function downloadAndVerify(kind, source) {
  let response, buffer;
  try {
    ({ response, body: buffer } = await fetchWithTimeout(source.url, { readBody: r => r.arrayBuffer() }));
  } catch (error) {
    setError(kind, String(error?.message ?? error));
    throw error;
  }
  if (!response.ok) {
    throw fail(kind, `${kind} download failed: ${response.status}`);
  }
  if (buffer.byteLength < 32) {
    throw fail(kind, `${kind}: file suspiciously small`);
  }
  const bytes = new Uint8Array(buffer);
  const bodyHash = await sha256Hex(bytes);

  const shaUrl = (source.sha256_url ?? '').trim();
  if (shaUrl) {
    let expected;
    try { expected = await fetchSha256(shaUrl); }
    catch (error) { throw fail(kind, `${kind}: sha256 fetch failed (${error.message ?? error})`); }
    if (!expected) throw fail(kind, `${kind}: sha256 file did not contain a valid hash`);
    if (bodyHash !== expected) {
      throw fail(kind, `${kind}: sha256 mismatch (expected ${expected}, got ${bodyHash})`);
    }
  }
  return { bytes, bodyHash };
}

async function fetchSha256(url) {
  const { response, body } = await fetchWithTimeout(url, { readBody: r => r.text() });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return parseSha256Sum(body);
}

function fail(kind, message) {
  setError(kind, message);
  return new Error(message);
}

function notifyDataChanged() {
  try { browser.runtime.sendMessage({ kind: 'event:data.changed' }).catch(() => {}); }
  catch { /* ... */ }
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
  try {
    const { response, body } = await fetchWithTimeout(remote.url, { readBody: r => r.text() });
    if (!response.ok) throw new Error(`remote config fetch failed: ${response.status}`);

    let parsed;
    try { parsed = JSON.parse(body); }
    catch { throw new Error('remote config is not valid JSON'); }

    const { config: merged } = migrate(parsed);
    const validation = validateConfig(merged);
    if (!validation.ok) {
      throw new Error('remote config invalid: ' + validation.errors.map(e => `${e.path}: ${e.message}`).join('; '));
    }
    await saveConfig(merged);
    await browser.storage.local.set({ remote_last_applied_at: Date.now() });
    lastError.remote = null;
    return { applied: true };
  } catch (error) {
    lastError.remote = String(error?.message ?? error);
    throw error;
  } finally {
    notifyDataChanged();
  }
}

export async function updateAll() {
  const config = await loadConfig();
  const tasks = ['geoip', 'geosite']
    .filter(kind => config.data_sources?.[kind]?.url)
    .map(kind => updateDat(kind)
      .then(value => [kind, value])
      .catch(error => [kind, { error: String(error.message ?? error) }]));
  for (const [name, stream] of Object.entries(config.data_sources?.rule_sets ?? {})) {
    if (!stream?.url) continue;
    tasks.push(updateRuleset(name)
      .then(value => [`rule-set:${name}`, value])
      .catch(error => [`rule-set:${name}`, { error: String(error.message ?? error) }]));
  }
  return Object.fromEntries(await Promise.all(tasks));
}

export async function updateIfStale(kind) {
  const config = await loadConfig();
  if (kind === 'geoip' || kind === 'geosite') {
    const source = config.data_sources?.[kind];
    if (!shouldAutoUpdate(source)) return { skipped: 'disabled' };
    const meta = await loadBlobMeta(DAT_KEY[kind]);
    if (meta?.savedAt && !isStale({ lastCheckedAt: meta.savedAt, intervalHours: source.interval_hours })) {
      return { skipped: 'fresh' };
    }
    return updateDat(kind);
  }
  if (kind.startsWith(RULESET_PREFIX)) {
    const name = kind.slice(RULESET_PREFIX.length);
    const source = config.data_sources?.rule_sets?.[name];
    if (!shouldAutoUpdate(source)) return { skipped: 'disabled' };
    const meta = await loadBlobMeta(`rule-set:${name}`);
    if (meta?.savedAt && !isStale({ lastCheckedAt: meta.savedAt, intervalHours: source.interval_hours })) {
      return { skipped: 'fresh' };
    }
    return updateRuleset(name);
  }
  if (kind === 'remote') {
    const remote = await loadRemoteSettings();
    if (!shouldAutoUpdate(remote)) return { skipped: 'disabled' };
    const stored = await browser.storage.local.get(['remote_last_applied_at']);
    if (!isStale({ lastCheckedAt: stored?.remote_last_applied_at, intervalHours: remote.interval_hours })) {
      return { skipped: 'fresh' };
    }
    return updateRemoteConfig();
  }
  throw new Error(`unknown update kind: ${kind}`);
}

export async function ensureHeartbeatAlarm() {
  const existing = await browser.alarms.get(HEARTBEAT_ALARM);
  if (existing && existing.periodInMinutes === HEARTBEAT_PERIOD_MINUTES) return;
  await browser.alarms.clear(HEARTBEAT_ALARM);
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
}

export async function handleAlarm(alarm) {
  if (alarm?.name !== HEARTBEAT_ALARM) return;
  const tasks = [
    updateIfStale('geoip'),
    updateIfStale('geosite'),
    updateIfStale('remote'),
  ];
  try {
    const config = await loadConfig();
    for (const name of Object.keys(config.data_sources?.rule_sets ?? {})) {
      tasks.push(updateIfStale(`rule-set:${name}`));
    }
  } catch { /* ... */ }
  await Promise.allSettled(tasks);
}

export function getLastError(kind) {
  if (kind.startsWith(RULESET_PREFIX)) return rulesetLastError[kind.slice(RULESET_PREFIX.length)] ?? null;
  return lastError[kind] ?? null;
}

export function getRulesetErrors() {
  const out = {};
  for (const [name, message] of Object.entries(rulesetLastError)) {
    if (message) out[name] = message;
  }
  return out;
}

export function getProgress() {
  return {
    geoip: !!inFlight.geoip,
    geosite: !!inFlight.geosite,
    remote: !!inFlight.remote,
    rule_sets: [...rulesetInFlight.keys()],
  };
}
