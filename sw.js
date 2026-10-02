// Service worker: tryb offline + odbieranie plików udostępnionych z innych aplikacji.
const CACHE = 'trening-v10';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'viewer.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/mammoth.browser.min.js', 'vendor/marked.umd.js',
  'vendor/fonts/oswald-latin-600-normal.woff2', 'vendor/fonts/oswald-latin-ext-600-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Najpierw sieć (świeża wersja), a bez internetu — kopia z pamięci podręcznej.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});

function kindOf(name, mime = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime.includes('wordprocessingml')) return 'docx';
  if (ext === 'md' || ext === 'markdown' || mime === 'text/markdown') return 'md';
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html';
  if (mime.startsWith('image/')) return 'image';
  if (ext === 'txt' || mime.startsWith('text/')) return 'txt';
  return null;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('trening-app', 2);
    req.onupgradeneeded = () => {
      for (const n of ['players', 'sessions', 'outlines', 'events']) {
        if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f && typeof f !== 'string');
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction('outlines', 'readwrite');
      const store = t.objectStore('outlines');
      for (const f of files) {
        const kind = kindOf(f.name || '', f.type);
        if (!kind) continue;
        store.put({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          name: (f.name || 'Konspekt').replace(/\.[^.]+$/, ''), fileName: f.name, type: f.type, kind,
          size: f.size, added: new Date().toISOString(), blob: f, tags: '', fromShare: true,
        });
      }
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    return Response.redirect('./?shared=1#/konspekty', 303);
  } catch (err) {
    return Response.redirect('./?shared=error#/konspekty', 303);
  }
}
