/* ══════════════════════════════════════════════════════════
   FridgeFox — engine
   Ranking is 100% deterministic math. No LLM hallucination.
   Sources: TheMealDB (full steps) + Edamam (variety + nutrition).
   The LLM ONLY rewrites cooking steps for your mode.
   ══════════════════════════════════════════════════════════ */

/* ── knowledge tables (drive scoring, no AI needed) ── */
const EXPENSIVE = ['beef','steak','sirloin','lamb','veal','prawn','shrimp','salmon','tuna','cod','seafood','crab','lobster','scallop','duck','saffron','pine nut','parmesan','feta','halloumi','mozzarella','bacon','pancetta','chorizo','sausage','wine','cream','mascarpone'];
const MEAT = ['beef','steak','sirloin','chicken','pork','lamb','veal','bacon','ham','sausage','chorizo','pancetta','prosciutto','turkey','duck','mince','meat','prawn','shrimp','salmon','tuna','cod','fish','seafood','crab','lobster','scallop','anchov','gelatin'];
const STAPLE = ['salt','pepper','water','oil','olive oil','vegetable oil','sugar','flour','butter','garlic','onion','egg','eggs','rice','pasta','noodles','stock','bouillon','vinegar','soy sauce','tomato','tomato sauce','milk','baking powder','cornstarch','cornflour','herbs','spice','paprika','cumin','chilli','chili','basil','oregano','parsley','coriander','ginger','honey','mustard','ketchup','mayonnaise','bread','potato','carrot','lemon','lime'];
const OVEN_WORDS = ['oven','bake','baking','roast','roasting','grill','broil','preheat'];
const FRY_WORDS  = ['deep fry','deep-fry','deep fried'];

/* ── state ── */
let mode = 'normal';                 // ← default vibe
const cons = new Set();
let ranked = [];
let shown = 0;
let userIngsGlobal = [];
const PAGE = 6;

/* ── last-search persistence ──
   Deep-linking / refreshing a recipe page needs the recipe object back.
   TheMealDB is re-fetchable by id, but Edamam recipes are NOT — so we stash
   the raw recipes + the ingredients they were scored against. Survives reload
   and lets any recipe (either source) reopen cold. */
const LAST = {
  key:'ff:last',
  save(recs, userIngs){
    try{ localStorage.setItem(this.key, JSON.stringify({t:Date.now(), userIngs, recs})); }catch{}
  },
  load(){
    try{ return JSON.parse(localStorage.getItem(this.key)||'null'); }catch{ return null; }
  },
  find(id){
    const s=this.load(); if(!s) return null;
    const rec=(s.recs||[]).find(r=>r.id===id);
    return rec ? {rec, userIngs:s.userIngs||[]} : null;
  }
};

/* ── UI wiring ── */
document.querySelectorAll('.mode').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.mode').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); mode=b.dataset.m;
    document.getElementById('modeHint').textContent=b.dataset.hint;
  });
});
document.querySelectorAll('.tag').forEach(b=>{
  b.addEventListener('click',()=>{
    b.classList.toggle('on');
    b.classList.contains('on')?cons.add(b.dataset.c):cons.delete(b.dataset.c);
  });
});
const QUICK = ['egg','onion','garlic','pasta','rice','tomato','cheese','chicken','potato','bread'];
(function quickAdd(){
  const box=document.getElementById('quickAdd'); if(!box) return;
  QUICK.forEach(q=>{
    const b=document.createElement('button'); b.className='qadd'; b.textContent='+ '+q;
    b.onclick=()=>{const ta=document.getElementById('ings');const v=ta.value.trim();ta.value=v?(v.replace(/,\s*$/,'')+', '+q):q;syncChips();};
    box.appendChild(b);
  });
})();
const ingsEl=document.getElementById('ings');
ingsEl.addEventListener('input',syncChips);
ingsEl.addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))go(); });
function syncChips(){
  const chips=document.getElementById('chips');
  const items=ingsEl.value.split(/[,\n]+/).map(s=>s.trim()).filter(Boolean);
  chips.innerHTML=items.map(i=>`<span class="chip">${esc(i)}<x onclick="dropChip('${esc(i).replace(/'/g,"")}')">×</x></span>`).join('');
}
function dropChip(name){
  const items=ingsEl.value.split(/[,\n]+/).map(s=>s.trim()).filter(Boolean).filter(i=>i.toLowerCase()!==name.toLowerCase());
  ingsEl.value=items.join(', '); syncChips();
}
window.dropChip=dropChip;
window.addEventListener('hashchange',route);

