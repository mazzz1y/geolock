import { parseCidr } from '../lib/ip.js';
import { MATCHER_KINDS } from './matchers.js';

const CONFIG_KEY = 'config';
const REMOTE_KEY = 'remote_config';
const STORAGE_VERSION = 1;
const ACTIONS = new Set(['allow', 'block']);

export function defaultConfig() {
  const stream = (extra = {}) => ({ url: '', auto_update: true, interval_hours: 24, ...extra });
  return {
    version: STORAGE_VERSION,
    default_action: 'allow',
    data_sources: {
      geoip: stream({ sha256_url: '' }),
      geosite: stream({ sha256_url: '' }),
    },
    dns: { cache_ttl_seconds: 300, negative_cache_ttl_seconds: 30, timeout_ms: 1500, match_strategy: 'first' },
    rules: [],
  };
}

export function defaultRemoteSettings() {
  return { url: '', auto_update: true, interval_hours: 24 };
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'config must be an object' }] };
  }
  const errors = [];
  if (input.version !== STORAGE_VERSION) {
    errors.push({ path: '/version', message: `expected version ${STORAGE_VERSION}` });
  }
  if (!ACTIONS.has(input.default_action)) {
    errors.push({ path: '/default_action', message: 'must be "allow" or "block"' });
  }
  validateDataSources(input.data_sources, errors);
  validateDns(input.dns, errors);
  if (!Array.isArray(input.rules)) {
    errors.push({ path: '/rules', message: 'must be an array' });
  } else {
    input.rules.forEach((rule, index) => validateRule(rule, `/rules/${index}`, errors));
  }
  return { ok: errors.length === 0, errors };
}

function validateDataSources(sources, errors) {
  if (!sources || typeof sources !== 'object') {
    errors.push({ path: '/data_sources', message: 'must be an object' });
    return;
  }
  for (const key of ['geoip', 'geosite']) {
    const path = `/data_sources/${key}`;
    const source = sources[key];
    if (!validateStream(source, path, errors)) continue;
    validateOptionalHttpsUrl(source.sha256_url, `${path}/sha256_url`, errors);
  }
}

function validateStream(stream, path, errors) {
  if (!stream || typeof stream !== 'object') {
    errors.push({ path, message: 'must be an object' });
    return false;
  }
  validateOptionalHttpsUrl(stream.url, `${path}/url`, errors);
  if (typeof stream.auto_update !== 'boolean') {
    errors.push({ path: `${path}/auto_update`, message: 'must be boolean' });
  }
  if (!Number.isFinite(stream.interval_hours) || stream.interval_hours <= 0) {
    errors.push({ path: `${path}/interval_hours`, message: 'must be a positive number' });
  }
  return true;
}

function validateDns(dns, errors) {
  if (!dns || typeof dns !== 'object') {
    errors.push({ path: '/dns', message: 'must be an object' });
    return;
  }
  validateIntRange(dns.cache_ttl_seconds, '/dns/cache_ttl_seconds', 0, 86400, errors);
  validateIntRange(dns.negative_cache_ttl_seconds, '/dns/negative_cache_ttl_seconds', 0, 3600, errors);
  validateIntRange(dns.timeout_ms, '/dns/timeout_ms', 50, 30000, errors);
  if (dns.match_strategy !== 'first' && dns.match_strategy !== 'all') {
    errors.push({ path: '/dns/match_strategy', message: "must be 'first' or 'all'" });
  }
}

function validateIntRange(value, path, min, max, errors) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `must be an integer in [${min}, ${max}]` });
  }
}

function validateOptionalHttpsUrl(value, path, errors) {
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string' });
  } else if (value && !isHttpsUrl(value)) {
    errors.push({ path, message: 'must be an https URL or empty' });
  }
}

