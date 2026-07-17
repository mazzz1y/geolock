export function formatIps(ips) {
  return Array.isArray(ips) && ips.length ? ips.join(', ') : 'unresolved';
}

export function formatHit(value) {
  if (value === undefined) return '—';
  if (value === null) return 'n/a';
  return value ? 'HIT' : 'miss';
}

export function formatMatcherTrace(node, indent) {
  if (!node) return [];
  const pad = ' '.repeat(indent);
  const lines = [`${pad}${describeTraceNode(node)}`];
  const children = node.matches ?? (node.match ? [node.match] : []);
  for (const child of children) {
    if (child) lines.push(...formatMatcherTrace(child, indent + 2));
  }
  return lines;
}

function describeTraceNode(node) {
  const verdict = node.hit === null ? '[?]' : node.hit ? '[+]' : '[-]';
  const note = node.note ? ` (${node.note})` : '';
  switch (node.type) {
    case 'any': return `${verdict} any`;
    case 'geosite': return `${verdict} geosite:${node.tag || '?'}${node.attr ? '@' + node.attr : ''} host=${node.host || '?'}${note}`;
    case 'geoip':   return `${verdict} geoip:${node.tag || '?'} ips=${formatIps(node.ips)}${note}`;
    case 'rule-set': return `${verdict} rule-set:${node.tag || '?'} host=${node.host || '?'} ips=${formatIps(node.ips)}${note}`;
    case 'domain':  return `${verdict} domain:/${node.regex}/ host=${node.host || '?'}${note}`;
    case 'ip':      return `${verdict} ip:${node.cidr} ips=${formatIps(node.ips)}${note}`;
    case 'url':     return `${verdict} url:/${node.regex}/ url=${node.url || '?'}${note}`;
    case 'and':  return `${verdict} AND${note}`;
    case 'or':  return `${verdict} OR${note}`;
    case 'not':     return `${verdict} NOT${note}`;
    default:        return `${verdict} ${node.type}${note}`;
  }
}
