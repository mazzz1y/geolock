export const MATCHER_TEMPLATES = {
  any:     { type: 'any' },
  geosite: { type: 'geosite', tag: '', attr: '' },
  geoip:   { type: 'geoip', tag: '' },
  domain:  { type: 'domain', regex: '' },
  url:     { type: 'url', regex: '' },
  ip:      { type: 'ip', cidr: '' },
  and:     { type: 'and', matches: [] },
  or:      { type: 'or', matches: [] },
  not:     { type: 'not', match: { type: 'any' } },
};

export const RULE_TEMPLATES = {
  flow: {
    name: '',
    enabled: true,
    action: 'block',
    strip_referrer: false,
    bidirectional: false,
    source: { type: 'any' },
    destination: { type: 'any' },
  },
  isolate: {
    name: '',
    enabled: true,
    action: 'block',
    strip_referrer: false,
    mode: 'isolate',
    match: { type: 'any' },
  },
};

export const CONFIG_TEMPLATE = {
  version: 2,
  default_action: 'allow',
  data_sources: {
    geoip:   { url: '', auto_update: true, interval_hours: 24, sha256_url: '' },
    geosite: { url: '', auto_update: true, interval_hours: 24, sha256_url: '' },
  },
  dns: { cache_ttl_seconds: 300, negative_cache_ttl_seconds: 30, timeout_ms: 1500, match_strategy: 'first' },
  rules: [],
};