/* ── helpers ── */
const norm=s=>s.toLowerCase().replace(/[^a-z ]/g,'').trim();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function listHas(list,name){const n=norm(name);return list.some(x=>n.includes(x)||x.includes(n));}
/* word-level matching w/ plural folding — kills the "egg matches eggplant" class of bug */
function words(s){return norm(s).split(' ').filter(w=>w.length>1);}
const singular=w=>w.replace(/ies$/,'y').replace(/(es|s)$/,'');
function wordEq(x,y){return singular(x)===singular(y);}
function userHas(userIngs,name){
  const nw=words(name);
  if(!nw.length) return false;
  return userIngs.some(u=>{
    const uw=words(u);
    return uw.some(x=>nw.some(y=>wordEq(x,y)));
  });
}

/* ════════ deterministic ranking (works on normalized recipe) ════════ */
function scoreRecipe(rec, userIngs){
  const ings=rec.ingredients||[];
  if(!ings.length)return null;

  const have=ings.filter(i=>userHas(userIngs,i.name));
  const missing=ings.filter(i=>!userHas(userIngs,i.name));
  const toBuy=missing.filter(i=>!listHas(STAPLE,i.name));

  const instrTxt=(rec.instructions||[]).join(' ').toLowerCase();
  const hasSteps=instrTxt.length>0;
  const usesOven=OVEN_WORDS.some(w=>instrTxt.includes(w));
  const usesDeepFry=FRY_WORDS.some(w=>instrTxt.includes(w));
  const hasExpensive=ings.some(i=>listHas(EXPENSIVE,i.name));
  const hasMeat=ings.some(i=>listHas(MEAT,i.name));

  // ── hard filters ──
  if(cons.has('vegetarian')&&hasMeat)return null;
  if(cons.has('no-oven')&&usesOven)return null;
  if(cons.has('cold')&&(usesOven||/\b(boil|simmer|fry|saut|cook|heat|bake|roast|grill|steam)\b/.test(instrTxt)))return null;

  // ── heat score 1..3 ──
  let heat=2;                                   // default (Edamam has no steps)
  if(hasSteps){
    heat=1;
    if(/\b(boil|simmer|saut|stir.?fry|pan|heat|steam|cook)\b/.test(instrTxt))heat=2;
    if(usesOven||usesDeepFry||/\b(roast|bake|grill|broil)\b/.test(instrTxt))heat=3;
  }else if(rec.totalTime){
    heat = rec.totalTime<=15?1:rec.totalTime<=40?2:3;
  }

  const haveCount=have.length, buyCount=toBuy.length;
  const coverage=haveCount/ings.length;
  // ── philosophy: "can I cook this NOW?" beats "this uses lots of my stuff" ──
  // coverage (how complete you are) is the star; each thing you must buy hurts.
  let score =
      coverage*55            // 0..55 — the dominant signal
    + haveCount*6            // reward overlap, but secondary to coverage
    - buyCount*9;            // every shopping trip item stings
  if(buyCount===0)   score += 25;   // you can cook this RIGHT NOW — big boost
  if(buyCount===1)   score += 8;
  if(buyCount>=6)    score -= 12;    // giant shopping list — bury it
  if(hasSteps)       score += 8;     // real steps > link-out
  if(ings.length>18) score -= 8;     // 25-ingredient monsters aren't "fridge food"

  // ── mode adjustments ──
  if(mode==='broke'){
    score -= buyCount*6;
    if(hasExpensive)score -= 30;
    score -= (ings.length-6>0?(ings.length-6)*2:0);
  }
  if(mode==='low-heat'){ score -= (heat-1)*14; if(usesOven)score-=25; }
  if(mode==='fast'||mode==='lazy'){
    score -= (heat-1)*8;
    score -= (ings.length>8?(ings.length-8)*2:0);
    if(rec.totalTime){ if(mode==='fast'&&rec.totalTime>15)score-=(rec.totalTime-15); if(mode==='lazy'&&rec.totalTime>20)score-=(rec.totalTime-20)*0.6; }
  }
  if(cons.has('one-pan')&&ings.length>10)score-=8;

  const mins = rec.totalTime || (heat===1?10:heat===2?(ings.length>10?30:20):40);

  return {rec,ings,have,toBuy,heat,score,mins,coverage,hasExpensive,hasMeat,hasSteps};
}

