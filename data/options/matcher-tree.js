const LEAF_FIELDS = {
  any: () => ({}),
  geosite: input => {
    const node = { tag: typeof input.tag === 'string' ? input.tag : '' };
    if (input.attr) node.attr = String(input.attr);
    return node;
  },
  geoip: input => ({ tag: typeof input.tag === 'string' ? input.tag : '' }),
  domain: input => ({ regex: typeof input.regex === 'string' ? input.regex : '' }),
  url: input => ({ regex: typeof input.regex === 'string' ? input.regex : '' }),
  ip: input => ({ cidr: typeof input.cidr === 'string' ? input.cidr : '' }),
};

export const TYPE_LABELS = {
  any: 'any',
  geosite: 'geosite',
  geoip: 'geoip',
  domain: 'domain',
  url: 'url',
  ip: 'ip',
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  __advanced__: 'raw',
};

export const ALL_TYPES = Object.keys(TYPE_LABELS);

export function normalizeMatcher(input) {
  if (!input || typeof input !== 'object') return { type: 'any', children: [] };
  const { type } = input;
  if (type === 'and' || type === 'or') {
    const children = Array.isArray(input.matches) ? input.matches : [];
    return { type, children: children.map(normalizeMatcher) };
  }
  if (type === 'not') {
    return { type: 'not', children: [normalizeMatcher(input.match ?? { type: 'any' })] };
  }
  if (type === '__advanced__') {
    return { type, json: typeof input.json === 'string' ? input.json : '{}', children: [] };
  }
  if (LEAF_FIELDS[type]) {
    return { type, children: [], ...LEAF_FIELDS[type](input) };
  }
  return { type: 'any', children: [] };
}

export function serializeMatcher(node) {
  if (!node || typeof node !== 'object') return { type: 'any' };
  switch (node.type) {
    case 'any':
      return { type: 'any' };
    case 'geosite': {
      const out = { type: 'geosite', tag: String(node.tag ?? '') };
      if (node.attr) out.attr = String(node.attr);
      return out;
    }
    case 'geoip':
      return { type: 'geoip', tag: String(node.tag ?? '') };
    case 'domain':
      return { type: 'domain', regex: String(node.regex ?? '') };
    case 'url':
      return { type: 'url', regex: String(node.regex ?? '') };
    case 'ip':
      return { type: 'ip', cidr: String(node.cidr ?? '') };
    case 'and':
    case 'or':
      return { type: node.type, matches: (node.children ?? []).map(serializeMatcher) };
    case 'not':
      return { type: 'not', match: serializeMatcher((node.children ?? [])[0] ?? { type: 'any' }) };
    case '__advanced__':
      try { return JSON.parse(node.json ?? '{}'); }
      catch { return { type: 'any' }; }
    default:
      return { type: 'any' };
  }
}

export function convertType(node, newType) {
  if (!node) return normalizeMatcher({ type: newType });
  if (node.type === newType) return node;

  if (newType === '__advanced__') {
    return { type: '__advanced__', json: JSON.stringify(serializeMatcher(node), null, 2), children: [] };
  }

  if (node.type === '__advanced__') {
    let parsed;
    try { parsed = JSON.parse(node.json ?? ''); }
    catch { return normalizeMatcher({ type: newType }); }
    const normalized = normalizeMatcher(parsed);
    return normalized.type === newType ? normalized : convertType(normalized, newType);
  }

  if (newType === 'and' || newType === 'or') {
    if (node.type === 'and' || node.type === 'or') {
      return { type: newType, children: node.children ?? [] };
    }
    return { type: newType, children: [cloneNode(node)] };
  }

  if (newType === 'not') {
    return node.type === 'not' ? node : { type: 'not', children: [cloneNode(node)] };
  }

  return normalizeMatcher({ type: newType });
}

function cloneNode(node) {
  return normalizeMatcher(serializeMatcher(node));
}
