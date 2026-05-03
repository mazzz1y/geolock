const CAP = 100;

const log = new Map();
const lastUrl = new Map();

export function record(tabId, entry) {
  if (tabId < 0) return;
  let entries = log.get(tabId);
  if (!entries) {
    entries = [];
    log.set(tabId, entries);
  }
  entries.push(entry);
  if (entries.length > CAP) entries.splice(0, entries.length - CAP);
}

export function getForTab(tabId) {
  return log.get(tabId) ?? [];
}

export function clearTab(tabId) {
  log.delete(tabId);
  lastUrl.delete(tabId);
}

export function count(tabId) {
  return log.get(tabId)?.length ?? 0;
}

export function noteNavigation(tabId, url) {
  if (tabId < 0) return false;
  const previous = lastUrl.get(tabId);
  const same = previous && sameDocument(previous, url);
  lastUrl.set(tabId, url);
  if (!same) {
    log.delete(tabId);
    return true;
  }
  return false;
}

function sameDocument(a, b) {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}