/* ════════ main flow ════════ */
async function go(){
  const raw=ingsEl.value.trim();
  if(!raw){showErr('Tell me what you have first.');return;}
  hideErr();
  document.getElementById('results').innerHTML='';
  document.getElementById('moreWrap').innerHTML='';
  document.getElementById('empty').classList.remove('show');
  setLoad(true,'Sniffing the fridge…');

  try{
    const userIngs=raw.split(/[,\n]+/).map(s=>s.trim()).filter(Boolean);
    userIngsGlobal=userIngs;

    // ── fire BOTH sources in parallel, but ISOLATED ──
    // allSettled = one source dying (e.g. Edamam 429) never rejects the other.
    const mealdbP = poolMap(userIngs.slice(0,6), mealdbByIngredient, 6)
      .then(async sets=>{
        const ids=new Set();
        sets.forEach(s=>Array.isArray(s)&&s.forEach(m=>ids.add(m.idMeal)));
        setLoad(true,`Reading ${ids.size} recipes…`);
        // pooled hydrate (concurrency 8) so we never burst-429 TheMealDB itself
        const meals=await poolMap([...ids].slice(0,40), mealdbLookup, 8);
        return meals.filter(Boolean).map(mealdbNormalise);
      });
    const edamamP = edamamRecipes(userIngs.slice(0,5).join(' '));

    const [mRes, eRes] = await Promise.allSettled([mealdbP, edamamP]);
    const fullMeals  = mRes.status==='fulfilled' ? mRes.value : [];
    const edamamRecs = eRes.status==='fulfilled' ? eRes.value : [];

    // note when a source was rate-limited/unreachable but the other carried
    const mDown = mRes.status!=='fulfilled' || (!fullMeals.length);
    const eDown = edamamOn('recipe') && !edamamRecs.length;

    // merge both normalized sources
    const all=[...fullMeals, ...edamamRecs];
    if(!all.length){setLoad(false);document.getElementById('empty').classList.add('show');return;}

    ranked=all.map(r=>scoreRecipe(r,userIngs)).filter(Boolean).sort((a,b)=>b.score-a.score);

    setLoad(false);
    if(!ranked.length){document.getElementById('empty').classList.add('show');return;}

    window._ff={ranked,userIngs};
    LAST.save(all, userIngs);           // persist for deep-link / refresh
    shown=0;
    renderHead();
    renderMore();
    sourceNote(mDown, eDown, fullMeals.length, edamamRecs.length);
    updateCacheStat();
  }catch(e){
    setLoad(false);
    showErr(e.message||'Something went wrong.');
  }
}

function renderHead(){
  const el=document.getElementById('results');
  const withSteps=ranked.filter(r=>r.hasSteps).length;
  el.innerHTML=`<div class="results-hd"><h2>Here's what you can make</h2><div class="meta">${ranked.length} matched · ${withSteps} with full steps</div></div>`;
}

/* soft notice when one source was rate-limited but the other carried the search.
   Never blocks results — just explains a thinner-than-usual list. */
