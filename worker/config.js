import { parseCidr } from '../lib/ip.js';
import { CONFIG_TEMPLATE, RULE_TEMPLATES, MATCHER_TEMPLATES } from './config/templates.js';
export { desugarRule } from './rule-shape.js';

const CONFIG_KEY = 'config';
const REMOTE_KEY = 'remote_config';
const STORAGE_VERSION = 2;
const ACTIONS = new Set(['allow', 'block']);

export function defaultConfig() {
  return structuredClone(CONFIG_TEMPLATE);
}

export function defaultRemoteSettings() {
  return { url: '', auto_update: true, interval_hours: 24 };
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path: '', message: 'config must be an object' }] };
  }
  const errors = [];
  if (input.version === 1) {
    errors.push({ path: '/version', message: 'this config uses the legacy v1 schema; migrate it first' });
  } else if (input.version !== STORAGE_VERSION) {
    errors.push({ path: '/version', message: `expected version ${STORAGE_VERSION}` });
  }
  walkAgainstTemplate(input, CONFIG_TEMPLATE, '', errors);
  if (Array.isArray(input.rules)) {
    input.rules.forEach((rule, i) => walkRule(rule, `/rules/${i}`, errors));
  }
  semanticChecks(input, errors);
  return { ok: errors.length === 0, errors };
}

const MATCHER_KEYS = new Set(['source', 'destination', 'match']);

