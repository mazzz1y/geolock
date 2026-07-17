import assert from 'node:assert/strict';

const counts = {
  webNavOnCommitted: 0,
  webRequestOnBeforeRequest: 0,
  webRequestOnBeforeSendHeaders: 0,
  tabsOnRemoved: 0,
};

const handlers = {};

globalThis.browser = {
  webNavigation: {
    onCommitted: { addListener: fn => { counts.webNavOnCommitted += 1; handlers.committed = fn; } },
  },
  webRequest: {
    onBeforeRequest: { addListener: fn => { counts.webRequestOnBeforeRequest += 1; handlers.beforeRequest = fn; } },
    onBeforeSendHeaders: { addListener: fn => { counts.webRequestOnBeforeSendHeaders += 1; handlers.beforeSendHeaders = fn; } },
  },
  tabs: {
    onRemoved: { addListener: fn => { counts.tabsOnRemoved += 1; handlers.tabRemoved = fn; } },
  },
  action: {
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {},
  },
  runtime: {
    getURL: () => 'moz-extension://test/',
    sendMessage: () => Promise.resolve(),
  },
};

const enforcer = await import('../worker/enforcer.js?attach-tests');
const { attach, deriveSourceContext, setConfig, markReady } = enforcer;
const geo = await import('../worker/geo/index.js');
const blockLog = await import('../worker/block-log.js');

geo.forceReady();
markReady();

const stripConfig = {
  default_action: 'allow',
  dns: { match_strategy: 'all' },
  rules: [{
    enabled: true,
    action: 'block',
    strip_referrer: true,
    source: { type: 'domain', regex: '(^|\\.)bank\\.test$' },
    destination: { type: 'any' },
  }],
};

const blockAllConfig = {
  default_action: 'allow',
  dns: { match_strategy: 'all' },
  rules: [{
    enabled: true,
    action: 'block',
    source: { type: 'any' },
    destination: { type: 'any' },
  }],
};

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
  {
    name: 'onCommitted: main_frame commit resets frame map, dropping stale iframes',
    run: () => {
      attach();
      handlers.committed({ tabId: 1, frameId: 0, parentFrameId: -1, url: 'https://old.test/' });
      handlers.committed({ tabId: 1, frameId: 5, parentFrameId: 0, url: 'https://iframe.test/' });
      handlers.committed({ tabId: 1, frameId: 0, parentFrameId: -1, url: 'https://new.test/' });
      const ctx = deriveSourceContext({ tabId: 1, frameId: 5, url: 'https://r/' });
      assert.equal(ctx.host, 'new.test');
      handlers.tabRemoved(1);
    },
  },
  {
    name: 'deriveSourceContext: non-main_frame prefers documentUrl over frames map',
    run: () => {
      attach();
      handlers.committed({ tabId: 2, frameId: 0, parentFrameId: -1, url: 'https://top.test/' });
      const ctx = deriveSourceContext({
        tabId: 2, frameId: 7, type: 'image',
        documentUrl: 'https://real-doc.test/page',
        url: 'https://r/',
      });
      assert.equal(ctx.host, 'real-doc.test');
      handlers.tabRemoved(2);
    },
  },
  {
    name: 'deriveSourceContext: main_frame uses frames map even with documentUrl',
    run: () => {
      attach();
      handlers.committed({ tabId: 3, frameId: 0, parentFrameId: -1, url: 'https://top.test/' });
      const ctx = deriveSourceContext({
        tabId: 3, frameId: 0, type: 'main_frame',
        documentUrl: 'https://stale.test/page',
        url: 'https://r/',
      });
      assert.equal(ctx.host, 'top.test');
      handlers.tabRemoved(3);
    },
  },
  {
    name: 'handleBeforeRequest: main_frame block verdict never cancels',
    run: async () => {
      attach();
      setConfig(blockAllConfig);
      handlers.committed({ tabId: 4, frameId: 0, parentFrameId: -1, url: 'https://source.test/' });
      const result = await handlers.beforeRequest({
        requestId: 'mf-1', tabId: 4, frameId: 0, type: 'main_frame',
        url: 'https://dest.test/',
      });
      assert.equal(result, undefined);
      handlers.tabRemoved(4);
    },
  },
  {
    name: 'handleBeforeRequest: sub-resource block cancels and logs with trace',
    run: async () => {
      attach();
      setConfig(blockAllConfig);
      blockLog.clearTab(5);
      handlers.committed({ tabId: 5, frameId: 0, parentFrameId: -1, url: 'https://source.test/' });
      const result = await handlers.beforeRequest({
        requestId: 'sub-1', tabId: 5, frameId: 0, type: 'image',
        url: 'https://dest.test/img.png',
      });
      assert.deepEqual(result, { cancel: true });
      const entries = blockLog.getForTab(5);
      assert.equal(entries.length, 1);
      assert.ok(Array.isArray(entries[0].trace), 'logged entry must carry a trace');
      blockLog.clearTab(5);
      handlers.tabRemoved(5);
    },
  },
  {
    name: 'strip flow: cached verdict consumed by onBeforeSendHeaders strips referer',
    run: async () => {
      attach();
      setConfig(stripConfig);
      blockLog.clearTab(6);
      handlers.committed({ tabId: 6, frameId: 0, parentFrameId: -1, url: 'https://bank.test/' });
      const details = {
        requestId: 'strip-1', tabId: 6, frameId: 0, type: 'main_frame',
        url: 'https://evil.test/landing',
      };
      const brResult = await handlers.beforeRequest(details);
      assert.equal(brResult, undefined);
      const bshResult = await handlers.beforeSendHeaders({
        ...details,
        requestHeaders: [
          { name: 'Referer', value: 'https://bank.test/' },
          { name: 'Accept', value: '*/*' },
        ],
      });
      assert.deepEqual(bshResult.requestHeaders, [{ name: 'Accept', value: '*/*' }]);
      blockLog.clearTab(6);
      handlers.tabRemoved(6);
    },
  },
  {
    name: 'verdict cache: redirect with new URL does not consume stale verdict',
    run: async () => {
      attach();
      setConfig(stripConfig);
      blockLog.clearTab(7);
      handlers.committed({ tabId: 7, frameId: 0, parentFrameId: -1, url: 'https://bank.test/' });
      const first = {
        requestId: 'redir-1', tabId: 7, frameId: 0, type: 'main_frame',
        url: 'https://evil.test/landing',
      };
      await handlers.beforeRequest(first);
      const taken = enforcer.cacheTakeVerdict('redir-1', 'https://other.test/after-redirect');
      assert.equal(taken, undefined, 'verdict cached for old URL must not apply to redirected URL');
      blockLog.clearTab(7);
      handlers.tabRemoved(7);
    },
  },
  {
    name: 'verdict cache: re-request with same requestId re-evaluates instead of reusing stale entry',
    run: async () => {
      attach();
      setConfig(stripConfig);
      handlers.committed({ tabId: 8, frameId: 0, parentFrameId: -1, url: 'https://bank.test/' });
      await handlers.beforeRequest({
        requestId: 'reuse-1', tabId: 8, frameId: 0, type: 'main_frame',
        url: 'https://evil.test/a',
      });
      handlers.committed({ tabId: 8, frameId: 0, parentFrameId: -1, url: 'https://neutral.test/' });
      await handlers.beforeRequest({
        requestId: 'reuse-1', tabId: 8, frameId: 0, type: 'main_frame',
        url: 'https://evil.test/b',
      });
      assert.equal(enforcer.cacheTakeVerdict('reuse-1', 'https://evil.test/a'), undefined);
      handlers.tabRemoved(8);
    },
  },
];