function sourceNote(mDown, eDown, mCount, eCount){
  const hd=document.querySelector('.results-hd'); if(!hd) return;
  let msg='';
  if(mDown && !eDown) msg=`TheMealDB is rate-limiting right now — showing ${eCount} from Edamam. Try again in a minute for the full spread.`;
  else if(eDown && !mDown && edamamOn('recipe')) msg=`Edamam hit its free-plan limit — showing ${mCount} from TheMealDB (all with full steps). Nutrition returns shortly.`;
  if(!msg) return;
  const n=document.createElement('div');
  n.className='src-note';
  n.innerHTML=`<span class="src-note-i">⚡</span> ${msg}`;
  hd.appendChild(n);
}

function renderMore(){
  const el=document.getElementById('results');
  const slice=ranked.slice(shown,shown+PAGE);
  slice.forEach((r,i)=>el.appendChild(card(r,shown+i)));
  shown+=slice.length;
  const mw=document.getElementById('moreWrap');
  mw.innerHTML = shown<ranked.length
    ? `<button class="more-btn" onclick="renderMore()">Load ${Math.min(PAGE,ranked.length-shown)} more · ${ranked.length-shown} left</button>`
    : '';
}
window.renderMore=renderMore;

function card(r,idx){
  const {rec,ings,have,toBuy,heat,mins}=r;
  const heatPill = heat===1?'<span class="pill p-cold">🟢 No heat</span>'
                 : heat===3?'<span class="pill p-hot">🔴 Oven/fry</span>'
                 : '<span class="pill p-warm">🟡 Light heat</span>';
  const buyLabel = toBuy.length===0?'<span class="pill p-have">✓ got it all</span>'
                 : `<span class="pill p-buy">🛒 buy ${toBuy.length}</span>`;
  const vegPill = !r.hasMeat?'<span class="pill p-veg">🌿 veggie</span>':'';
  const calPill = rec.calories?`<span class="pill p-cal">🔥 ${rec.calories} kcal</span>`:'';
  const img = rec.image ? `<img class="card-img" src="${rec.image}" alt="" loading="lazy" onerror="this.style.opacity=0">` : '';

  const d=document.createElement('div');
  d.className='card';
  d.onclick=()=>{location.hash='#recipe/'+rec.id;};
  d.onmouseenter=()=>prefetch(rec);          // prefetch on hover = instant open
  d.innerHTML=`
    <div class="card-inner">
      <div class="card-img-wrap">
        ${img}
        <div class="card-rank">${idx+1}</div>
      </div>
      <div class="card-body">
        <div class="card-src">${esc(rec.source)}</div>
        <div class="card-name">${esc(rec.title)}</div>
        <div class="pills">
          <span class="pill p-have">✓ have ${have.length}/${ings.length}</span>
          ${buyLabel}${heatPill}
          <span class="pill p-time">⏱ ${mins} min</span>
          ${calPill}${vegPill}
        </div>
      </div>
    </div>`;
  return d;
}

/* ════════ recipe page (hash route) ════════ */
function route(){
  const h=location.hash;
  const lv=document.getElementById('listView');
  const rv=document.getElementById('recipeView');
  if(h.startsWith('#recipe/')){
    const id=decodeURIComponent(h.slice(8));
    lv.classList.add('hide'); rv.classList.add('show');
    openRecipe(id);
  }else{
    lv.classList.remove('hide'); rv.classList.remove('show');
    rv.innerHTML=''; window.scrollTo(0,0);
  }
}

function findScored(id){ return window._ff?.ranked.find(x=>x.rec.id===id); }

/* resolve a recipe id → a scored wrapper, working even after a cold reload.
   Falls back to the persisted last search so Adapt / Original never no-op. */
function resolveScored(id){
  const live=findScored(id);
  if(live) return live;
  const hit=LAST.find(id);
  if(!hit) return null;
  const ui=hit.userIngs?.length?hit.userIngs:(window._ff?.userIngs||userIngsGlobal);
  return scoreRecipe(hit.rec, ui);
}
const _prefetched=new Set();
async function prefetch(rec){
  if(rec.source!=='TheMealDB'||_prefetched.has(rec.id))return;
  _prefetched.add(rec.id);
  mealdbLookup(rec.rawId).catch(()=>{});     // warm the cache
}

