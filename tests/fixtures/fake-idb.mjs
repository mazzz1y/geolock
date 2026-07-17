export const idbData = new Map();

function makeRequest(execute) {
  const request = {};
  queueMicrotask(() => {
    try {
      request.result = execute();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });
  return request;
}

function makeObjectStore() {
  return {
    get: key => makeRequest(() => idbData.get(key)),
    put: record => makeRequest(() => { idbData.set(record.key, record); }),
  };
}

function makeTransaction() {
  const tx = {
    objectStore: () => makeObjectStore(),
  };
  setTimeout(() => tx.oncomplete?.(), 0);
  return tx;
}

const fakeDb = {
  transaction: () => makeTransaction(),
  createObjectStore: () => makeObjectStore(),
};

export function installFakeIndexedDB() {
  if (globalThis.indexedDB?.__geolockFake) return idbData;
  globalThis.indexedDB = {
    __geolockFake: true,
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = fakeDb;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return idbData;
}
