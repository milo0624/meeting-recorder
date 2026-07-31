// v2：改成「網路優先」——每次都先試著抓最新版本，只有離線的時候才退回
// 快取版本。這樣以後更新 app.js / index.html，手機上會直接吃到新版，
// 不用再手動清瀏覽器資料。
const CACHE = "meeting-recorder-v10";
const ASSETS = ["./", "index.html", "style.css", "app.js", "manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.endsWith("/process")) return; // 呼叫 Worker 一律直接走網路

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)) // 離線時才退回快取
  );
});
