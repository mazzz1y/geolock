import * as blockLog from './block-log.js';

export function init() {
  try {
    browser.action.setBadgeBackgroundColor({ color: '#c0392b' });
  } catch { /* ... */ }
}

export function updateBadge(tabId) {
  if (tabId < 0) return;
  const n = blockLog.count(tabId);
  try {
    browser.action.setBadgeText({ tabId, text: n > 0 ? String(n) : '' });
  } catch { /* ... */ }
}

export async function resetAllTabs() {
  let tabs;
  try { tabs = await browser.tabs.query({}); }
  catch { return; }
  for (const tab of tabs) {
    if (tab?.id == null || tab.id < 0) continue;
    try { browser.action.setBadgeText({ tabId: tab.id, text: '' }); }
    catch { /* ... */ }
  }
}