async function openRecipe(id){
  const rv=document.getElementById('recipeView');
  rv.innerHTML=`<div class="rp-wrap"><div class="back" onclick="location.hash=''">‹ Back</div><div class="loader show" style="padding:100px 0"><div class="ring"></div><span>Plating up…</span></div></div>`;
  window.scrollTo(0,0);

  let s=findScored(id);
  let rec, ings, have=[], toBuy=[], heat=2, mins=20;
  if(s){({rec,ings,have,toBuy,heat,mins}=s);}
  else {
    // ── cold open (deep-link or refresh): in-memory ranked is gone ──
    // 1) TheMealDB is re-fetchable by id (also refreshes the data)
    if(id.startsWith('md-')){
      const m=await mealdbLookup(id.slice(3)).catch(()=>null);
      if(m) rec=mealdbNormalise(m);
    }
    // 2) fall back to the persisted last search — the ONLY way to recover an
    //    Edamam recipe cold, and a fast path for MealDB if the fetch failed
    let ui = window._ff?.userIngs || userIngsGlobal;
    if(!rec){
      const hit=LAST.find(id);
      if(hit){ rec=hit.rec; if(hit.userIngs?.length) ui=hit.userIngs; }
    }
    if(!rec){rv.innerHTML=`<div class="rp-wrap"><div class="back" onclick="location.hash=''">‹ Back</div><p style="padding:80px 0;text-align:center;color:var(--t3)">Recipe not found. Search again from the home page.</p></div>`;return;}
    // re-score against the ingredients so pills/reason are correct on cold open
    const rs=scoreRecipe(rec, ui);
    if(rs){({ings,have,toBuy,heat,mins}=rs);}
    else{
      ings=rec.ingredients;
      have=ings.filter(i=>userHas(ui,i.name));
      toBuy=ings.filter(i=>!userHas(ui,i.name)&&!listHas(STAPLE,i.name));
    }
  }

  renderRecipe(rec,ings,have,toBuy,heat,mins);
}

