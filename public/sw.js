'use strict';

// MindGit service worker: alleen voor web push. Geen offline cache, zodat de
// dashboard-data altijd vers is.

self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'MindGit', body: event.data ? event.data.text() : '' };
  }

  var title = data.title || 'MindGit';
  var options = {
    body: data.body || '',
    icon: '/icons/logo.png',
    badge: '/icons/logo.png',
    tag: data.tag || 'mindgit',
    data: { url: data.url || '/repos' },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/repos';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if ('focus' in clients[i]) {
          clients[i].navigate(url);
          return clients[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
