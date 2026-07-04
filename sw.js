/* ================================================================
   CourseHub — Service Worker  (sw.js)
   Proxies Google Drive requests with auth headers so the
   <video> element can stream directly — range requests,
   seeking, and buffering all work natively.
   ================================================================ */
'use strict';

/* fileId → accessToken, set via postMessage from the app */
const TOKEN_MAP = {};

self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'DRIVE_TOKEN') {
    TOKEN_MAP[d.fileId] = d.token;
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* Only intercept /_drive/<fileId> requests */
  const m = url.pathname.match(/\/_drive\/([^/?#]+)/);
  if (!m) return; /* let the browser handle everything else normally */

  const fileId = m[1];
  const token  = TOKEN_MAP[fileId];

  if (!token) {
    event.respondWith(new Response('Drive token missing — re-open the player', { status: 401 }));
    return;
  }

  event.respondWith(proxyDrive(fileId, token, event.request));
});

async function proxyDrive(fileId, token, request) {
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const headers  = { Authorization: `Bearer ${token}` };

  /* Forward Range header so browsers can seek and buffer chunks */
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  try {
    const res = await fetch(driveUrl, { headers });
    /* Pass the response body through as a stream — this is what
       enables playback to start immediately without a full download */
    return new Response(res.body, {
      status:     res.status,     /* 200 or 206 (partial) */
      statusText: res.statusText,
      headers:    res.headers
    });
  } catch (err) {
    return new Response('Drive proxy error: ' + err.message, { status: 502 });
  }
}

/* Activate immediately so the very first player open uses streaming */
self.addEventListener('install',  ()  => self.skipWaiting());
self.addEventListener('activate', evt => evt.waitUntil(clients.claim()));
