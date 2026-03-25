const CACHE_NAME = "viveworker-v5";
const APP_ASSETS = ["/app.css", "/app.js", "/i18n.js"];
const APP_ROUTES = new Set(["/", "/app", "/app/"]);
const CACHED_PATHS = new Set(APP_ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_ASSETS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") {
    return;
  }

  if (APP_ROUTES.has(url.pathname)) {
    event.respondWith(networkFirst(event.request, "/app"));
    return;
  }

  if (CACHED_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(event.request, url.pathname));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: "viveworker",
      body: event.data ? event.data.text() : "A new Codex item is available.",
      data: { url: "/app" },
    };
  }

  const title = payload.title || "viveworker";
  const options = {
    body: payload.body || "A new Codex item is available.",
    tag: payload.tag || "",
    data: payload.data || { url: "/app" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/app";
  event.waitUntil(openTargetWindow(targetUrl));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(notifyClients("pushsubscriptionchange"));
});

async function openTargetWindow(targetUrl) {
  const target = new URL(targetUrl, self.location.origin);
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const preferredClients = clients
    .slice()
    .sort((left, right) => scoreClient(right.url) - scoreClient(left.url));

  for (const client of preferredClients) {
    if (typeof client.focus === "function") {
      if (typeof client.navigate === "function") {
        await client.navigate(target.toString());
      }
      await client.focus();
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(target.toString());
  }
}

function scoreClient(urlString) {
  try {
    const url = new URL(urlString);
    let score = 0;
    if (APP_ROUTES.has(url.pathname)) {
      score += 20;
    }
    if (url.pathname === "/app" || url.pathname === "/app/") {
      score += 5;
    }
    return score;
  } catch {
    return 0;
  }
}

async function notifyClients(type) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage({ type });
  }
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
    return Response.error();
  }
}