function validateRule(rule, path, errors) {
  if (!rule || typeof rule !== 'object') {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  if (typeof rule.enabled !== 'boolean') {
    errors.push({ path: `${path}/enabled`, message: 'must be boolean' });
  }
  if (!ACTIONS.has(rule.action)) {
    errors.push({ path: `${path}/action`, message: 'must be "allow" or "block"' });
  }
  if (rule.bidirectional !== undefined && typeof rule.bidirectional !== 'boolean') {
    errors.push({ path: `${path}/bidirectional`, message: 'must be boolean' });
  }
  if (rule.strip_referrer_on_navigation !== undefined && typeof rule.strip_referrer_on_navigation !== 'boolean') {
    errors.push({ path: `${path}/strip_referrer_on_navigation`, message: 'must be boolean' });
  }
  validateMatcher(rule.website, `${path}/website`, errors);
  validateMatcher(rule.resource, `${path}/resource`, errors);
}

function validateMatcher(matcher, path, errors) {
  if (!matcher || typeof matcher !== 'object') {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  if (!MATCHER_KINDS.includes(matcher.kind)) {
    errors.push({ path: `${path}/kind`, message: `must be one of ${MATCHER_KINDS.join(', ')}` });
    return;
  }
  switch (matcher.kind) {
    case 'any':
      break;
    case 'geosite':
      requireString(matcher.tag, `${path}/tag`, errors);
      if (matcher.attr != null && typeof matcher.attr !== 'string') {
        errors.push({ path: `${path}/attr`, message: 'must be a string or null' });
      }
      break;
    case 'geoip':
      requireString(matcher.tag, `${path}/tag`, errors);
      break;
    case 'domain':
    case 'url':
      if (typeof matcher.regex !== 'string' || !matcher.regex) {
        errors.push({ path: `${path}/regex`, message: 'must be a non-empty regex string' });
      } else {
        try { new RegExp(matcher.regex); }
        catch { errors.push({ path: `${path}/regex`, message: 'invalid regular expression' }); }
      }
      break;
    case 'ip':
      if (typeof matcher.cidr !== 'string' || !parseCidr(matcher.cidr)) {
        errors.push({ path: `${path}/cidr`, message: 'must be a valid IPv4/IPv6 CIDR' });
      }
      break;
    case 'all_of':
    case 'any_of':
      if (!Array.isArray(matcher.terms) || matcher.terms.length === 0) {
        errors.push({ path: `${path}/terms`, message: 'must be a non-empty array' });
      } else {
        matcher.terms.forEach((term, index) => validateMatcher(term, `${path}/terms/${index}`, errors));
      }
      break;
    case 'not':
      validateMatcher(matcher.term, `${path}/term`, errors);
      break;
  }
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || !value) {
    errors.push({ path, message: 'must be a non-empty string' });
  }
}

function isHttpsUrl(text) {
  try { return new URL(text).protocol === 'https:'; }
  catch { return false; }
}

export async function loadConfig() {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  const candidate = stored?.[CONFIG_KEY];
  if (!candidate) {
    const fresh = defaultConfig();
    await browser.storage.local.set({ [CONFIG_KEY]: fresh });
    return fresh;
  }
  return mergeWithDefaults(candidate);
}

export async function saveConfig(config) {
  const validation = validateConfig(config);
  if (!validation.ok) {
    const summary = validation.errors.map(item => `${item.path || '/'}: ${item.message}`).join('; ');
    throw new Error(`invalid config: ${summary}`);
  }
  const sanitized = structuredClone(config);
  await browser.storage.local.set({ [CONFIG_KEY]: sanitized });
  return sanitized;
}

export function validateRemoteSettings(input) {
  const errors = [];
  validateStream(input, '', errors);
  return { ok: errors.length === 0, errors };
}

export async function loadRemoteSettings() {
  const stored = await browser.storage.local.get(REMOTE_KEY);
  const candidate = stored?.[REMOTE_KEY];
  const base = defaultRemoteSettings();
  if (!candidate || typeof candidate !== 'object') return base;
  return { ...base, ...candidate };
}

export async function saveRemoteSettings(settings) {
  const merged = { ...defaultRemoteSettings(), ...settings };
  const validation = validateRemoteSettings(merged);
  if (!validation.ok) {
    const summary = validation.errors.map(item => `${item.path || '/'}: ${item.message}`).join('; ');
    throw new Error(`invalid remote settings: ${summary}`);
  }
  await browser.storage.local.set({ [REMOTE_KEY]: merged });
  return merged;
}

export function mergeWithDefaults(partial) {
  const base = defaultConfig();
  return {
    version: STORAGE_VERSION,
    default_action: ACTIONS.has(partial.default_action) ? partial.default_action : base.default_action,
    data_sources: {
      geoip: { ...base.data_sources.geoip, ...(partial.data_sources?.geoip ?? {}) },
      geosite: { ...base.data_sources.geosite, ...(partial.data_sources?.geosite ?? {}) },
    },
    dns: { ...base.dns, ...(partial.dns ?? {}) },
    rules: Array.isArray(partial.rules) ? partial.rules.map(normalizeRule) : [],
  };
}

function normalizeRule(rule) {
  return {
    name: typeof rule?.name === 'string' ? rule.name : '',
    enabled: rule?.enabled !== false,
    bidirectional: rule?.bidirectional === true,
    strip_referrer_on_navigation: rule?.strip_referrer_on_navigation === true,
    website: rule?.website ? structuredClone(rule.website) : { kind: 'any' },
    resource: rule?.resource ? structuredClone(rule.resource) : { kind: 'any' },
    action: ACTIONS.has(rule?.action) ? rule.action : 'block',
  };
}