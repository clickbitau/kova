// Kova service worker: shows push notifications from the hub and opens the app when one is tapped.
// Payload (JSON): { title, body, url, tag, actions: [{ action, title, url }] }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const actions = Array.isArray(d.actions) ? d.actions : [];
  e.waitUntil(self.registration.showNotification(d.title || 'Kova', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/assets/logo/kova-app-icon.svg',
    data: { url: d.url || '/phone.html', actions },
    actions: actions.map(a => ({ action: a.action, title: a.title })),
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const act = (d.actions || []).find(a => a.action === e.action);
  const url = new URL((act && act.url) || d.url || '/phone.html', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url === url);
    if (same) return same.focus();
    const any = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (any && 'navigate' in any) {
      const w = await any.navigate(url).catch(() => null);
      return (w || any).focus();
    }
    return self.clients.openWindow(url);
  })());
});
