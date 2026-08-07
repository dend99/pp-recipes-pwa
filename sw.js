/* sw.js — оффлайн-кэш для PWA «ПП Рецепты».
 * Стратегия: NETWORK-FIRST для своих ресурсов (чтобы свежий код и банк рецептов
 * всегда доходили при наличии сети), с откатом в кэш для оффлайна.
 * Пользовательские рецепты живут в localStorage. */
const CACHE = 'pp-recipes-v7';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/data.js',
  './js/bank.js',
  './js/app.js',
  './fonts/instrument-serif-latin.woff2',
  './fonts/instrument-serif-latinext.woff2',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Позволяем странице попросить новый воркер активироваться немедленно.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // сторонние запросы не трогаем
  e.respondWith(networkFirst(request));
});
