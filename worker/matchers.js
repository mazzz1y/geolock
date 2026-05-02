import { parseCidr, ipInCidr, ipToString } from '../lib/ip.js';

export const MATCHER_KINDS = ['any', 'geosite', 'geoip', 'domain', 'url', 'ip', 'all_of', 'any_of', 'not'];

// Tri-state sentinel for "cannot decide with current context data".
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
    trace?.push({ kind: 'invalid', hit: false });
    return false;
  }
  switch (matcher.kind) {
    case 'any':
      trace?.push({ kind: 'any', hit: true });
      return true;
    case 'geosite':
      return matchGeosite(matcher, ctx, geo, trace);
    case 'geoip':
      return matchGeoip(matcher, ctx, geo, trace);
    case 'domain':
      return matchDomain(matcher, ctx, trace);
    case 'url':
      return matchUrl(matcher, ctx, trace);
    case 'ip':
      return matchIp(matcher, ctx, trace);
    case 'all_of':
      return matchComposite('all_of', matcher.terms, ctx, geo, trace);
    case 'any_of':
      return matchComposite('any_of', matcher.terms, ctx, geo, trace);
    case 'not':
      return matchNot(matcher, ctx, geo, trace);
    default:
      trace?.push({ kind: matcher.kind, hit: false, note: 'unknown kind' });
      return false;
  }
}

function matchGeosite(matcher, ctx, geo, trace) {
  const tag = String(matcher.tag ?? '').toLowerCase();
  const attr = matcher.attr ? String(matcher.attr).toLowerCase() : null;
  const host = ctx?.host ?? '';
  if (!tag) {
    trace?.push({ kind: 'geosite', tag, attr, host, hit: false, note: 'empty tag' });
    return false;
  }
  if (!host) {
    trace?.push({ kind: 'geosite', tag, attr, host, hit: null, note: 'empty host' });
    return UNDECIDED;
  }
  const hit = geo.inGeositeTag(host, tag, attr);
  trace?.push({ kind: 'geosite', tag, attr, host, hit });
  return hit;
}

function matchGeoip(matcher, ctx, geo, trace) {
  const tag = String(matcher.tag ?? '').toLowerCase();
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  if (!tag) {
    trace?.push({ kind: 'geoip', tag, ips: ips.map(formatIp), hit: false, note: 'empty tag' });
    return false;
  }
  if (ips.length === 0) {
    trace?.push({ kind: 'geoip', tag, ips: [], hit: null, note: 'no ip resolved' });
    return UNDECIDED;
  }
  const perIp = ips.map(ip => ({ ip: formatIp(ip), hit: geo.inGeoipTag(ip, tag) }));
  const hit = perIp.some(item => item.hit);
  trace?.push({ kind: 'geoip', tag, ips: ips.map(formatIp), hit, perIp });
  return hit;
}

function matchDomain(matcher, ctx, trace) {
  const host = ctx?.host ?? '';
  const compiled = compileRegex(matcher);
  if (!compiled) {
    trace?.push({ kind: 'domain', regex: matcher.regex, host, hit: false, note: 'invalid regex' });
    return false;
  }
  if (!host) {
    trace?.push({ kind: 'domain', regex: matcher.regex, host, hit: null, note: 'empty host' });
    return UNDECIDED;
  }
  const hit = compiled.test(host);
  trace?.push({ kind: 'domain', regex: matcher.regex, host, hit });
  return hit;
}

function matchUrl(matcher, ctx, trace) {
  const url = ctx?.url ?? '';
  const compiled = compileRegex(matcher);
  if (!compiled) {
    trace?.push({ kind: 'url', regex: matcher.regex, url, hit: false, note: 'invalid regex' });
    return false;
  }
  if (!url) {
    trace?.push({ kind: 'url', regex: matcher.regex, url, hit: null, note: 'empty url' });
    return UNDECIDED;
  }
  const hit = compiled.test(url);
  trace?.push({ kind: 'url', regex: matcher.regex, url, hit });
  return hit;
}

function matchIp(matcher, ctx, trace) {
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  const cidr = parseCidr(String(matcher.cidr ?? ''));
  if (!cidr) {
    trace?.push({ kind: 'ip', cidr: matcher.cidr, ips: ips.map(formatIp), hit: false, note: 'invalid cidr' });
    return false;
  }
  if (ips.length === 0) {
    trace?.push({ kind: 'ip', cidr: matcher.cidr, ips: [], hit: null, note: 'no ip resolved' });
    return UNDECIDED;
  }
  const hit = ips.some(ip => cidr.family === ip.family && ipInCidr(ip.bytes, cidr.bytes, cidr.prefix));
  trace?.push({ kind: 'ip', cidr: matcher.cidr, ips: ips.map(formatIp), hit });
  return hit;
}

function matchComposite(kind, terms, ctx, geo, trace) {
  if (!Array.isArray(terms) || terms.length === 0) {
    trace?.push({ kind, hit: false, note: 'empty terms' });
    return false;
  }
  const childTrace = trace ? [] : null;
  const combine = kind === 'all_of' ? andK : orK;
  const shortCircuit = kind === 'all_of' ? false : true;
  let hit = kind === 'all_of' ? true : false;
  for (const term of terms) {
    const termHit = matches(term, ctx, geo, childTrace);
    hit = combine(hit, termHit);
    if (hit === shortCircuit && !trace) break;
  }
  trace?.push({ kind, hit: traceValue(hit), terms: childTrace });
  return hit;
}

function matchNot(matcher, ctx, geo, trace) {
  const childTrace = trace ? [] : null;
  const hit = notK(matches(matcher.term, ctx, geo, childTrace));
  trace?.push({ kind: 'not', hit: traceValue(hit), term: childTrace?.[0] ?? null });
  return hit;
}

function formatIp(ip) {
  try { return ipToString(ip.family, ip.bytes); }
  catch { return null; }
}
