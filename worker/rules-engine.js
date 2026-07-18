import { matches, andK, orK, traceValue } from './matchers.js';
import { ipToString } from '../lib/ip.js';
import { desugarRule } from './rule-shape.js';

export async function evaluate(config, contexts, geo, deps = {}, { trace: collectTrace = false } = {}) {
  const trace = collectTrace ? [] : null;
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  let resolveSource = deps.resolveSource ?? null;
  let resolveDestination = deps.resolveDestination ?? null;
  const ensureRuleset = deps.ensureRuleset ?? null;
  const ensuredRulesets = ensureRuleset ? new Set() : null;

  for (let index = 0; index < rules.length; index++) {
    const raw = rules[index];
    if (!raw || raw.enabled === false) continue;
    const rule = desugarRule(raw);

    if (ensureRuleset) {
      const tags = new Set();
      collectRulesetTags(rule.source, tags);
      collectRulesetTags(rule.destination, tags);
      for (const tag of tags) {
        if (ensuredRulesets.has(tag)) continue;
        ensuredRulesets.add(tag);
        try { await ensureRuleset(tag); } catch { /* ... */ }
      }
    }

    const isBi = rule.bidirectional === true;
    const sourceNeedsIp = matcherNeedsIp(rule.source) || (isBi && matcherNeedsIp(rule.destination));
    const destinationNeedsIp = matcherNeedsIp(rule.destination) || (isBi && matcherNeedsIp(rule.source));

    if (resolveSource && sourceNeedsIp) {
      await resolveSource(contexts.source);
      resolveSource = null;
    }
    if (resolveDestination && destinationNeedsIp) {
      await resolveDestination(contexts.destination);
      resolveDestination = null;
    }

    const sourceSubtrace = trace ? [] : null;
    const sourceHit = matches(rule.source, contexts.source, geo, sourceSubtrace);

    if (sourceHit === true && resolveDestination && matcherNeedsIp(rule.destination)) {
      await resolveDestination(contexts.destination);
      resolveDestination = null;
    }

    const destinationSubtrace = trace && sourceHit === true ? [] : null;
    const destinationHit = sourceHit === true ? matches(rule.destination, contexts.destination, geo, destinationSubtrace) : sourceHit;

    const forward = andK(sourceHit, destinationHit);
    let direction = forward === true ? (isBi ? 'forward' : null) : null;

    let reverseSourceHit = null;
    let reverseDestinationHit = null;
    let reverseSourceTrace = null;
    let reverseDestinationTrace = null;
    let reverse = false;
    if (forward !== true && isBi) {
      const revSourceSub = trace ? [] : null;
      const revDestinationSub = trace ? [] : null;
      reverseSourceHit = matches(rule.destination, contexts.source, geo, revSourceSub);
      reverseDestinationHit = reverseSourceHit === true
        ? matches(rule.source, contexts.destination, geo, revDestinationSub)
        : reverseSourceHit;
      reverseSourceTrace = revSourceSub?.[0] ?? null;
      reverseDestinationTrace = reverseSourceHit === true ? (revDestinationSub?.[0] ?? null) : null;
      reverse = andK(reverseSourceHit, reverseDestinationHit);
      if (reverse === true) direction = 'reverse';
    }

    const result = orK(forward, reverse);

    trace?.push({
      ruleIndex: index,
      ruleName: rule.name ?? '',
      action: rule.action,
      bidirectional: isBi,
      sourceHit: traceValue(sourceHit),
      destinationHit: sourceHit === true ? traceValue(destinationHit) : null,
      sourceTrace: sourceSubtrace?.[0] ?? null,
      destinationTrace: destinationSubtrace?.[0] ?? null,
      reverseSourceHit: isBi ? traceValue(reverseSourceHit) : null,
      reverseDestinationHit: isBi ? (reverseSourceHit === true ? traceValue(reverseDestinationHit) : null) : null,
      reverseSourceTrace,
      reverseDestinationTrace,
      direction,
    });

    if (result === true) {
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

function collectRulesetTags(m, out) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'rule-set') {
    const tag = String(m.tag ?? '').toLowerCase();
    if (tag) out.add(tag);
    return;
  }
  if (m.type === 'and' || m.type === 'or') {
    if (Array.isArray(m.matches)) for (const child of m.matches) collectRulesetTags(child, out);
    return;
  }
  if (m.type === 'not') collectRulesetTags(m.match, out);
}

function matcherNeedsIp(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'geoip' || m.type === 'ip' || m.type === 'rule-set') return true;
  if (m.type === 'and' || m.type === 'or') {
    return Array.isArray(m.matches) && m.matches.some(matcherNeedsIp);
  }
  if (m.type === 'not') return matcherNeedsIp(m.match);
  return false;
}

function summarizeContexts(contexts) {
  return {
    source: summarizeContext(contexts?.source),
    destination: summarizeContext(contexts?.destination),
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
