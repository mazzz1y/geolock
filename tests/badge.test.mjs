import assert from 'node:assert/strict';

const badgeCalls = [];
let mockTabs = [];
globalThis.browser = {
  action: {
    setBadgeBackgroundColor: args => badgeCalls.push({ fn: 'setBadgeBackgroundColor', ...args }),
    setBadgeText: args => badgeCalls.push({ fn: 'setBadgeText', ...args }),
  },
  tabs: {
    query: async () => mockTabs,
  },
};

const { init, updateBadge, resetAllTabs } = await import('../worker/badge.js');
const blockLog = await import('../worker/block-log.js');

function drain() { badgeCalls.splice(0); }

export const tests = [
  {
    name: 'init sets badge background color',
    run: () => {
      drain();
      init();
      const call = badgeCalls.find(c => c.fn === 'setBadgeBackgroundColor');
      assert.ok(call, 'setBadgeBackgroundColor should be called');
      assert.equal(call.color, '#c0392b');
    },
  },
  {
    name: 'updateBadge sets text to count when > 0',
    run: () => {
      const tabId = 100;
      blockLog.clearTab(tabId);
      blockLog.record(tabId, { ts: Date.now(), resourceUrl: 'https://x.com/', resourceHost: 'x.com', resourceType: 'image' });
      blockLog.record(tabId, { ts: Date.now(), resourceUrl: 'https://y.com/', resourceHost: 'y.com', resourceType: 'image' });
      drain();
      updateBadge(tabId);
      const call = badgeCalls.find(c => c.fn === 'setBadgeText');
      assert.ok(call);
      assert.equal(call.tabId, tabId);
      assert.equal(call.text, '2');
      blockLog.clearTab(tabId);
    },
  },
  {
    name: 'updateBadge sets empty string when count is 0',
    run: () => {
      const tabId = 101;
      blockLog.clearTab(tabId);
      drain();
      updateBadge(tabId);
      const call = badgeCalls.find(c => c.fn === 'setBadgeText');
      assert.ok(call);
      assert.equal(call.tabId, tabId);
      assert.equal(call.text, '');
    },
  },
  {
    name: 'updateBadge ignores tabId < 0',
    run: () => {
      drain();
      updateBadge(-1);
      assert.equal(badgeCalls.length, 0);
    },
  },
  {
    name: 'resetAllTabs clears badge text for every open tab',
    run: async () => {
      mockTabs = [{ id: 1 }, { id: 2 }, { id: 3 }];
      drain();
      await resetAllTabs();
      const calls = badgeCalls.filter(c => c.fn === 'setBadgeText');
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.map(c => c.tabId).sort((a, b) => a - b), [1, 2, 3]);
      assert.ok(calls.every(c => c.text === ''));
    },
  },
  {
    name: 'resetAllTabs skips tabs with invalid id',
    run: async () => {
      mockTabs = [{ id: 1 }, { id: -1 }, { id: null }, { id: 4 }];
      drain();
      await resetAllTabs();
      const calls = badgeCalls.filter(c => c.fn === 'setBadgeText');
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(c => c.tabId).sort((a, b) => a - b), [1, 4]);
    },
  },
];
