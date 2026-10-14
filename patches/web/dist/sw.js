/* Rakijazios service worker: caches the app shell only.
 * Never caches /api, /rpc, /novnc, auth, WebSocket or any non-GET / cross-origin request:
 * those always go straight to the network. */
const VERSION = "rk-shell-v1";
const SHELL = ["/", "/site.webmanifest", "/icon-192.png", "/icon-512.png", "/favicon.ico"];
const NEVER = [/^\/api(\/|$)/, /^\/rpc(\/|$)/, /^\/novnc(\/|$)/, /^\/\.well-known\//, /^\/sw\.js$/];
const STATIC = /^\/(assets\/.+|[\w.-]+\.(js|css|png|ico|svg|webmanifest|woff2?))$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("rk-shell-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(res) {
  return res && res.ok && res.type === "basic" && !/no-store/i.test(res.headers.get("cache-control") || "");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;
  if (req.headers.get("upgrade")) return;

  // Page loads: network first (fresh index.html → fresh hashed assets), cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res) && !res.redirected) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("/", copy)); }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || Response.error())),
    );
    return;
  }
  if (!STATIC.test(url.pathname)) return;
  // Hashed build assets never change: cache first. Overlays/icons: stale-while-revalidate.
  const immutable = url.pathname.startsWith("/assets/");
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (cacheable(res)) cache.put(req, res.clone()); return res; });
      if (hit) { if (!immutable) event.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }),
  );
});
