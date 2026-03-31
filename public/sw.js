const CACHE_NAME = 'oc-panel-v1';
const OFFLINE_URL = '/';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

// Handle messages from main thread
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'show-notification') {
    event.waitUntil(
      self.registration.showNotification(event.data.title, event.data.options)
    );
  }
});

// Handle notification click
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var data = event.notification.data || {};
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes('/') && 'focus' in client) {
          client.focus();
          // Tell the client to navigate to the session
          if (data.sessionKey && data.instanceId) {
            client.postMessage({
              type: 'notification-click',
              sessionKey: data.sessionKey,
              instanceId: data.instanceId
            });
          }
          return;
        }
      }
      return clients.openWindow('/');
    })
  );
});

// Handle push (future: server-side push)
self.addEventListener('push', function(event) {
  if (!event.data) return;
  try {
    var payload = event.data.json();
    event.waitUntil(
      self.registration.showNotification(payload.title || 'OpenClaw', {
        body: payload.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: payload.data || {},
        tag: payload.tag || 'oc-push',
        renotify: true,
        vibrate: [100, 50, 100]
      })
    );
  } catch(e) {}
});
