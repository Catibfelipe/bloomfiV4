/* Bill reminders: shows the notification sent by the BloomFi server and opens the agenda when tapped. */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  event.waitUntil(self.registration.showNotification(d.title || 'BloomFi', {
    body: d.body || 'Você tem contas para ver na agenda.',
    icon: '/pwa-192.png',
    badge: '/favicon-64.png',
    tag: d.tag || 'bloomfi-bills',
    data: { url: d.url || '/app/#agenda' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app/#agenda';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('/app') && 'focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
