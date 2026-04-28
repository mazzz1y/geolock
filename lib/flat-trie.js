import { getBit } from './ip.js';

const NODE_STRIDE = 3;
const NODE_TERMINAL = 2;

export class FlatIpRadixBuilder {
  constructor() {
    this.v4 = createTrieBuilder();
    this.v6 = createTrieBuilder();
  }

  add(family, bytes, prefix) {
    const trie = family === 4 ? this.v4 : this.v6;
    let idx = 0;
    for (let i = 0; i < prefix; i += 1) {
      const branch = getBit(bytes, i) === 0 ? 0 : 1;
      const slot = idx * NODE_STRIDE + branch;
      let next = trie.nodes[slot];
      if (next < 0) {
        next = trie.nodes.length / NODE_STRIDE;
        trie.nodes.push(-1, -1, 0);
        trie.nodes[slot] = next;
      }
      idx = next;
    }
    trie.nodes[idx * NODE_STRIDE + NODE_TERMINAL] = 1;
  }

  finish() {
    return new FlatIpRadix(finalizeTrie(this.v4), finalizeTrie(this.v6));
  }
}

function createTrieBuilder() {
  return { nodes: [-1, -1, 0] };
}

function finalizeTrie(builder) {
  return new Int32Array(builder.nodes);
}

class FlatIpTrie {
  constructor(nodes) {
    this.nodes = nodes;
  }

  contains(bytes, totalBits) {
    const nodes = this.nodes;
    if (nodes[NODE_TERMINAL]) return true;
    let idx = 0;
    for (let i = 0; i < totalBits; i += 1) {
      const branch = getBit(bytes, i) === 0 ? 0 : 1;
      const next = nodes[idx * NODE_STRIDE + branch];
      if (next < 0) return false;
      idx = next;
      if (nodes[idx * NODE_STRIDE + NODE_TERMINAL]) return true;
    }
    return false;
  }
}

export class FlatIpRadix {
  constructor(v4Nodes, v6Nodes) {
    this.v4 = new FlatIpTrie(v4Nodes);
    this.v6 = new FlatIpTrie(v6Nodes);
  }

  contains(family, bytes) {
    return (family === 4 ? this.v4 : this.v6).contains(bytes, family === 4 ? 32 : 128);
  }
}

export class FlatDomainSuffixTreeBuilder {
  constructor() {
    this.full = new Map();
    this.suffix = new Map();
    this.plain = [];
    this.regex = [];
  }

  addFull(host, entryId) {
    addToMap(this.full, host.toLowerCase(), entryId);
  }

  addSuffix(domain, entryId) {
    addToMap(this.suffix, domain.toLowerCase(), entryId);
  }

  addPlain(needle, entryId) {
    this.plain.push({ needle: needle.toLowerCase(), entryId });
  }

  addRegex(pattern, entryId) {
    this.regex.push({ pattern, entryId });
  }

  finish() {
    const fullEntries = encodeMap(this.full);
    const suffixEntries = encodeMap(this.suffix);
    return new FlatDomainSuffixTree(fullEntries, suffixEntries, this.plain, this.regex);
  }
}

function addToMap(map, key, entryId) {
  const existing = map.get(key);
  if (existing) existing.add(entryId);
  else map.set(key, new Set([entryId]));
}

function encodeMap(map) {
  const keys = [...map.keys()].sort();
  const entries = keys.map(key => ({ key, ids: [...map.get(key)] }));
  return entries;
}

export class FlatDomainSuffixTree {
  constructor(fullEntries, suffixEntries, plain, regex) {
    this.full = fullEntries;
    this.suffix = suffixEntries;
    this.plain = plain;
    this.regex = regex;
    this.regexCompiled = new Array(regex.length).fill(null);
  }

  lookup(host) {
    const target = host.toLowerCase();
    const matches = new Set();

    this.lookupExact(this.full, target, matches);

    let cursor = target;
    while (cursor) {
      this.lookupExact(this.suffix, cursor, matches);
      const dot = cursor.indexOf('.');
      if (dot === -1) break;
      cursor = cursor.slice(dot + 1);
    }

    for (const { needle, entryId } of this.plain) {
      if (target.includes(needle)) matches.add(entryId);
    }

    for (let i = 0; i < this.regex.length; i += 1) {
      let compiled = this.regexCompiled[i];
      if (compiled === null) {
        try { compiled = new RegExp(this.regex[i].pattern); }
        catch { compiled = false; }
        this.regexCompiled[i] = compiled;
      }
      if (compiled && compiled.test(target)) matches.add(this.regex[i].entryId);
    }

    return matches;
  }

  lookupExact(entries, target, matches) {
    const idx = binarySearch(entries, target);
    if (idx < 0) return;
    for (const id of entries[idx].ids) matches.add(id);
  }
}

function binarySearch(entries, target) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = entries[mid].key;
    if (candidate === target) return mid;
    if (candidate < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
