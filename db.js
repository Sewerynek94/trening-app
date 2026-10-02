// Prosta warstwa nad IndexedDB — wszystkie dane zostają na telefonie.
const DB_NAME = 'trening-app';
const DB_VERSION = 2;
export const STORES = ['players', 'sessions', 'outlines', 'events'];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      // Inna karta otwiera nowszą wersję bazy — zwalniamy połączenie.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const getAll = store => tx(store, 'readonly', s => reqP(s.getAll()));
export const get = (store, id) => tx(store, 'readonly', s => reqP(s.get(id)));
export const put = (store, obj) => tx(store, 'readwrite', s => { s.put(obj); return obj; });
export const del = (store, id) => tx(store, 'readwrite', s => { s.delete(id); });
export const clear = store => tx(store, 'readwrite', s => { s.clear(); });

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
