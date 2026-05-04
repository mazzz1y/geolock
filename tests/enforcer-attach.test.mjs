import assert from 'node:assert/strict';

const counts = {
  webNavOnCommitted: 0,
  webRequestOnBeforeRequest: 0,
  webRequestOnBeforeSendHeaders: 0,
  tabsOnRemoved: 0,
};

globalThis.browser = {
  webNavigation: {
    onCommitted: { addListener: () => { counts.webNavOnCommitted += 1; } },
  },
  webRequest: {
    onBeforeRequest: { addListener: () => { counts.webRequestOnBeforeRequest += 1; } },
    onBeforeSendHeaders: { addListener: () => { counts.webRequestOnBeforeSendHeaders += 1; } },
  },
  tabs: {
    onRemoved: { addListener: () => { counts.tabsOnRemoved += 1; } },
  },
  runtime: {
    getURL: () => 'moz-extension://test/',
  },
};

const { attach } = await import('../worker/enforcer.js');

export const tests = [
  {
    name: 'attach: registers each listener exactly once',
    run: () => {
      attach();
      assert.equal(counts.webNavOnCommitted, 1);
      assert.equal(counts.webRequestOnBeforeRequest, 1);
      assert.equal(counts.webRequestOnBeforeSendHeaders, 1);
      assert.equal(counts.tabsOnRemoved, 1);
    },
  },
  {
    name: 'attach: idempotent \u2014 second call does not re-register',
    run: () => {
      attach();
      attach();
      assert.equal(counts.webNavOnCommitted, 1);
      assert.equal(counts.webRequestOnBeforeRequest, 1);
      assert.equal(counts.webRequestOnBeforeSendHeaders, 1);
      assert.equal(counts.tabsOnRemoved, 1);
    },
  },
];
