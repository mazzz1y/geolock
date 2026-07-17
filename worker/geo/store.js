const DB_NAME = 'geolock';
const STORE = 'blobs';

const metaKey = key => `${key}:meta`;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
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

function stripKey(record) {
  if (!record) return null;
  const { key: _k, ...meta } = record;
  return meta;
}

export async function loadBlobMeta(key) {
  const db = await openDb();
  const record = await awaitRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(metaKey(key)));
  return stripKey(record);
}

export async function loadBlob(key) {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const [bodyRecord, metaRecord] = await Promise.all([
    awaitRequest(store.get(key)),
    awaitRequest(store.get(metaKey(key))),
  ]);
  return { bytes: bodyRecord?.bytes ?? null, meta: stripKey(metaRecord) };
}
