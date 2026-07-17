import { parseCidr, ipInCidr, ipToString } from '../lib/ip.js';

export const UNDECIDED = Symbol('undecided');

export const andK = (a, b) =>
  a === false || b === false ? false :
  a === true && b === true ? true :
  UNDECIDED;

export const orK = (a, b) =>
  a === true || b === true ? true :
  a === false && b === false ? false :
  UNDECIDED;

export const notK = a => a === UNDECIDED ? UNDECIDED : !a;

export const traceValue = v => v === UNDECIDED ? null : v;

const regexCache = new WeakMap();

function compileRegex(matcher) {
  if (regexCache.has(matcher)) return regexCache.get(matcher);
  let compiled;
  try { compiled = new RegExp(String(matcher.regex ?? '')); }
  catch { compiled = null; }
  regexCache.set(matcher, compiled);
  return compiled;
}

export function matches(matcher, ctx, geo, trace = null) {
  if (!matcher || typeof matcher !== 'object') {
    trace?.push({ type: 'invalid', hit: false });
    return false;
  }
  switch (matcher.type) {
    case 'any':
      trace?.push({ type: 'any', hit: true });
      return true;
    case 'geosite':
      return matchGeosite(matcher, ctx, geo, trace);
    case 'geoip':
      return matchGeoip(matcher, ctx, geo, trace);
    case 'rule-set':
      return matchRuleset(matcher, ctx, geo, trace);
    case 'domain':
      return matchDomain(matcher, ctx, trace);
    case 'url':
      return matchUrl(matcher, ctx, trace);
    case 'ip':
      return matchIp(matcher, ctx, trace);
    case 'and':
      return matchComposite('and', matcher.matches, ctx, geo, trace);
    case 'or':
      return matchComposite('or', matcher.matches, ctx, geo, trace);
    case 'not':
      return matchNot(matcher, ctx, geo, trace);
    default:
      trace?.push({ type: matcher.type, hit: false, note: 'unknown type' });
      return false;
  }
}

function matchGeosite(matcher, ctx, geo, trace) {
  const tag = String(matcher.tag ?? '').toLowerCase();
  const attr = matcher.attr ? String(matcher.attr).toLowerCase() : null;
  const host = ctx?.host ?? '';
  if (!tag) {
    trace?.push({ type: 'geosite', tag, attr, host, hit: false, note: 'empty tag' });
    return false;
  }
  if (!host) {
    trace?.push({ type: 'geosite', tag, attr, host, hit: null, note: 'empty host' });
    return UNDECIDED;
  }
  const raw = geo.inGeositeTag(host, tag, attr);
  if (raw === null) {
    trace?.push({ type: 'geosite', tag, attr, host, hit: null, note: 'geosite db not loaded' });
    return UNDECIDED;
  }
  trace?.push({ type: 'geosite', tag, attr, host, hit: raw });
  return raw;
}

function matchGeoip(matcher, ctx, geo, trace) {
  const tag = String(matcher.tag ?? '').toLowerCase();
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  if (!tag) {
    trace?.push({ type: 'geoip', tag, ips: ips.map(formatIp), hit: false, note: 'empty tag' });
    return false;
  }
  if (ips.length === 0) {
    trace?.push({ type: 'geoip', tag, ips: [], hit: null, note: 'no ip resolved' });
    return UNDECIDED;
  }
  const perIp = ips.map(ip => ({ ip: formatIp(ip), hit: geo.inGeoipTag(ip, tag) }));
  if (perIp.some(item => item.hit === null)) {
    trace?.push({ type: 'geoip', tag, ips: ips.map(formatIp), hit: null, note: 'geoip db not loaded' });
    return UNDECIDED;
  }
  const hit = perIp.some(item => item.hit);
  trace?.push({ type: 'geoip', tag, ips: ips.map(formatIp), hit, perIp });
  return hit;
}

function matchRuleset(matcher, ctx, geo, trace) {
  const tag = String(matcher.tag ?? '');
  const host = ctx?.host ?? '';
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  if (!tag) {
    trace?.push({ type: 'rule-set', tag, host, ips: ips.map(formatIp), hit: false, note: 'empty tag' });
    return false;
  }
  const raw = geo.inRuleset(tag, host, ips);
  if (raw === null) {
    trace?.push({ type: 'rule-set', tag, host, ips: ips.map(formatIp), hit: null, note: 'rule-set not loaded' });
    return UNDECIDED;
  }
  trace?.push({ type: 'rule-set', tag, host, ips: ips.map(formatIp), hit: raw });
  return raw;
}

function matchDomain(matcher, ctx, trace) {
  const host = ctx?.host ?? '';
  const compiled = compileRegex(matcher);
  if (!compiled) {
    trace?.push({ type: 'domain', regex: matcher.regex, host, hit: false, note: 'invalid regex' });
    return false;
  }
  if (!host) {
    trace?.push({ type: 'domain', regex: matcher.regex, host, hit: null, note: 'empty host' });
    return UNDECIDED;
  }
  const hit = compiled.test(host);
  trace?.push({ type: 'domain', regex: matcher.regex, host, hit });
  return hit;
}

function matchUrl(matcher, ctx, trace) {
  const url = ctx?.url ?? '';
  const compiled = compileRegex(matcher);
  if (!compiled) {
    trace?.push({ type: 'url', regex: matcher.regex, url, hit: false, note: 'invalid regex' });
    return false;
  }
  if (!url) {
    trace?.push({ type: 'url', regex: matcher.regex, url, hit: null, note: 'empty url' });
    return UNDECIDED;
  }
  const hit = compiled.test(url);
  trace?.push({ type: 'url', regex: matcher.regex, url, hit });
  return hit;
}

function matchIp(matcher, ctx, trace) {
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  const cidr = parseCidr(String(matcher.cidr ?? ''));
  if (!cidr) {
    trace?.push({ type: 'ip', cidr: matcher.cidr, ips: ips.map(formatIp), hit: false, note: 'invalid cidr' });
    return false;
  }
  if (ips.length === 0) {
    trace?.push({ type: 'ip', cidr: matcher.cidr, ips: [], hit: null, note: 'no ip resolved' });
    return UNDECIDED;
  }
  const hit = ips.some(ip => cidr.family === ip.family && ipInCidr(ip.bytes, cidr.bytes, cidr.prefix));
  trace?.push({ type: 'ip', cidr: matcher.cidr, ips: ips.map(formatIp), hit });
  return hit;
}

function matchComposite(type, children, ctx, geo, trace) {
  if (!Array.isArray(children) || children.length === 0) {
    trace?.push({ type, hit: false, note: 'empty matches' });
    return false;
  }
  const childTrace = trace ? [] : null;
  const combine = type === 'and' ? andK : orK;
  const shortCircuit = type === 'and' ? false : true;
  let hit = type === 'and' ? true : false;
  for (const child of children) {
    const childHit = matches(child, ctx, geo, childTrace);
    hit = combine(hit, childHit);
    if (hit === shortCircuit && !trace) break;
  }
  trace?.push({ type, hit: traceValue(hit), matches: childTrace });
  return hit;
}

function matchNot(matcher, ctx, geo, trace) {
  const childTrace = trace ? [] : null;
  const hit = notK(matches(matcher.match, ctx, geo, childTrace));
  trace?.push({ type: 'not', hit: traceValue(hit), match: childTrace?.[0] ?? null });
  return hit;
}

function formatIp(ip) {
  try { return ipToString(ip.family, ip.bytes); }
  catch { return null; }
}
