/* ════════════════════════════════════════════════
   FridgeFox — data sources
   Normalises TheMealDB + Edamam into ONE recipe shape:
   {
     id, source, title, image, category, area,
     ingredients:[{name, amt}], instructions:[str],
     url, video, yield, calories, dietLabels, healthLabels
   }
   ════════════════════════════════════════════════ */

/* ---------- TheMealDB ---------- */
async function mealdbByIngredient(ing){
  const url = `${MEALDB}/filter.php?i=${encodeURIComponent(ing)}`;
  try{ const j = await cachedJSON(url); return Array.isArray(j.meals)?j.meals:[]; }
  catch{ return []; }
}
async function mealdbLookup(id){
  const url = `${MEALDB}/lookup.php?i=${id}`;
  try{ const j = await cachedJSON(url); return j.meals?.[0]??null; }
  catch{ return null; }
}
function mealdbNormalise(m){
  const ings=[];
  for(let i=1;i<=20;i++){
    const n=(m[`strIngredient${i}`]||'').trim();
    const a=(m[`strMeasure${i}`]||'').trim();
    if(n) ings.push({name:n, amt:a});
  }
  const instr=(m.strInstructions||'')
    .replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .split(/\n+|(?<=\.)\s{2,}/).map(s=>s.trim()).filter(s=>s.length>8);
  return {
    id:'md-'+m.idMeal, rawId:m.idMeal, source:'TheMealDB',
    title:m.strMeal, image:m.strMealThumb,
    category:m.strCategory||'', area:m.strArea||'',
    ingredients:ings, instructions:instr,
    url:m.strSource||'', video:m.strYoutube||'',
    servings:null, calories:null, dietLabels:[], healthLabels:[]
  };
}

/* ---------- Edamam Recipe Search v2 ---------- */
async function edamamRecipes(query, opts={}){
  if(!edamamOn('recipe')) return [];
  const e=EDAMAM.recipe;
  const p=new URLSearchParams({type:'public', q:query, app_id:e.id, app_key:e.key});
  if(opts.health) opts.health.forEach(h=>p.append('health',h));
  if(opts.diet)   opts.diet.forEach(d=>p.append('diet',d));
  if(opts.maxTime) p.append('time',`0-${opts.maxTime}`);
  // NOTE: the free Recipe Search plan returns 0 hits when `field` is set — leave it off.
  const url=`${e.base}?${p}`;
  try{
    const j=await cachedJSON(url);
    return (j.hits||[]).map(h=>edamamNormalise(h.recipe));
  }catch(err){ console.warn('Edamam recipe fail',err.message); return []; }
}
function edamamNormalise(r){
  const id=(r.uri||'').split('#recipe_')[1]||Math.random().toString(36).slice(2);
  const ings=(r.ingredients||[]).map(i=>({
    name:i.food||i.text, amt:i.quantity?`${round1(i.quantity)} ${i.measure||''}`.trim():(i.text||'')
  }));
  // Edamam gives ingredientLines (human strings) but no step instructions — link out
  const yld=r.yield||1;
  const perServe=k=>{const v=r.totalNutrients?.[k];return v?Math.round(v.quantity/yld):null;};
  return {
    id:'ed-'+id, rawId:id, source:r.source||'Edamam',
    title:r.label, image:r.image,
    category:(r.dishType||[])[0]||'', area:(r.cuisineType||[])[0]||'',
    ingredients:ings, ingredientLines:r.ingredientLines||[],
    instructions:[],                                   // Edamam = external, no steps
    url:r.url||'', video:'',
    servings:r.yield||null,
    calories:r.calories?Math.round(r.calories/(r.yield||1)):null,
    totalTime:r.totalTime||null,
    nutrition:{                                        // per-serving, from embedded totalNutrients
      kcal:r.calories?Math.round(r.calories/yld):null,
      protein:perServe('PROCNT'), carbs:perServe('CHOCDF'),
      fat:perServe('FAT'), fiber:perServe('FIBTG')
    },
    dietLabels:r.dietLabels||[], healthLabels:r.healthLabels||[]
  };
}

/* ---------- Edamam Nutrition (per recipe, on demand) ---------- */
async function edamamNutrition(ingrLines){
  if(!edamamOn('nutrition')||!ingrLines?.length) return null;
  const e=EDAMAM.nutrition;
  const p=new URLSearchParams({app_id:e.id, app_key:e.key, 'nutrition-type':'cooking'});
  ingrLines.slice(0,20).forEach(l=>p.append('ingr',l));
  const url=`${e.base}?${p}`;
  try{
    const j=await cachedJSON(url);
    return {
      calories:j.calories,
      yield:j.yield,
      dietLabels:j.dietLabels||[],
      healthLabels:j.healthLabels||[],
      totalNutrients:j.totalNutrients||{}
    };
  }catch{ return null; }
}

/* ---------- Edamam Food DB (ingredient autocomplete/info) ---------- */
async function edamamFood(ingr){
  if(!edamamOn('food')) return null;
  const e=EDAMAM.food;
  const url=`${e.base}/parser?ingr=${encodeURIComponent(ingr)}&app_id=${e.id}&app_key=${e.key}`;
  try{
    const j=await cachedJSON(url);
    const f=j.parsed?.[0]?.food||j.hints?.[0]?.food;
    if(!f) return null;
    return { name:f.label, cal100:f.nutrients?.ENERC_KCAL||null, category:f.category||'' };
  }catch{ return null; }
}

const round1=n=>Math.round(n*10)/10;