function renderRecipe(rec,ings,have,toBuy,heat,mins){
  const rv=document.getElementById('recipeView');
  const heatPill=heat===1?'<span class="pill p-cold">🟢 No heat</span>':heat===3?'<span class="pill p-hot">🔴 Oven/fry</span>':'<span class="pill p-warm">🟡 Light heat</span>';
  const steps = rec.instructions.length ? stepsHTML(rec.instructions)
    : `<div class="rp-reason" style="border-left-color:var(--sky)">This recipe lives on <strong>${esc(rec.source)}</strong>. Full ingredient list is below — tap through for the method.<br><br><a class="adapt-btn" style="display:inline-block;margin-top:4px" href="${rec.url}" target="_blank" rel="noopener">Open full recipe ↗</a></div>`;
  const haveList=have.length?have.map(i=>`<div class="ing-row"><span class="ing-nm">${esc(i.name)}</span><span class="ing-amt">${esc(i.amt)}</span></div>`).join(''):'<div class="ing-none">Nothing matched — check spelling?</div>';
  const buyList=toBuy.length?toBuy.map(i=>`<div class="ing-row"><span class="ing-nm">${esc(i.name)}</span><span class="ing-amt">${esc(i.amt)}</span></div>`).join(''):'<div class="ing-none">Nothing! You have everything 🎉</div>';
  const reason=buildReason(rec,have,toBuy,heat);
  const canAdapt = mode!=='normal' && rec.instructions.length;

  rv.innerHTML=`
  <div class="rp-wrap">
    <div class="back" onclick="location.hash=''">‹ Back to results</div>
    <div class="rp-hero">
      ${rec.image?`<img src="${rec.image}" alt="${esc(rec.title)}" onerror="this.style.display='none'">`:''}
      <div class="rp-hero-grad"></div>
      <div class="rp-hero-content">
        <div class="rp-src">${esc(rec.source)}${rec.area?' · '+esc(rec.area):''}</div>
        <h1>${esc(rec.title)}</h1>
        <div class="rp-pills">
          ${heatPill}
          <span class="pill p-time">⏱ ${mins} min</span>
          <span class="pill p-have">✓ have ${have.length}/${ings.length}</span>
          ${toBuy.length?`<span class="pill p-buy">🛒 buy ${toBuy.length}</span>`:'<span class="pill p-have">✓ got it all</span>'}
        </div>
      </div>
    </div>
    <div class="rp-body">
      <div class="rp-sec"><div class="rp-reason">${reason}</div></div>

      <div class="rp-sec" id="nutriSec">${hasNutrition(rec)?nutriHTML(rec):''}</div>

      <div class="rp-sec">
        <div class="rp-sec-label">🛒 Shopping reality</div>
        <div class="split">
          <div class="split-col have"><h4>✓ You already have (${have.length})</h4>${haveList}</div>
          <div class="split-col buy"><h4>🛒 You'd need to buy (${toBuy.length})</h4>${buyList}</div>
        </div>
      </div>

      ${canAdapt?`<div class="adapt-bar" id="adaptBar">
        <div class="txt">✨ <strong>${adaptLabel()}</strong> — rewrite the steps for how you actually cook</div>
        <button class="adapt-btn" onclick="adapt('${rec.id}')">Adapt steps →</button>
      </div>`:''}

      <div class="rp-sec">
        <div class="rp-sec-label">👩‍🍳 Method</div>
        <div id="stepsBox">${steps}</div>
      </div>

      ${rec.dietLabels?.length||rec.healthLabels?.length?`<div class="rp-sec">
        <div class="rp-sec-label">🏷 Labels</div>
        <div class="diet-labels">${[...(rec.dietLabels||[]),...(rec.healthLabels||[]).slice(0,8)].map(l=>`<span class="diet-lbl">${esc(l)}</span>`).join('')}</div>
      </div>`:''}

      <div class="rp-links">
        ${rec.url?`<a class="rp-link" href="${rec.url}" target="_blank" rel="noopener">↗ Original recipe</a>`:''}
        ${rec.video?`<a class="rp-link" href="${rec.video}" target="_blank" rel="noopener">▶ Watch video</a>`:''}
        <span class="rp-link">📖 via ${esc(rec.source)}</span>
      </div>
    </div>
  </div>`;
}

/* nutrition comes embedded in Edamam Recipe Search (35 nutrients, no extra call).
   TheMealDB has no nutrition data — we simply don't show the panel there,
   rather than invent numbers. Honest > complete. */
function hasNutrition(rec){
  const n=rec.nutrition;
  return !!(n && (n.kcal||n.protein||n.carbs||n.fat));
}
function nutriHTML(rec){
  const n=rec.nutrition||{};
  const cell=(v,lbl,unit='')=>`<div class="nutri-cell"><div class="nutri-val">${v??'—'}${v!=null&&unit?`<span class="nutri-u">${unit}</span>`:''}</div><div class="nutri-lbl">${lbl}</div></div>`;
  return `<div class="rp-sec-label">🔬 Nutrition <span class="rp-sec-note">· per serving · via Edamam</span></div>
  <div class="nutri">
    ${cell(n.kcal,'kcal')}
    ${cell(n.protein,'protein','g')}
    ${cell(n.carbs,'carbs','g')}
    ${cell(n.fat,'fat','g')}
  </div>`;
}

function buildReason(rec,have,toBuy,heat){
  const bits=[];
  if(have.length) bits.push(`Uses <strong>${have.map(i=>i.name).join(', ')}</strong> from your fridge`);
  if(toBuy.length===0) bits.push(`and you already have everything else`);
  else bits.push(`you'd just grab ${toBuy.length} more item${toBuy.length>1?'s':''}`);
  const heatTxt=heat===1?'No real cooking heat needed':heat===2?'Just light stovetop work':'Needs the oven or heavy frying';
  return bits.join(', ')+'. '+heatTxt+'.';
}

function stepsHTML(steps){
  return `<ol class="steps">${steps.map(s=>`<li class="step"><span class="step-n">→</span><span>${esc(s)}</span></li>`).join('')}</ol>`;
}

