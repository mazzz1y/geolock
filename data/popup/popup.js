import { buildTraceView } from '../lib/trace-view.js';
import { elem } from '../lib/dom.js';

const send = message => browser.runtime.sendMessage(message);

let activeTabId = null;
let activeTabUrl = '';
let currentEntries = [];

async function init() {
  browser.runtime.onMessage.addListener(message => {
    if (message?.kind === 'event:blocks.changed' && message.tabId === activeTabId) {
      render();
    }
  });
  document.getElementById('open-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  document.getElementById('save-trace').addEventListener('click', saveTrace);
  document.getElementById('fetch-remote').addEventListener('click', fetchRemoteConfig);
  await updateFetchRemoteVisibility();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url ?? '';
  await render();
}

async function render() {
  if (activeTabId == null) return;
  const reply = await send({ kind: 'blocks.get', tabId: activeTabId });
  currentEntries = reply?.ok ? reply.entries : [];
  document.getElementById('save-trace').disabled = currentEntries.length === 0;
  const list = document.getElementById('blocks-list');
  if (!currentEntries.length) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(...[...currentEntries].reverse().map(buildEntryNode));
}

async function updateFetchRemoteVisibility() {
  const button = document.getElementById('fetch-remote');
  try {
    const reply = await send({ kind: 'remote.get' });
    const hasUrl = !!reply?.settings?.url;
    button.hidden = !hasUrl;
  } catch {
    button.hidden = true;
  }
}

async function fetchRemoteConfig() {
  const button = document.getElementById('fetch-remote');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Fetching…';
  try {
    const reply = await send({ kind: 'config.fetchRemote' });
    if (!reply?.ok) {
      button.textContent = 'Failed';
      button.title = reply?.error ?? 'unknown error';
    } else {
      button.textContent = 'Applied';
      button.title = '';
    }
  } catch (error) {
    button.textContent = 'Failed';
    button.title = String(error?.message ?? error);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1500);
  }
}

function saveTrace() {
  if (!currentEntries.length) return;
  const now = new Date();
  const payload = {
    schema: 'geolock-trace-v1',
    exportedAt: now.toISOString(),
    page: activeTabUrl,
    entries: currentEntries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = now.toISOString().replace(/\..+$/, '').replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `geolock-trace-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildEntryNode(entry) {
  const stripped = entry.effect === 'referrer-stripped';
  const details = elem('details', { class: 'block-entry' });

  const summaryText = stripped
    ? (entry.sourceUrl || entry.sourceHost || entry.destinationUrl)
    : entry.destinationUrl;
  const ruleName = entry.matchedRule?.name
    || (entry.matchedRule ? `#${entry.matchedRule.index + 1}` : '');

  const summary = elem('summary', { title: summaryText },
    elem('span', { class: 'caret' }),
    ruleName ? elem('span', { class: 'rule-tag' }, ruleName) : null,
    stripped ? elem('span', { class: 'rule-tag ref-tag', title: 'Referrer header stripped' }, 'REF') : null,
    elem('span', { class: 'entry-text' }, summaryText),
  );
  details.appendChild(summary);

  const body = elem('div', { class: 'block-detail' });

  if (entry.trace?.length) {
    body.appendChild(buildTraceView({
      source: entry.sourceUrl || entry.sourceHost || '',
      destination: entry.destinationUrl,
      verdict: stripped ? 'referrer-stripped' : 'block',
      matchedRule: entry.matchedRule,
      trace: entry.trace,
      contexts: entry.contexts,
      mode: 'matched-only',
    }));
  } else {
    body.appendChild(elem('div', { class: 'muted small' }, 'No trace available'));
  }

  details.appendChild(body);
  return details;
}

init().catch(error => {
  const list = document.getElementById('blocks-list');
  if (list) list.replaceChildren(elem('div', { class: 'muted small' }, `Initialization failed: ${error?.message ?? error}`));
});
