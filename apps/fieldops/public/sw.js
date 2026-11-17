// Cache only the public Expo shell and immutable build assets. Never cache API,
// authentication, tenant data, query-string requests, or cross-origin traffic.
const ROOT = new URL(self.registration.scope);
// A child app must not clean or reuse the root app's shell cache.
const CACHE = ROOT.pathname === "/" ? "fieldops-shell-v1" : `fieldops-shell-v1:${encodeURIComponent(ROOT.pathname)}`;
const SHELL = new URL("index.html", ROOT).href;

function isStaticAsset(url) {
  return url.origin === ROOT.origin && !url.search &&
    (url.pathname.startsWith(`${ROOT.pathname}_expo/static/`) ||
     url.pathname.startsWith(`${ROOT.pathname}assets/`));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch(SHELL, { cache: "reload" });
    if (!response.ok) throw new Error("FieldOps shell unavailable");
    const html = await response.clone().text();
    const urls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => new URL(match[1], ROOT))
      .filter(isStaticAsset).map((url) => url.href);
    await cache.addAll([...new Set(urls)]);
    await cache.put(SHELL, response);
    // Do not skipWaiting: an active session finishes with its existing build.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await cache.match(SHELL);
    if (shell) {
      const html = await shell.text();
      const retained = new Set([SHELL, ...[...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((match) => new URL(match[1], ROOT)).filter(isStaticAsset).map((url) => url.href)]);
      // Remove prior-build bundles when the new worker activates, not mid-session.
      for (const request of await cache.keys()) {
        if (!retained.has(request.url)) await cache.delete(request);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== ROOT.origin || url.search) return;
  const isShell = event.request.mode === "navigate" &&
    (url.pathname === ROOT.pathname || url.href === SHELL);
  if (!isShell && !isStaticAsset(url)) return;
  event.respondWith((async () => {
    const key = isShell ? SHELL : event.request;
    let response;
    try {
      response = await fetch(event.request);
    } catch (error) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
    if (response.ok) {
      // Storage denial/quota must never discard a good online response.
      try {
        const cache = await caches.open(CACHE);
        await cache.put(key, response.clone());
      } catch { /* Offline caching is optional when the network succeeded. */ }
    }
    return response;
  })());
});
