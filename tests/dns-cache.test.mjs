import assert from 'node:assert/strict';
import { createDnsCache } from '../worker/dns-cache.js';

function fakeClock(start = 0) {
  let t = start;
  const timers = [];
  let nextId = 1;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      const due = timers.filter(timer => !timer.cancelled && timer.fireAt <= t);
      due.forEach(timer => { timer.cancelled = true; timer.fn(); });
    },
    setTimer(fn, ms) {
      const timer = { id: nextId++, fn, fireAt: t + ms, cancelled: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimer(id) {
      const timer = timers.find(t => t.id === id);
      if (timer) timer.cancelled = true;
    },
  };
}

function makeResolver(map) {
  let calls = 0;
  const resolver = async host => {
    calls += 1;
    const value = map[host];
    if (value === 'throw') throw new Error('boom');
    if (value === 'never') return new Promise(() => {});
    return { addresses: value ?? [] };
  };
  Object.defineProperty(resolver, 'calls', { get: () => calls });
  return resolver;
}

export const tests = [
  {
    name: 'lookup: miss calls resolver and caches',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
      const ips = await cache.lookup('a.test');
      assert.equal(ips.length, 1);
      assert.equal(ips[0].family, 4);
      assert.equal(resolver.calls, 1);
    },
  },
  {
    name: 'lookup: hit within TTL skips resolver',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ttlMs: 60_000 });
      await cache.lookup('a.test');
      clock.advance(30_000);
      await cache.lookup('a.test');
      assert.equal(resolver.calls, 1);
    },
  },
  {
    name: 'lookup: expired entry re-resolves',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ttlMs: 60_000 });
      await cache.lookup('a.test');
      clock.advance(60_001);
      await cache.lookup('a.test');
      assert.equal(resolver.calls, 2);
    },
  },
  {
    name: 'lookup: concurrent calls dedupe',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
      const [a, b] = await Promise.all([cache.lookup('a.test'), cache.lookup('a.test')]);
      assert.equal(resolver.calls, 1);
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
    },
  },
  {
    name: 'lookup: failure cached as negative',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'bad.test': 'throw' });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, negativeTtlMs: 10_000 });
      const ips = await cache.lookup('bad.test');
      assert.deepEqual(ips, []);
      clock.advance(5_000);
      await cache.lookup('bad.test');
      assert.equal(resolver.calls, 1);
    },
  },
  {
    name: 'lookup: timeout returns empty array',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'slow.test': 'never' });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 100 });
      const promise = cache.lookup('slow.test');
      clock.advance(101);
      const ips = await promise;
      assert.deepEqual(ips, []);
      assert.equal(cache._stats().timeouts, 1);
    },
  },
  {
    name: 'lookup: timeout is not negative-cached',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'slow.test': 'never' });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 100, negativeTtlMs: 30_000 });
      const first = cache.lookup('slow.test');
      clock.advance(101);
      assert.deepEqual(await first, []);
      const second = cache.lookup('slow.test');
      clock.advance(101);
      assert.deepEqual(await second, []);
      assert.equal(resolver.calls, 2, 'timeout must not be cached for negative TTL');
    },
  },
  {
    name: 'lookup: late resolution after timeout populates cache',
    run: async () => {
      const clock = fakeClock();
      let release;
      const resolver = async () => new Promise(r => { release = r; });
      let calls = 0;
      const counting = host => { calls += 1; return resolver(host); };
      const cache = createDnsCache({ resolver: counting, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 100, ttlMs: 60_000 });
      const first = cache.lookup('late.test');
      clock.advance(101);
      assert.deepEqual(await first, []);
      release({ addresses: ['1.2.3.4'] });
      await new Promise(r => setTimeout(r, 0));
      const second = await cache.lookup('late.test');
      assert.equal(calls, 1, 'late result must be served from cache');
      assert.equal(second.length, 1);
      assert.equal(second[0].family, 4);
    },
  },
  {
    name: 'lookup: late resolution after clearCache is discarded',
    run: async () => {
      const clock = fakeClock();
      let release;
      const resolver = async () => new Promise(r => { release = r; });
      let calls = 0;
      const counting = host => { calls += 1; return resolver(host); };
      const cache = createDnsCache({ resolver: counting, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 100, ttlMs: 60_000 });
      const first = cache.lookup('gen.test');
      clock.advance(101);
      assert.deepEqual(await first, []);
      cache.clearCache();
      release({ addresses: ['1.2.3.4'] });
      await new Promise(r => setTimeout(r, 0));
      assert.equal(cache._stats().size, 0, 'late result after clearCache must not repopulate cache');
      const second = cache.lookup('gen.test');
      clock.advance(101);
      assert.deepEqual(await second, []);
      assert.equal(calls, 2, 'second lookup must hit the resolver');
    },
  },
  {
    name: 'lookup: late rejection after timeout does not poison cache',
    run: async () => {
      const clock = fakeClock();
      let reject;
      const resolver = async () => new Promise((_, r) => { reject = r; });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 100 });
      const first = cache.lookup('fail.test');
      clock.advance(101);
      assert.deepEqual(await first, []);
      reject(new Error('boom'));
      await new Promise(r => setTimeout(r, 0));
      assert.equal(cache._stats().size, 0);
    },
  },
  {
    name: 'lookup: LRU eviction at maxEntries',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ a: ['1.1.1.1'], b: ['2.2.2.2'], c: ['3.3.3.3'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxEntries: 2 });
      await cache.lookup('a');
      await cache.lookup('b');
      await cache.lookup('c');
      assert.equal(cache._stats().size, 2);
      await cache.lookup('a');
      assert.equal(resolver.calls, 4);
    },
  },
  {
    name: 'clearCache empties everything',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
      await cache.lookup('a.test');
      cache.clearCache();
      assert.equal(cache._stats().size, 0);
      await cache.lookup('a.test');
      assert.equal(resolver.calls, 2);
    },
  },
  {
    name: 'setOptions affects subsequent inserts',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'], 'b.test': ['2.2.2.2'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ttlMs: 60_000 });
      await cache.lookup('a.test');
      cache.setOptions({ ttlMs: 1000 });
      await cache.lookup('b.test');
      clock.advance(2000);
      await cache.lookup('a.test');
      await cache.lookup('b.test');
      assert.equal(resolver.calls, 3);
    },
  },
  {
    name: 'ttlMs=0 disables positive caching',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'a.test': ['1.1.1.1'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ttlMs: 0 });
      await cache.lookup('a.test');
      await cache.lookup('a.test');
      assert.equal(resolver.calls, 2);
    },
  },
  {
    name: 'lookup: parses multiple addresses',
    run: async () => {
      const clock = fakeClock();
      const resolver = makeResolver({ 'multi.test': ['1.1.1.1', '::1', 'invalid'] });
      const cache = createDnsCache({ resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
      const ips = await cache.lookup('multi.test');
      assert.equal(ips.length, 2);
      assert.equal(ips[0].family, 4);
      assert.equal(ips[1].family, 6);
    },
  },
];
