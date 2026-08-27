// TrailQuest Service Worker
// 同一オリジンのアプリ本体だけをキャッシュする。Overpass/Wikipedia/Wikidata/Commons/
// 地図タイルなど他ドメインへのリクエストは一切手を出さず素通しする
// （アプリ側に既にミラー切り替え・キャッシュ再利用のロジックがあるため、
//  ここで横から古いデータを返して混乱させないようにするため）。
const CACHE = 'trailquest-shell-v1';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return; // 他ドメインはService Workerが触らない
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
