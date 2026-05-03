import assert from 'node:assert/strict';
import * as blockLog from '../worker/block-log.js';

function makeEntry(n = 0) {
  return { ts: Date.now() + n, resourceUrl: `https://example.com/${n}`, resourceHost: 'example.com', resourceType: 'image' };
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
    name: 'noteNavigation: first call sets URL, does not clear',
    run: () => {
      blockLog.clearTab(20);
      blockLog.record(20, makeEntry());
      const cleared = blockLog.noteNavigation(20, 'https://example.com/');
      assert.equal(cleared, true);
      blockLog.clearTab(20);
    },
  },
  {
    name: 'noteNavigation: same path keeps log',
    run: () => {
      blockLog.clearTab(21);
      blockLog.noteNavigation(21, 'https://example.com/page');
      blockLog.record(21, makeEntry());
      const cleared = blockLog.noteNavigation(21, 'https://example.com/page');
      assert.equal(cleared, false);
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
      assert.equal(blockLog.noteNavigation(22, 'https://example.com/page#section'), false);
      assert.equal(blockLog.noteNavigation(22, 'https://example.com/page?q=1'), false);
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
      assert.equal(blockLog.noteNavigation(23, 'https://example.com/page2'), true);
      assert.equal(blockLog.count(23), 0);
    },
  },
  {
    name: 'noteNavigation: different origin clears log',
    run: () => {
      blockLog.clearTab(24);
      blockLog.noteNavigation(24, 'https://example.com/page');
      blockLog.record(24, makeEntry());
      assert.equal(blockLog.noteNavigation(24, 'https://other.com/page'), true);
      assert.equal(blockLog.count(24), 0);
    },
  },
  {
    name: 'noteNavigation: tabId < 0 ignored',
    run: () => {
      assert.equal(blockLog.noteNavigation(-1, 'https://example.com/'), false);
    },
  },
];
