import { parseCidr, ipInCidr, ipToString } from '../lib/ip.js';

export const MATCHER_KINDS = ['any', 'geosite', 'geoip', 'domain', 'url', 'ip', 'all_of', 'any_of', 'not'];

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
  if (!host || !tag) {
    trace?.push({ kind: 'geosite', tag, attr, host, hit: false, note: !host ? 'empty host' : 'empty tag' });
    return false;
  }
  const hit = geo.inGeositeTag(host, tag, attr);
  trace?.push({ kind: 'geosite', tag, attr, host, hit });
  return hit;
}

function matchGeoip(matcher, ctx, geo, trace) {
  const tag = String(matcher.tag ?? '').toLowerCase();
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  if (ips.length === 0 || !tag) {
    trace?.push({ kind: 'geoip', tag, ips: [], hit: false, note: ips.length === 0 ? 'no ip resolved' : 'empty tag' });
    return false;
  }
  const perIp = ips.map(ip => ({ ip: formatIp(ip), hit: geo.inGeoipTag(ip, tag) }));
  const hit = perIp.some(item => item.hit);
  trace?.push({ kind: 'geoip', tag, ips: ips.map(formatIp), hit, perIp });
  return hit;
}

function matchDomain(matcher, ctx, trace) {
  const host = ctx?.host ?? '';
  const compiled = compileRegex(matcher);
  if (!host || !compiled) {
    trace?.push({ kind: 'domain', regex: matcher.regex, host, hit: false, note: !host ? 'empty host' : 'invalid regex' });
    return false;
  }
  const hit = compiled.test(host);
  trace?.push({ kind: 'domain', regex: matcher.regex, host, hit });
  return hit;
}

function matchUrl(matcher, ctx, trace) {
  const url = ctx?.url ?? '';
  const compiled = compileRegex(matcher);
  if (!url || !compiled) {
    trace?.push({ kind: 'url', regex: matcher.regex, url, hit: false, note: !url ? 'empty url' : 'invalid regex' });
    return false;
  }
  const hit = compiled.test(url);
  trace?.push({ kind: 'url', regex: matcher.regex, url, hit });
  return hit;
}

function matchIp(matcher, ctx, trace) {
  const ips = Array.isArray(ctx?.ips) ? ctx.ips.filter(ip => ip?.bytes) : [];
  const cidr = parseCidr(String(matcher.cidr ?? ''));
  if (ips.length === 0 || !cidr) {
    trace?.push({ kind: 'ip', cidr: matcher.cidr, ips: ips.map(formatIp), hit: false, note: ips.length === 0 ? 'no ip resolved' : 'invalid cidr' });
    return false;
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
  const requireAll = kind === 'all_of';
  let hit = requireAll;
  for (const term of terms) {
    const termHit = matches(term, ctx, geo, childTrace);
    if (requireAll && !termHit) { hit = false; if (!trace) break; }
    if (!requireAll && termHit) { hit = true; if (!trace) break; }
  }
  trace?.push({ kind, hit, terms: childTrace });
  return hit;
}

function matchNot(matcher, ctx, geo, trace) {
  const childTrace = trace ? [] : null;
  const hit = !matches(matcher.term, ctx, geo, childTrace);
  trace?.push({ kind: 'not', hit, term: childTrace?.[0] ?? null });
  return hit;
}

function formatIp(ip) {
  try { return ipToString(ip.family, ip.bytes); }
  catch { return null; }
}
