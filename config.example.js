/* ════════════════════════════════════════════════
   FridgeFox — config + cache  (EXAMPLE / TEMPLATE)
   ────────────────────────────────────────────────
   Copy this file to `config.js` and drop in your own keys.
   `config.js` is gitignored so real secrets never get committed.

     cp config.example.js config.js

   Keys you need (all have free tiers):
   • OpenRouter  → https://openrouter.ai/keys   (only used for "Adapt steps")
   • Edamam      → https://developer.edamam.com  (one app per API below)
   Leave any Edamam id blank to switch that API off gracefully.
   ════════════════════════════════════════════════ */

/* ── OpenRouter (step adaptation only) ── */
const OR_KEY = 'sk-or-v1-YOUR_OPENROUTER_KEY_HERE';
const OR_MODEL = 'liquid/lfm-2.5-1.2b-instruct:free';

/* ── TheMealDB (free, no key) ── */
const MEALDB = 'https://www.themealdb.com/api/json/v1/1';

/* ── Edamam ──
   Each API needs its own app_id (8 chars) + app_key (32 chars).
   Paste the app_id next to each key below. Leave id blank = that API stays off.
*/
const EDAMAM = {
  recipe: {
    id:  '',                                          // Recipe Search app_id
    key: 'YOUR_EDAMAM_RECIPE_KEY_HERE',
    base:'https://api.edamam.com/api/recipes/v2'
  },
  nutrition: {
    id:  '',                                          // Nutrition app_id
    key: 'YOUR_EDAMAM_NUTRITION_KEY_HERE',
    base:'https://api.edamam.com/api/nutrition-data'
  },
  food: {
    id:  '',                                          // Food DB app_id
    key: 'YOUR_EDAMAM_FOOD_KEY_HERE',
    base:'https://api.edamam.com/api/food-database/v2'
  }
};
const edamamOn = svc => !!EDAMAM[svc].id;

/* ════════════════════════════════════════════════
   CACHE — localStorage w/ TTL, versioned, size-guarded
   Wraps any async fetch fn. Keyed by URL.
   ════════════════════════════════════════════════ */
const CACHE = {
  ns: 'ff:v1:',
  ttl: 1000*60*60*24*7,          // 7 days
  max: 300,                       // max entries before prune

  _k(url){ return this.ns + url; },

  get(url){
    try{
      const raw = localStorage.getItem(this._k(url));
      if(!raw) return null;
      const {t,d} = JSON.parse(raw);
      // expired: don't serve fresh, but KEEP the row so getStale() can rescue
      // a search when the network/rate-limit fails. _prune() caps total size.
      if(Date.now()-t > this.ttl){ return null; }
      return d;
    }catch{ return null; }
  },

  // last-resort read that ignores TTL — powers stale-while-error fallback
  getStale(url){
    try{
      const raw = localStorage.getItem(this._k(url));
      if(!raw) return undefined;
      return JSON.parse(raw).d;
    }catch{ return undefined; }
  },

  set(url,data){
    try{
      localStorage.setItem(this._k(url), JSON.stringify({t:Date.now(),d:data}));
      this._prune();
    }catch(e){
      // quota hit — nuke our namespace and retry once
      this.clear();
      try{ localStorage.setItem(this._k(url), JSON.stringify({t:Date.now(),d:data})); }catch{}
    }
  },

  _prune(){
    const keys = Object.keys(localStorage).filter(k=>k.startsWith(this.ns));
    if(keys.length <= this.max) return;
    // drop oldest by timestamp
    const scored = keys.map(k=>{
      let t=0; try{ t=JSON.parse(localStorage.getItem(k)).t; }catch{}
      return [k,t];
    }).sort((a,b)=>a[1]-b[1]);
    scored.slice(0, keys.length-this.max).forEach(([k])=>localStorage.removeItem(k));
  },

  clear(){
    Object.keys(localStorage).filter(k=>k.startsWith(this.ns)).forEach(k=>localStorage.removeItem(k));
  },

  stats(){
    const keys = Object.keys(localStorage).filter(k=>k.startsWith(this.ns));
    return { entries: keys.length };
  }
};

/* cached JSON fetch — the workhorse.
   opts.ttl overrides default; opts.skipCache to force fresh.
   Resilience: retries 429/503 with exponential backoff + jitter, and on
   ultimate failure falls back to STALE cache so a rate-limit never nukes
   a whole search. Set opts.noStale=true to opt out of the stale rescue. */
async function cachedJSON(url, opts={}){
  if(!opts.skipCache){
    const hit = CACHE.get(url);
    if(hit!==null){ hit.__cache='HIT'; return hit; }
  }

  const RETRIABLE = new Set([429, 500, 502, 503, 504]);
  const MAX = opts.retries ?? 3;
  let lastErr;

  for(let attempt=0; attempt<=MAX; attempt++){
    try{
      const r = await fetch(url, opts.init||{});
      if(r.ok){
        const j = await r.json();
        j.__cache='MISS';
        CACHE.set(url, j);
        return j;
      }
      // retriable status → wait then loop; otherwise bail to catch below
      if(RETRIABLE.has(r.status) && attempt<MAX){
        // honour Retry-After if the server sent one, else backoff+jitter
        const ra = parseFloat(r.headers.get('retry-after'));
        const wait = Number.isFinite(ra) ? ra*1000
                   : Math.min(4000, 350*2**attempt) + Math.random()*250;
        await sleep(wait);
        continue;
      }
      const t = await r.text().catch(()=>'');
      lastErr = new Error(`${r.status} ${url.split('?')[0].split('/').pop()}: ${t.slice(0,80)}`);
      lastErr.status = r.status;
      break;
    }catch(e){
      lastErr = e;
      if(attempt<MAX){ await sleep(Math.min(4000, 350*2**attempt)+Math.random()*250); continue; }
    }
  }

  // ── stale-while-error: a dead API should never blank the page ──
  if(!opts.noStale){
    const stale = CACHE.getStale(url);
    if(stale!==undefined){ stale.__cache='STALE'; return stale; }
  }
  throw lastErr || new Error('fetch failed: '+url);
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* pooled map — run async fn over items with bounded concurrency.
   Prevents self-inflicted 429s from bursting 40 lookups at a free API. */
async function poolMap(items, fn, limit=8){
  const out = new Array(items.length);
  let i = 0;
  async function worker(){
    while(i < items.length){
      const idx = i++;
      try{ out[idx] = await fn(items[idx], idx); }
      catch{ out[idx] = null; }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, worker));
  return out;
}
