const memo = new WeakMap();

export function desugarRule(rule) {
  if (!rule || rule.mode !== 'isolate') return rule;
  const cached = memo.get(rule);
  if (cached) return cached;
  const result = doDesugarIsolate(rule);
  memo.set(rule, result);
  return result;
}

function doDesugarIsolate(rule) {
  const match = rule.match ?? { type: 'any' };
  return {
    name: rule.name ?? '',
    enabled: rule.enabled !== false,
    action: rule.action,
    strip_referrer: rule.strip_referrer === true,
    bidirectional: true,
    source: structuredClone(match),
    destination: { type: 'not', match: structuredClone(match) },
  };
}
