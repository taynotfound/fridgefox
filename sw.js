/* FridgeFox service worker — network-first for app code, cache-first for images */
const V = 'fridgefox-v3';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './sources.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL).catch(()=>{})));
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==V&&k!=='ff-img').map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method!=='GET') return;
  const url = new URL(req.url);

  // app shell (same origin) → NETWORK-FIRST so code updates always land,
  // fall back to cache only when offline. Keeps PWA installable + offline-capable
  // without the "stale JS after edit" trap.
  if(url.origin===location.origin){
    e.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(V).then(c=>c.put(req,copy)).catch(()=>{});
        return res;
      }).catch(()=>caches.match(req))
    );
    return;
  }

  // recipe images (TheMealDB / Edamam CDN) → cache-first, they never change
  if(/themealdb\.com|edamam-product-images|ftp\.cdn\.edamam/.test(url.host)){
    e.respondWith(
      caches.open('ff-img').then(async c=>{
        const hit=await c.match(req);
        const net=fetch(req).then(res=>{c.put(req,res.clone()).catch(()=>{});return res;}).catch(()=>hit);
        return hit || net;
      })
    );
    return;
  }
  // everything else (APIs) → network; the JS-layer localStorage cache handles dedupe
});
