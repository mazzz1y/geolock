const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

export function parseIp(text) {
  if (typeof text !== 'string') return null;
  let trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const v6 = parseIpv6(trimmed.slice(1, -1));
    return v6 ? finishIpv6(v6) : null;
  }
  const v4 = parseIpv4(trimmed);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(trimmed);
  return v6 ? finishIpv6(v6) : null;
}

function finishIpv6(bytes) {
  let mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  for (let i = 0; mapped && i < 10; i += 1) {
    if (bytes[i] !== 0) mapped = false;
  }
  if (mapped) return { family: 4, bytes: bytes.slice(12) };
  return { family: 6, bytes };
}

function parseIpv4(text) {
  const match = IPV4_RE.exec(text);
  if (!match) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = match[i + 1];
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text) {
  const zoneAt = text.indexOf('%');
  let body = zoneAt === -1 ? text : text.slice(0, zoneAt);
  if (!body) return null;

  let embeddedV4 = null;
  const lastColon = body.lastIndexOf(':');
  if (lastColon !== -1 && body.indexOf('.', lastColon) !== -1) {
    embeddedV4 = parseIpv4(body.slice(lastColon + 1));
    if (!embeddedV4) return null;
    body = body.slice(0, lastColon + 1) + '0:0';
  }

  const doubleColon = body.indexOf('::');
  let head, tail;
  if (doubleColon === -1) {
    if (body.startsWith(':') || body.endsWith(':')) return null;
    head = body.split(':');
    if (head.length !== 8 || head.some(part => !part)) return null;
    tail = [];
  } else {
    if (body.indexOf('::', doubleColon + 1) !== -1) return null;
    const headStr = body.slice(0, doubleColon);
    const tailStr = body.slice(doubleColon + 2);
    if (tailStr.startsWith(':') || tailStr.endsWith(':')) return null;
    if (headStr.startsWith(':')) return null;
    head = headStr ? headStr.split(':') : [];
    tail = tailStr ? tailStr.split(':') : [];
    if (head.some(part => !part) || tail.some(part => !part)) return null;
  }

  const padding = 8 - head.length - tail.length;
  if (padding < 0) return null;
  const groups = [...head, ...new Array(padding).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const part = groups[i];
    if (!part || part.length > 4 || !HEX_RE.test(part)) return null;
    const value = parseInt(part, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }

  if (embeddedV4) bytes.set(embeddedV4, 12);
  return bytes;
}

export function parseCidr(text) {
  if (typeof text !== 'string') return null;
  const slash = text.indexOf('/');
  if (slash === -1) {
    const ip = parseIp(text);
    if (!ip) return null;
    return { family: ip.family, bytes: ip.bytes, prefix: ip.family === 4 ? 32 : 128 };
  }
  const ip = parseIp(text.slice(0, slash));
  if (!ip) return null;
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  let prefix = Number(prefixText);
  if (ip.family === 4 && text.includes(':') && prefix >= 96) prefix -= 96;
  const max = ip.family === 4 ? 32 : 128;
  if (prefix > max) return null;
  return { family: ip.family, bytes: ip.bytes, prefix };
}

export function ipInCidr(ipBytes, cidrBytes, prefix) {
  if (ipBytes.length !== cidrBytes.length) return false;
  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i += 1) {
    if (ipBytes[i] !== cidrBytes[i]) return false;
  }
  const remainder = prefix & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (cidrBytes[fullBytes] & mask);
}

export function ipToString(family, bytes) {
  if (family === 4) return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  const groups = new Array(8);
  for (let i = 0; i < 8; i += 1) {
    groups[i] = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16);
  }
  return collapseLongestZeroRun(groups);
}

function collapseLongestZeroRun(groups) {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (runLength === 0) runStart = i;
      runLength += 1;
      if (runLength > bestLength) { bestStart = runStart; bestLength = runLength; }
    } else {
      runLength = 0;
    }
  }
  if (bestLength < 2) return groups.join(':');
  return groups.slice(0, bestStart).join(':') + '::' + groups.slice(bestStart + bestLength).join(':');
}

export function getBit(bytes, index) {
  return (bytes[index >> 3] >> (7 - (index & 7))) & 1;
}