/* ════════ LLM: step adaptation ONLY ════════ */
async function llm(prompt,maxTok=600){
  const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{'Authorization':`Bearer ${OR_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://fridgefox.app','X-Title':'FridgeFox'},
    body:JSON.stringify({model:OR_MODEL,messages:[{role:'user',content:prompt}],max_tokens:maxTok,temperature:.3})
  });
  if(!r.ok){const t=await r.text().catch(()=>'');throw new Error(`OpenRouter ${r.status}: ${t.slice(0,100)}`);}
  const j=await r.json();
  return (j.choices?.[0]?.message?.content||'').trim();
}
function adaptLabel(){return {'low-heat':'Low-heat mode','autism':'Clear steps mode','broke':'Broke mode','lazy':'Lazy mode','fast':'Fast mode'}[mode]||'';}

async function adapt(id){
  const s=resolveScored(id); const rec=s?.rec;
  if(!rec)return;
  const bar=document.getElementById('adaptBar');
  const box=document.getElementById('stepsBox');
  bar.innerHTML=`<div class="adapting"><div class="mini-ring"></div>Rewriting for ${mode} mode…</div>`;
  const prompts={
    'low-heat':'Rewrite these steps to minimise heat. Start each step with [NO HEAT], [LIGHT HEAT], or [HEAT NEEDED]. Suggest microwave or cold alternatives where sensible.',
    'autism':'Rewrite as numbered steps. Use exact times (say "3 minutes" not "a few minutes"). Each step does ONE action. No vague words like "until done" — give a concrete visible sign. No flowery language.',
    'broke':'Rewrite focusing on saving money. Mark expensive ingredients optional, suggest cheap substitutes. Keep it simple.',
    'lazy':'Rewrite for laziness. Combine steps, skip garnishes and flourishes, note anything skippable.',
    'fast':'Rewrite for speed under 15 min. Note which steps run in parallel while something cooks. Time each step.'
  };
  try{
    const res=await llm(`Recipe: ${rec.title}\n\nOriginal steps:\n${rec.instructions.join('\n')}\n\n${prompts[mode]}\n\nReturn ONLY a numbered list of steps. No intro, no outro.`);
    if(!res){bar.innerHTML=`<div class="txt" style="color:#fb7185">Model returned nothing. Try again.</div><button class="adapt-btn" onclick="adapt('${id}')">Retry</button>`;return;}
    const lines=res.split('\n').map(l=>l.replace(/^\s*\d+[\.\)]\s*/,'').trim()).filter(l=>l.length>3);
    box.innerHTML=stepsHTML(lines);
    bar.innerHTML=`<div class="txt">✨ Steps rewritten for <strong>${mode}</strong> mode</div><button class="adapt-btn" onclick="renderRecipeReset('${id}')">↺ Original</button>`;
  }catch(e){
    bar.innerHTML=`<div class="txt" style="color:#fb7185">Failed: ${esc(e.message)}</div><button class="adapt-btn" onclick="adapt('${id}')">Retry</button>`;
  }
}
window.adapt=adapt;
function renderRecipeReset(id){ const s=resolveScored(id); if(s) renderRecipe(s.rec,s.ings,s.have,s.toBuy,s.heat,s.mins); }
window.renderRecipeReset=renderRecipeReset;

/* ── util ── */
function setLoad(on,txt){document.getElementById('loader').classList.toggle('show',on);if(txt)document.getElementById('loaderTxt').textContent=txt;document.getElementById('cta').disabled=on;}
function showErr(m){const e=document.getElementById('err');e.textContent=m;e.classList.add('show');}
function hideErr(){document.getElementById('err').classList.remove('show');}
function updateCacheStat(){const el=document.getElementById('cacheStat');if(el)el.textContent=`${CACHE.stats().entries} cached`;}
document.getElementById('edamamCredit').innerHTML = edamamOn('recipe')?'+ <a href="https://www.edamam.com" target="_blank" rel="noopener">Edamam</a>':'';

/* deep-link honour on load */
route();
updateCacheStat();
