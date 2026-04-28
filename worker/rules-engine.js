import { matches } from './matchers.js';
import { ipToString } from '../lib/ip.js';

export async function evaluate(config, contexts, geo, deps = {}, { trace: collectTrace = false } = {}) {
  const trace = collectTrace ? [] : null;
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  let resolveWebsite = deps.resolveWebsite ?? null;
  let resolveResource = deps.resolveResource ?? null;

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    if (!rule || rule.enabled === false) continue;

    const isBi = rule.bidirectional === true;
    const websiteNeedsIp = matcherNeedsIp(rule.website) || (isBi && matcherNeedsIp(rule.resource));
    const resourceNeedsIp = matcherNeedsIp(rule.resource) || (isBi && matcherNeedsIp(rule.website));

    if (resolveWebsite && websiteNeedsIp) {
      await resolveWebsite(contexts.website);
      resolveWebsite = null;
    }
    if (resolveResource && resourceNeedsIp) {
      await resolveResource(contexts.resource);
      resolveResource = null;
    }

    const websiteSubtrace = trace ? [] : null;
    const websiteHit = matches(rule.website, contexts.website, geo, websiteSubtrace);

    if (websiteHit && resolveResource && matcherNeedsIp(rule.resource)) {
      await resolveResource(contexts.resource);
      resolveResource = null;
    }

    const resourceSubtrace = trace && websiteHit ? [] : null;
    const resourceHit = websiteHit && matches(rule.resource, contexts.resource, geo, resourceSubtrace);

    let direction = null;
    let matched = websiteHit && resourceHit;
    if (matched) direction = isBi ? 'forward' : null;

    let reverseWebsiteHit = null;
    let reverseResourceHit = null;
    let reverseWebsiteTrace = null;
    let reverseResourceTrace = null;
    if (!matched && isBi) {
      const revWebsiteSub = trace ? [] : null;
      const revResourceSub = trace ? [] : null;
      reverseWebsiteHit = matches(rule.resource, contexts.website, geo, revWebsiteSub);
      reverseResourceHit = reverseWebsiteHit && matches(rule.website, contexts.resource, geo, revResourceSub);
      reverseWebsiteTrace = revWebsiteSub?.[0] ?? null;
      reverseResourceTrace = reverseWebsiteHit ? (revResourceSub?.[0] ?? null) : null;
      if (reverseWebsiteHit && reverseResourceHit) {
        matched = true;
        direction = 'reverse';
      }
    }

    trace?.push({
      ruleIndex: index,
      ruleName: rule.name ?? '',
      action: rule.action,
      bidirectional: isBi,
      websiteHit,
      resourceHit: websiteHit ? resourceHit : null,
      websiteTrace: websiteSubtrace?.[0] ?? null,
      resourceTrace: resourceSubtrace?.[0] ?? null,
      reverseWebsiteHit: isBi ? reverseWebsiteHit : null,
      reverseResourceHit: isBi ? (reverseWebsiteHit ? reverseResourceHit : null) : null,
      reverseWebsiteTrace,
      reverseResourceTrace,
      direction,
    });

    if (matched) {
      const matchedRule = { index, name: rule.name ?? '' };
      if (direction) matchedRule.direction = direction;
      return {
        verdict: rule.action === 'block' ? 'block' : 'allow',
        matchedRule,
        trace,
        contexts: summarizeContexts(contexts),
      };
    }
  }

  return {
    verdict: config?.default_action === 'block' ? 'block' : 'allow',
    matchedRule: null,
    trace,
    contexts: summarizeContexts(contexts),
  };
}

function matcherNeedsIp(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.kind === 'geoip' || m.kind === 'ip') return true;
  if (m.kind === 'all_of' || m.kind === 'any_of') {
    return Array.isArray(m.terms) && m.terms.some(matcherNeedsIp);
  }
  if (m.kind === 'not') return matcherNeedsIp(m.term);
  return false;
}

function summarizeContexts(contexts) {
  return {
    website: summarizeContext(contexts?.website),
    resource: summarizeContext(contexts?.resource),
  };
}

function summarizeContext(ctx) {
  if (!ctx) return null;
  const ips = Array.isArray(ctx.ips) ? ctx.ips : [];
  return {
    host: ctx.host ?? null,
    url: ctx.url ?? null,
    ips: ips.filter(ip => ip?.bytes).map(ip => ipToString(ip.family, ip.bytes)),
  };
}
