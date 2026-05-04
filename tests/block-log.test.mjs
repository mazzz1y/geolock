import assert from 'node:assert/strict';

const sessionStore = new Map();
let getCalls = 0;
let setCalls = 0;
let setFails = false;

globalThis.browser = {
  storage: {
    session: {
      get: async key => {
        getCalls += 1;
        if (typeof key === 'string') {
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
        }
        return {};
      },
      set: async obj => {
        setCalls += 1;
        if (setFails) throw new Error('mock storage failure');
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
    },
  },
};

const blockLog = await import('../worker/block-log.js');

function makeEntry(n = 0) {
  return { ts: Date.now() + n, resourceUrl: `https://example.com/${n}`, resourceHost: 'example.com', resourceType: 'image' };
}

function resetAll() {
  sessionStore.clear();
  getCalls = 0;
  setCalls = 0;
  setFails = false;
  for (let i = 0; i < 200; i++) blockLog.clearTab(i);
}

export const tests = [
  {
    name: 'record and getForTab returns entries',
    run: () => {
      blockLog.clearTab(1);
      blockLog.record(1, makeEntry(0));
      blockLog.record(1, makeEntry(1));
      const entries = blockLog.getForTab(1);
      assert.equal(entries.length, 2);
      blockLog.clearTab(1);
    },
  },
  {
    name: 'getForTab returns empty array for unknown tab',
    run: () => {
      const entries = blockLog.getForTab(9999);
      assert.deepEqual(entries, []);
    },
  },
  {
    name: 'count reflects recorded entries',
    run: () => {
      blockLog.clearTab(2);
      assert.equal(blockLog.count(2), 0);
      blockLog.record(2, makeEntry());
      assert.equal(blockLog.count(2), 1);
      blockLog.record(2, makeEntry());
      assert.equal(blockLog.count(2), 2);
      blockLog.clearTab(2);
    },
  },
  {
    name: 'clearTab removes all entries and resets count',
    run: () => {
      blockLog.clearTab(3);
      blockLog.record(3, makeEntry());
      blockLog.record(3, makeEntry());
      blockLog.clearTab(3);
      assert.equal(blockLog.count(3), 0);
      assert.deepEqual(blockLog.getForTab(3), []);
    },
  },
  {
    name: 'tabs are isolated',
    run: () => {
      blockLog.clearTab(10);
      blockLog.clearTab(11);
      blockLog.record(10, makeEntry());
      assert.equal(blockLog.count(10), 1);
      assert.equal(blockLog.count(11), 0);
      blockLog.clearTab(10);
    },
  },
  {
    name: 'tabId < 0 is ignored',
    run: () => {
      blockLog.record(-1, makeEntry());
      assert.equal(blockLog.count(-1), 0);
    },
  },
  {
    name: 'cap enforced at 100 entries',
    run: () => {
      blockLog.clearTab(4);
      for (let i = 0; i < 110; i++) blockLog.record(4, makeEntry(i));
      assert.equal(blockLog.count(4), 100);
      blockLog.clearTab(4);
    },
  },
  {
    name: 'cap keeps newest entries',
    run: () => {
      blockLog.clearTab(5);
      for (let i = 0; i < 105; i++) blockLog.record(5, { ...makeEntry(i), resourceUrl: `https://example.com/${i}` });
      const entries = blockLog.getForTab(5);
      assert.equal(entries.length, 100);
      assert.equal(entries[0].resourceUrl, 'https://example.com/5');
      assert.equal(entries[99].resourceUrl, 'https://example.com/104');
      blockLog.clearTab(5);
    },
  },
  {
    name: 'noteNavigation: first call sets URL, returns cleared=true',
    run: () => {
      blockLog.clearTab(20);
      blockLog.record(20, makeEntry());
      const result = blockLog.noteNavigation(20, 'https://example.com/');
      assert.equal(result.cleared, true);
      blockLog.clearTab(20);
    },
  },
  {
    name: 'noteNavigation: same path keeps log',
    run: () => {
      blockLog.clearTab(21);
      blockLog.noteNavigation(21, 'https://example.com/page');
      blockLog.record(21, makeEntry());
      const result = blockLog.noteNavigation(21, 'https://example.com/page');
      assert.equal(result.cleared, false);
      assert.equal(blockLog.count(21), 1);
      blockLog.clearTab(21);
    },
  },
  {
    name: 'noteNavigation: hash/query change keeps log',
    run: () => {
      blockLog.clearTab(22);
      blockLog.noteNavigation(22, 'https://example.com/page');
      blockLog.record(22, makeEntry());
      assert.equal(blockLog.noteNavigation(22, 'https://example.com/page#section').cleared, false);
      assert.equal(blockLog.noteNavigation(22, 'https://example.com/page?q=1').cleared, false);
      assert.equal(blockLog.count(22), 1);
      blockLog.clearTab(22);
    },
  },
  {
    name: 'noteNavigation: different path clears log',
    run: () => {
      blockLog.clearTab(23);
      blockLog.noteNavigation(23, 'https://example.com/page1');
      blockLog.record(23, makeEntry());
      assert.equal(blockLog.noteNavigation(23, 'https://example.com/page2').cleared, true);
      assert.equal(blockLog.count(23), 0);
    },
  },
  {
    name: 'noteNavigation: different origin clears log',
    run: () => {
      blockLog.clearTab(24);
      blockLog.noteNavigation(24, 'https://example.com/page');
      blockLog.record(24, makeEntry());
      assert.equal(blockLog.noteNavigation(24, 'https://other.com/page').cleared, true);
      assert.equal(blockLog.count(24), 0);
    },
  },
  {
    name: 'noteNavigation: tabId < 0 ignored',
    run: () => {
      const result = blockLog.noteNavigation(-1, 'https://example.com/');
      assert.equal(result.cleared, false);
      assert.equal(result.flush, null);
    },
  },
  {
    name: 'restore: missing storage starts clean',
    run: async () => {
      resetAll();
      await blockLog.restore(new Set([1, 2]));
      assert.equal(blockLog.count(1), 0);
      assert.equal(blockLog.count(2), 0);
    },
  },
  {
    name: 'restore: rehydrates entries for active tabs',
    run: async () => {
      resetAll();
      sessionStore.set('block_log_v1', {
        log: { 30: [makeEntry(1), makeEntry(2)], 31: [makeEntry(3)] },
        lastUrl: { 30: 'https://example.com/a', 31: 'https://example.com/b' },
      });
      await blockLog.restore(new Set([30, 31]));
      assert.equal(blockLog.count(30), 2);
      assert.equal(blockLog.count(31), 1);
      assert.equal(blockLog.noteNavigation(30, 'https://example.com/a').cleared, false);
      await blockLog.clearTab(30);
      await blockLog.clearTab(31);
    },
  },
  {
    name: 'restore: drops entries for closed tabs',
    run: async () => {
      resetAll();
      sessionStore.set('block_log_v1', {
        log: { 40: [makeEntry()], 41: [makeEntry()] },
        lastUrl: { 40: 'https://example.com/', 41: 'https://example.com/' },
      });
      await blockLog.restore(new Set([40]));
      assert.equal(blockLog.count(40), 1);
      assert.equal(blockLog.count(41), 0);
      await blockLog.clearTab(40);
    },
  },
  {
    name: 'record after restore returns Promise that resolves after storage write',
    run: async () => {
      resetAll();
      await blockLog.restore(new Set([50]));
      setCalls = 0;
      const flush = blockLog.record(50, makeEntry(1));
      assert.ok(flush && typeof flush.then === 'function', 'record should return a Promise');
      assert.equal(setCalls, 0, 'storage.set runs in microtask, not synchronously');
      await flush;
      assert.equal(setCalls, 1);
      const stored = sessionStore.get('block_log_v1');
      assert.equal(stored.log['50'].length, 1);
      await blockLog.clearTab(50);
    },
  },
  {
    name: 'multiple records in same tick coalesce into one storage write',
    run: async () => {
      resetAll();
      await blockLog.restore(new Set([51]));
      setCalls = 0;
      const f1 = blockLog.record(51, makeEntry(1));
      const f2 = blockLog.record(51, makeEntry(2));
      const f3 = blockLog.record(51, makeEntry(3));
      assert.strictEqual(f1, f2);
      assert.strictEqual(f2, f3);
      await f1;
      assert.equal(setCalls, 1);
      const stored = sessionStore.get('block_log_v1');
      assert.equal(stored.log['51'].length, 3);
      await blockLog.clearTab(51);
    },
  },
  {
    name: 'flush survives if setTimeout never fires (microtask, not timer)',
    run: async () => {
      resetAll();
      await blockLog.restore(new Set([52]));
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = () => { throw new Error('setTimeout must not be used'); };
      try {
        const flush = blockLog.record(52, makeEntry());
        await flush;
        const stored = sessionStore.get('block_log_v1');
        assert.equal(stored.log['52'].length, 1);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      await blockLog.clearTab(52);
    },
  },
  {
    name: 'clearTab returns Promise that resolves after storage write',
    run: async () => {
      resetAll();
      await blockLog.restore(new Set([60]));
      await blockLog.record(60, makeEntry());
      setCalls = 0;
      const flush = blockLog.clearTab(60);
      assert.ok(flush && typeof flush.then === 'function');
      await flush;
      assert.equal(setCalls, 1);
      const stored = sessionStore.get('block_log_v1');
      assert.equal(stored.log['60'], undefined);
    },
  },
  {
    name: 'restore: corrupt payload starts clean without throwing',
    run: async () => {
      resetAll();
      sessionStore.set('block_log_v1', { log: 'not-an-object', lastUrl: null });
      await blockLog.restore(new Set([70]));
      assert.equal(blockLog.count(70), 0);
    },
  },
  {
    name: 'whenRestored resolves after restore completes',
    run: async () => {
      const promise = blockLog.whenRestored();
      assert.ok(promise && typeof promise.then === 'function');
      await promise;
    },
  },
  {
    name: 'flushNow swallows storage errors',
    run: async () => {
      resetAll();
      await blockLog.restore(new Set([80]));
      setFails = true;
      const flush = blockLog.record(80, makeEntry());
      await flush;
      setFails = false;
      await blockLog.clearTab(80);
    },
  },
];
