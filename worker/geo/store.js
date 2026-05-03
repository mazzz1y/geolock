const DB_NAME = 'geolock';
const STORE = 'blobs';

const metaKey = key => `${key}:meta`;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function awaitRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBlob(key, bytes, meta = {}) {
  return withStore('readwrite', store => {
    store.put({ key, bytes });
    store.put({ key: metaKey(key), ...meta, savedAt: meta.savedAt ?? Date.now() });
  });
}

export async function loadBlobBody(key) {
  const db = await openDb();
  const record = await awaitRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  return record?.bytes ?? null;
}

export async function loadBlobMeta(key) {
  const db = await openDb();
  const record = await awaitRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(metaKey(key)));
  if (!record) return null;
  const { key: _k, ...meta } = record;
  return meta;
}


