const LEAF_FIELDS = {
  any: () => ({}),
  geosite: input => {
    const node = { tag: typeof input.tag === 'string' ? input.tag : '' };
    if (input.attr) node.attr = String(input.attr);
    return node;
  },
  geoip: input => ({ tag: typeof input.tag === 'string' ? input.tag : '' }),
  domain: input => ({ regex: typeof input.regex === 'string' ? input.regex : '' }),
  ip: input => ({ cidr: typeof input.cidr === 'string' ? input.cidr : '' }),
};

export const KIND_LABELS = {
  any: 'any',
  geosite: 'geosite',
  geoip: 'geoip',
  domain: 'domain',
  ip: 'ip',
  all_of: 'AND',
  any_of: 'OR',
  not: 'NOT',
  __advanced__: 'raw',
};

export const ALL_KINDS = Object.keys(KIND_LABELS);

export function normalizeMatcher(input) {
  if (!input || typeof input !== 'object') return { kind: 'any', children: [] };
  const { kind } = input;
  if (kind === 'all_of' || kind === 'any_of') {
    const terms = Array.isArray(input.terms) ? input.terms : [];
    return { kind, children: terms.map(normalizeMatcher) };
  }
  if (kind === 'not') {
    return { kind: 'not', children: [normalizeMatcher(input.term ?? { kind: 'any' })] };
  }
  if (kind === '__advanced__') {
    return { kind, json: typeof input.json === 'string' ? input.json : '{}', children: [] };
  }
  if (LEAF_FIELDS[kind]) {
    return { kind, children: [], ...LEAF_FIELDS[kind](input) };
  }
  return { kind: 'any', children: [] };
}

export function serializeMatcher(node) {
  if (!node || typeof node !== 'object') return { kind: 'any' };
  switch (node.kind) {
    case 'any':
      return { kind: 'any' };
    case 'geosite': {
      const out = { kind: 'geosite', tag: String(node.tag ?? '') };
      if (node.attr) out.attr = String(node.attr);
      return out;
    }
    case 'geoip':
      return { kind: 'geoip', tag: String(node.tag ?? '') };
    case 'domain':
      return { kind: 'domain', regex: String(node.regex ?? '') };
    case 'ip':
      return { kind: 'ip', cidr: String(node.cidr ?? '') };
    case 'all_of':
    case 'any_of':
      return { kind: node.kind, terms: (node.children ?? []).map(serializeMatcher) };
    case 'not':
      return { kind: 'not', term: serializeMatcher((node.children ?? [])[0] ?? { kind: 'any' }) };
    case '__advanced__':
      try { return JSON.parse(node.json ?? '{}'); }
      catch { return { kind: 'any' }; }
    default:
      return { kind: 'any' };
  }
}

export function convertKind(node, newKind) {
  if (!node) return normalizeMatcher({ kind: newKind });
  if (node.kind === newKind) return node;

  if (newKind === '__advanced__') {
    return { kind: '__advanced__', json: JSON.stringify(serializeMatcher(node), null, 2), children: [] };
  }

  if (node.kind === '__advanced__') {
    let parsed;
    try { parsed = JSON.parse(node.json ?? ''); }
    catch { return normalizeMatcher({ kind: newKind }); }
    const normalized = normalizeMatcher(parsed);
    return normalized.kind === newKind ? normalized : convertKind(normalized, newKind);
  }

  if (newKind === 'all_of' || newKind === 'any_of') {
    if (node.kind === 'all_of' || node.kind === 'any_of') {
      return { kind: newKind, children: node.children ?? [] };
    }
    return { kind: newKind, children: [cloneNode(node)] };
  }

  if (newKind === 'not') {
    return node.kind === 'not' ? node : { kind: 'not', children: [cloneNode(node)] };
  }

  return normalizeMatcher({ kind: newKind });
}

function cloneNode(node) {
  return normalizeMatcher(serializeMatcher(node));
}
