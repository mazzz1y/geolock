import { FlatDomainSuffixTreeBuilder } from '../lib/flat-trie.js';

const builder = new FlatDomainSuffixTreeBuilder();
let id = 0;
for (let i = 0; i < 5000; i += 1) builder.addPlain(`needle-${i}.part`, id++);
for (let i = 0; i < 2000; i += 1) builder.addSuffix(`suffix-${i}.example.com`, id++);
for (let i = 0; i < 50; i += 1) builder.addRegex(`^rx-${i}\\..*\\.example$`, id++);
const tree = builder.finish();

const hosts = [];
for (let i = 0; i < 100; i += 1) {
  hosts.push(`www.host-${i}.nomatch.org`);
  hosts.push(`a.b.suffix-${i * 17 % 2000}.example.com`);
  hosts.push(`x.needle-${i * 31 % 5000}.part.example`);
}

function bench(label, fn) {
  fn(hosts[0]);
  const iterations = 20000;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(hosts[i % hosts.length]);
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round(iterations / (elapsed / 1000));
  console.log(`${label}: ${elapsed.toFixed(1)}ms for ${iterations} calls => ${opsPerSec.toLocaleString('en-US')} ops/sec`);
}

bench('lookup()    ', host => tree.lookup(host).size > 0);
bench('matchesAny()', host => tree.matchesAny(host));