function walkAgainstTemplate(input, template, path, errors) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const allowed = new Set(Object.keys(template));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${path}/${key}`, message: 'unknown field' });
    }
  }
  for (const key of Object.keys(template)) {
    if (MATCHER_KEYS.has(key)) continue;
    if (key === 'rule_sets' && path === '/data_sources') continue;
    const childTemplate = template[key];
    const childPath = `${path}/${key}`;
    const childInput = input[key];
    if (Array.isArray(childTemplate)) {
      if (childInput !== undefined && !Array.isArray(childInput)) {
        errors.push({ path: childPath, message: 'must be an array' });
      }
      continue;
    }
    if (childTemplate !== null && typeof childTemplate === 'object') {
      if (childInput === undefined) {
        errors.push({ path: childPath, message: 'must be an object' });
        continue;
      }
      walkAgainstTemplate(childInput, childTemplate, childPath, errors);
      continue;
    }
    if (childInput !== undefined && typeof childInput !== typeof childTemplate) {
      errors.push({ path: childPath, message: `must be ${typeof childTemplate}` });
    }
  }
}

function walkRule(rule, path, errors) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const isolate = rule.mode === 'isolate';
  if (rule.mode !== undefined && rule.mode !== 'isolate') {
    errors.push({ path: `${path}/mode`, message: 'must be "isolate" or omitted' });
    return;
  }
  walkAgainstTemplate(rule, RULE_TEMPLATES[isolate ? 'isolate' : 'flow'], path, errors);
  if (isolate) {
    walkMatcher(rule.match, `${path}/match`, errors);
  } else {
    walkMatcher(rule.source, `${path}/source`, errors);
    walkMatcher(rule.destination, `${path}/destination`, errors);
  }
}

function walkMatcher(matcher, path, errors) {
  if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const template = MATCHER_TEMPLATES[matcher.type];
  if (!template) {
    errors.push({ path: `${path}/type`, message: `must be one of ${Object.keys(MATCHER_TEMPLATES).join(', ')}` });
    return;
  }
  walkAgainstTemplate(matcher, template, path, errors);
  if (matcher.type === 'and' || matcher.type === 'or') {
    if (Array.isArray(matcher.matches)) {
      matcher.matches.forEach((term, i) => walkMatcher(term, `${path}/matches/${i}`, errors));
    }
  } else if (matcher.type === 'not') {
    if (matcher.match !== undefined) walkMatcher(matcher.match, `${path}/match`, errors);
  }
}

function semanticChecks(input, errors) {
  if (input.default_action !== undefined && !ACTIONS.has(input.default_action)) {
    errors.push({ path: '/default_action', message: 'must be "allow" or "block"' });
  }
  if (input.dns && typeof input.dns === 'object' && !Array.isArray(input.dns)) {
    checkIntRange(input.dns.cache_ttl_seconds, '/dns/cache_ttl_seconds', 0, 86400, errors);
    checkIntRange(input.dns.negative_cache_ttl_seconds, '/dns/negative_cache_ttl_seconds', 0, 3600, errors);
    checkIntRange(input.dns.timeout_ms, '/dns/timeout_ms', 50, 30000, errors);
    if (input.dns.match_strategy !== undefined && input.dns.match_strategy !== 'first' && input.dns.match_strategy !== 'all') {
      errors.push({ path: '/dns/match_strategy', message: "must be 'first' or 'all'" });
    }
  }
  if (input.data_sources && typeof input.data_sources === 'object' && !Array.isArray(input.data_sources)) {
    for (const k of ['geoip', 'geosite']) {
      const stream = input.data_sources[k];
      if (stream && typeof stream === 'object' && !Array.isArray(stream)) {
        semanticStream(stream, `/data_sources/${k}`, errors);
      }
    }
    semanticRulesets(input.data_sources.rule_sets, errors);
  }
  if (Array.isArray(input.rules)) {
    input.rules.forEach((rule, i) => semanticRule(rule, `/rules/${i}`, errors));
  }
}

const RULESET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RULESET_MAX_COUNT = 64;
const RULESET_STREAM_KEYS = new Set(['url', 'sha256_url', 'auto_update', 'interval_hours']);

function semanticRulesets(rulesets, errors) {
  if (rulesets === undefined) return;
  if (!rulesets || typeof rulesets !== 'object' || Array.isArray(rulesets)) {
    errors.push({ path: '/data_sources/rule_sets', message: 'must be an object' });
    return;
  }
  const names = Object.keys(rulesets);
  if (names.length > RULESET_MAX_COUNT) {
    errors.push({ path: '/data_sources/rule_sets', message: `at most ${RULESET_MAX_COUNT} rule-sets allowed` });
    return;
  }
  for (const name of names) {
    const path = `/data_sources/rule_sets/${name}`;
    if (name.length > 64 || !RULESET_NAME_RE.test(name)) {
      errors.push({ path, message: 'invalid rule-set name' });
      continue;
    }
    const stream = rulesets[name];
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
      errors.push({ path, message: 'must be an object' });
      continue;
    }
    for (const key of Object.keys(stream)) {
      if (!RULESET_STREAM_KEYS.has(key)) {
        errors.push({ path: `${path}/${key}`, message: 'unknown field' });
      }
    }
    if (stream.url !== undefined && typeof stream.url !== 'string') {
      errors.push({ path: `${path}/url`, message: 'must be a string' });
    }
    if (stream.sha256_url !== undefined && typeof stream.sha256_url !== 'string') {
      errors.push({ path: `${path}/sha256_url`, message: 'must be a string' });
    }
    if (stream.auto_update !== undefined && typeof stream.auto_update !== 'boolean') {
      errors.push({ path: `${path}/auto_update`, message: 'must be boolean' });
    }
    semanticStream(stream, path, errors);
  }
}

function semanticStream(stream, path, errors) {
  if (stream.url !== undefined && typeof stream.url === 'string' && stream.url && !isHttpsUrl(stream.url)) {
    errors.push({ path: `${path}/url`, message: 'must be an https URL or empty' });
  }
  if (stream.sha256_url !== undefined && typeof stream.sha256_url === 'string' && stream.sha256_url && !isHttpsUrl(stream.sha256_url)) {
    errors.push({ path: `${path}/sha256_url`, message: 'must be an https URL or empty' });
  }
  if (stream.interval_hours !== undefined && (!Number.isFinite(stream.interval_hours) || stream.interval_hours <= 0)) {
    errors.push({ path: `${path}/interval_hours`, message: 'must be a positive number' });
  }
}

function semanticRule(rule, path, errors) {
  if (!rule || typeof rule !== 'object') return;
  if (rule.action !== undefined && !ACTIONS.has(rule.action)) {
    errors.push({ path: `${path}/action`, message: 'must be "allow" or "block"' });
  }
  if (rule.strip_referrer === true && rule.action !== 'block') {
    errors.push({ path: `${path}/strip_referrer`, message: 'requires action: block' });
  }
  if (rule.mode === 'isolate') {
    semanticMatcher(rule.match, `${path}/match`, errors);
  } else if (rule.mode === undefined) {
    semanticMatcher(rule.source, `${path}/source`, errors);
    semanticMatcher(rule.destination, `${path}/destination`, errors);
  }
}

function semanticMatcher(matcher, path, errors) {
  if (!matcher || typeof matcher !== 'object') return;
  switch (matcher.type) {
    case 'geosite':
    case 'geoip':
    case 'rule-set':
      if (typeof matcher.tag !== 'string' || !matcher.tag) {
        errors.push({ path: `${path}/tag`, message: 'must be a non-empty string' });
      }
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
    case 'and':
    case 'or':
      if (!Array.isArray(matcher.matches) || matcher.matches.length === 0) {
        errors.push({ path: `${path}/matches`, message: 'must be a non-empty array' });
      } else {
        matcher.matches.forEach((term, i) => semanticMatcher(term, `${path}/matches/${i}`, errors));
      }
      break;
    case 'not':
      if (matcher.match !== undefined) semanticMatcher(matcher.match, `${path}/match`, errors);
      break;
  }
}

function checkIntRange(value, path, min, max, errors) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `must be an integer in [${min}, ${max}]` });
  }
}

function isHttpsUrl(text) {
  try { return new URL(text).protocol === 'https:'; }
  catch { return false; }
}

export async function loadConfig() {
  const { isLegacyV1Config } = await import('./config/v1.js');
  const { migrate } = await import('./config/migrations.js');
  const stored = await browser.storage.local.get(CONFIG_KEY);
  const candidate = stored?.[CONFIG_KEY];
  if (!candidate) {
    const fresh = defaultConfig();
    await browser.storage.local.set({ [CONFIG_KEY]: fresh });
    return fresh;
  }
  if (isLegacyV1Config(candidate)) {
    const { config } = migrate(candidate);
    await browser.storage.local.set({ [CONFIG_KEY]: config });
    return config;
  }
  const merged = mergeWithDefaults(candidate);
  const validation = validateConfig(merged);
  if (!validation.ok) {
    console.error('GeoLock: stored config failed validation, resetting to defaults', validation.errors);
    const fresh = defaultConfig();
    await browser.storage.local.set({ [CONFIG_KEY]: fresh });
    return fresh;
  }
  if (candidate.version !== STORAGE_VERSION) {
    await browser.storage.local.set({ [CONFIG_KEY]: merged });
  }
  return merged;
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ path: '', message: 'must be an object' });
    return { ok: false, errors };
  }
  if (input.url !== undefined && typeof input.url === 'string' && input.url && !isHttpsUrl(input.url)) {
    errors.push({ path: '/url', message: 'must be an https URL or empty' });
  }
  if (input.url !== undefined && typeof input.url !== 'string') {
    errors.push({ path: '/url', message: 'must be a string' });
  }
  if (input.auto_update !== undefined && typeof input.auto_update !== 'boolean') {
    errors.push({ path: '/auto_update', message: 'must be boolean' });
  }
  if (input.interval_hours !== undefined && (!Number.isFinite(input.interval_hours) || input.interval_hours <= 0)) {
    errors.push({ path: '/interval_hours', message: 'must be a positive number' });
  }
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
      rule_sets: normalizeRulesets(partial.data_sources?.rule_sets),
    },
    dns: { ...base.dns, ...(partial.dns ?? {}) },
    rules: Array.isArray(partial.rules) ? partial.rules.map(normalizeRule) : [],
  };
}

function normalizeRulesets(rulesets) {
  if (!rulesets || typeof rulesets !== 'object' || Array.isArray(rulesets)) return {};
  const out = {};
  for (const [name, stream] of Object.entries(rulesets)) {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) continue;
    out[name] = {
      url: typeof stream.url === 'string' ? stream.url : '',
      sha256_url: typeof stream.sha256_url === 'string' ? stream.sha256_url : '',
      auto_update: stream.auto_update !== false,
      interval_hours: Number.isFinite(stream.interval_hours) ? stream.interval_hours : 24,
    };
  }
  return out;
}

function normalizeRule(rule) {
  const isolate = rule?.mode === 'isolate';
  const template = RULE_TEMPLATES[isolate ? 'isolate' : 'flow'];
  const result = structuredClone(template);
  if (!rule || typeof rule !== 'object') return result;
  if (typeof rule.name === 'string') result.name = rule.name;
  result.enabled = rule.enabled !== false;
  if (ACTIONS.has(rule.action)) result.action = rule.action;
  result.strip_referrer = rule.strip_referrer === true;
  if (isolate) {
    if (rule.match && typeof rule.match === 'object') result.match = structuredClone(rule.match);
  } else {
    result.bidirectional = rule.bidirectional === true;
    if (rule.source && typeof rule.source === 'object') result.source = structuredClone(rule.source);
    if (rule.destination && typeof rule.destination === 'object') result.destination = structuredClone(rule.destination);
  }
  return result;
}
