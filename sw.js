// Reminders: Firebase delivers push messages here, and this shows them even when the app is
// closed. Tapping one opens the app.
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { notification: { body: event.data && event.data.text() } }; }
  const n = Object.assign({}, p.data || {}, p.notification || {});
  const link = n.link || (p.fcmOptions && p.fcmOptions.link) || self.registration.scope;
  event.waitUntil(self.registration.showNotification(n.title || 'Last Man Standing', {
    body: n.body || 'Picks close soon.',
    icon: n.icon || 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'lms-reminder',
    renotify: true,
    data: { link },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || self.registration.scope;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return clients.openWindow(link);
  }));
});

// Lets the app open with no signal. It always asks the server first (so
// everyone gets the latest version straight away) and only falls back to
// the copy saved on this device when offline. It never touches requests
// to other sites, so Firebase data and live scores are unaffected.
const CACHE_NAME = 'lms-offline-v3';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(['./'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n.startsWith('lms-') && n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then((hit) =>
        hit || (req.mode === 'navigate' ? caches.match('./') : Response.error())))
  );
});
