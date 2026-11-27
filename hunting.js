'use strict';
const API = 'https://api.apify.com/v2';
const pause = ms => new Promise(r => setTimeout(r, ms));
const s = v => typeof v === 'string' ? v.trim() : '';
const n = v => { if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v !== 'string') return null; const x = Number(v.replace(/[^0-9.]/g,'')); return Number.isFinite(x) && x > 0 ? x : null; };
function normalize(x) {
  const country = s(x.country || x.marketplace).toLowerCase();
  return {
    id:String(x.id || x.itemId || x.productId || x.skuId || '').trim(),
    url:s(x.url || x.productUrl || x.product_url), title:s(x.title || x.name || x.productName),
    price:n(x.price ?? x.salePrice ?? x.currentPrice), original:n(x.originalPrice ?? x.listPrice),
    currency:s(x.currency) || 'PKR',
    marketplace:country.includes('bd') ? 'daraz.com.bd' : country.includes('lk') ? 'daraz.lk' : country.includes('np') ? 'daraz.com.np' : 'daraz.pk',
    brand:s(x.brand), seller:s(x.sellerName || x.seller), rating:n(x.rating),
    reviews:n(x.reviewCount ?? x.reviews), sold:n(x.soldCount ?? x.unitsSold),
    image:s(x.imageUrl || x.image || (Array.isArray(x.images) ? x.images[0] : '')),
    stock:x.inStock !== false, raw:x
  };
}
function isDarazUrl(value) { try { const u=new URL(value); return u.protocol==='https:' && /(^|\.)daraz\.(pk|lk|com\.bd|com\.np)$/.test(u.hostname); } catch { return false; } }
function score(p) {
  let v = p.price ? 25 : 0;
  if (p.rating !== null) v += Math.min(20, p.rating * 4);
  if (p.reviews !== null) v += Math.min(10, Math.log10(p.reviews + 1) * 5);
  if (p.sold !== null) v += Math.min(15, Math.log10(p.sold + 1) * 5);
  if (p.stock) v += 5;
  if (p.original && p.price && p.original > p.price) { const d = (p.original-p.price)/p.original*100; if (d <= 70) v += Math.min(15,d*.25); }
  return Math.round(Math.min(100,v));
}
async function apify(path, token, options={}) {
  const r = await fetch(API + path + (path.includes('?')?'&':'?') + 'token=' + encodeURIComponent(token), {
    ...options, headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  const raw = await r.text(); let data={};
  try { data=raw ? JSON.parse(raw) : {}; } catch { data={message:raw.slice(0,300)}; }
  if (!r.ok) throw new Error(data.error?.message || data.message || ('Apify HTTP '+r.status));
  return data;
}
async function scrape(input, cfg) {
  const actor = encodeURIComponent((cfg.actorId || 'scrapewise~daraz-scraper').replace('/','~'));
  const started = await apify('/acts/'+actor+'/runs',cfg.apifyToken,{method:'POST',body:JSON.stringify(input)});
  let run=started.data;
  if (!run || !run.id) throw new Error('Apify did not return a run ID.');
  const deadline=Date.now()+480000;
  while (Date.now()<deadline && !['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(run.status)) {
    await pause(2500);
    const status=await apify('/actor-runs/'+encodeURIComponent(run.id),cfg.apifyToken);
    run=status.data || status;
  }
  if (run.status!=='SUCCEEDED') throw new Error('Apify run '+(run.status || 'timed out')+(run.statusMessage ? ': '+run.statusMessage : ''));
  const items=await apify('/datasets/'+encodeURIComponent(run.defaultDatasetId)+'/items?clean=true&format=json&limit='+cfg.limit,cfg.apifyToken);
  return {runId:run.id,items:Array.isArray(items)?items:[]};
}
async function aiReview(products,cfg) {
  if (!products.length || (!cfg.geminiKey && !cfg.groqKey)) return {provider:'disabled',notes:[]};
  const compact=products.slice(0,10).map((p,i)=>({index:i,title:p.title,brand:p.brand,price:p.price,originalPrice:p.original,rating:p.rating,reviews:p.reviews,sold:p.sold,score:p.score}));
  const prompt='Review these product candidates. Do not invent facts or historical prices. Return JSON {"notes":[{"index":0,"risk":"low|medium|high","reason":"short"}]}. Candidates: '+JSON.stringify(compact);
  try {
    if (!cfg.geminiKey) throw new Error('Gemini key missing');
    const model=cfg.geminiModel || 'gemini-2.5-flash';
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(cfg.geminiKey),{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.2,responseMimeType:'application/json'}})
    });
    const d=await r.json(); if(!r.ok) throw new Error(d.error?.message || 'Gemini request failed');
    const out=d.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('') || '{}';
    return {provider:'gemini',...JSON.parse(out)};
  } catch (primaryError) {
    if (!cfg.groqKey) return {provider:'unavailable',notes:[],warning:primaryError.message};
    try {
      const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.groqKey},
        body:JSON.stringify({model:cfg.groqModel || 'llama-3.3-70b-versatile',temperature:.2,response_format:{type:'json_object'},messages:[
          {role:'system',content:'Analyze product data. Never invent facts or historical prices. Return JSON only.'},
          {role:'user',content:prompt}
        ]})
      });
      const d=await r.json(); if(!r.ok) throw new Error(d.error?.message || 'Groq request failed');
      return {provider:'groq',...JSON.parse(d.choices?.[0]?.message?.content || '{}')};
    } catch (e) { return {provider:'unavailable',notes:[],warning:e.message}; }
  }
}
function createHuntingEngine({db,config}) {
  let active=null,last=null,ready=false;
  async function ensure() {
    if (ready) return;
    await db.execute('CREATE TABLE IF NOT EXISTS hunt_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,mode TEXT NOT NULL,query TEXT,target_count INTEGER NOT NULL,status TEXT NOT NULL,found_count INTEGER DEFAULT 0,saved_count INTEGER DEFAULT 0,ai_provider TEXT,error TEXT,started_at TEXT DEFAULT CURRENT_TIMESTAMP,finished_at TEXT)');
    for (const col of ['brand TEXT','rating REAL','review_count INTEGER','sold_count INTEGER','seller_name TEXT','image_url TEXT','deal_score REAL','source_data TEXT']) {
      try { await db.execute('ALTER TABLE products ADD COLUMN '+col); }
      catch(e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    ready=true;
  }
  async function save(items) {
    let saved=0;
    for (const p of items) {
      if (!p.id || !p.url || !p.title || !p.price) continue;
      const q=await db.execute({sql:'SELECT id,current_price FROM products WHERE marketplace=? AND external_id=? LIMIT 1',args:[p.marketplace,p.id]});
      if (q.rows.length) {
        const id=Number(q.rows[0].id), old=Number(q.rows[0].current_price);
        await db.execute({sql:'UPDATE products SET url=?,title=?,currency=?,current_price=?,updated_at=CURRENT_TIMESTAMP,brand=?,rating=?,review_count=?,sold_count=?,seller_name=?,image_url=?,deal_score=?,source_data=? WHERE id=?',args:[p.url,p.title,p.currency,p.price,p.brand||null,p.rating,p.reviews,p.sold,p.seller||null,p.image||null,p.score,JSON.stringify(p.raw),id]});
        if (old!==p.price) await db.execute({sql:'INSERT INTO price_history(product_id,price) VALUES(?,?)',args:[id,p.price]});
      } else {
        const r=await db.execute({sql:'INSERT INTO products(marketplace,external_id,url,title,currency,current_price,brand,rating,review_count,sold_count,seller_name,image_url,deal_score,source_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',args:[p.marketplace,p.id,p.url,p.title,p.currency,p.price,p.brand||null,p.rating,p.reviews,p.sold,p.seller||null,p.image||null,p.score,JSON.stringify(p.raw)]});
        await db.execute({sql:'INSERT INTO price_history(product_id,price) VALUES(?,?)',args:[Number(r.lastInsertRowid),p.price]});
      }
      saved++;
    }
    return saved;
  }
  async function hunt({mode,keyword,targetCount}) {
    if (active) throw new Error('A hunt is already running.');
    if (!config.apifyToken) throw new Error('APIFY_TOKEN is not configured.');
    if (!db) throw new Error('Turso database is not configured.');
    await ensure();
    const count=Math.max(1,Math.min(50,Number(targetCount)||5));
    const m=mode==='manual'?'manual':'auto', query=m==='manual'?s(keyword):'electronics demand discovery';
    if (m==='manual' && !query) throw new Error('Enter a keyword for Manual Hunt.');
    const seeds=config.autoKeywords || ['smartphone','wireless earbuds','power bank','smart watch','laptop','bluetooth speaker','computer monitor','gaming mouse','keyboard','wifi router','air fryer','electric kettle','security camera','SSD','tablet'];
    active={mode:m,query,targetCount:count,status:'running',startedAt:new Date().toISOString()}; last=active;
    try {
      const rec=await db.execute({sql:'INSERT INTO hunt_runs(mode,query,target_count,status) VALUES(?,?,?,?)',args:[m,query,count,'running']});
      active.id=Number(rec.lastInsertRowid);
      const keywords=m==='manual'?[query]:seeds.slice(0,Math.min(seeds.length,Math.max(3,Math.ceil(count/2))));
      const limit=Math.min(50,Math.max(count*8,15));
      const result=await scrape({country:'pk',keywords,maxItems:limit,includeDetails:true,onlyNew:false},{...config,limit});
      const unique=new Map();
      for (const raw of result.items) { const p=normalize(raw); if(p.id&&isDarazUrl(p.url)&&p.title&&p.price&&p.stock) unique.set(p.marketplace+':'+p.id,p); }
      const products=[...unique.values()];
      const modelGroups=new Map();
      for (const p of products) {
        const key=(p.brand+' '+p.title).toLowerCase()
          .replace(/\b(black|white|blue|red|green|pink|purple|silver|gold|grey|gray|beige|brown|navy)\b/g,' ')
          .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
        if(!modelGroups.has(key)) modelGroups.set(key,[]);
        modelGroups.get(key).push(p);
      }
      products.forEach(p=>{
        const peers=modelGroups.get((p.brand+' '+p.title).toLowerCase()
          .replace(/\b(black|white|blue|red|green|pink|purple|silver|gold|grey|gray|beige|brown|navy)\b/g,' ')
          .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()) || [];
        const peerPrices=peers.map(x=>x.price).filter(Boolean);
        p.comparableCount=peers.length;
        p.bestObservedPrice=peerPrices.length?Math.min(...peerPrices):p.price;
        p.score=score(p)+(peerPrices.length>1&&p.price===p.bestObservedPrice?10:0);
        p.score=Math.min(100,p.score);
      });
      products.sort((a,b)=>b.score-a.score || (a.price||Infinity)-(b.price||Infinity));
      const ai=await aiReview(products,config), chosen=products.slice(0,count), saved=await save(chosen);
      Object.assign(active,{status:'completed',foundCount:products.length,savedCount:saved,aiProvider:ai.provider,aiNotes:ai.notes||[],apifyRunId:result.runId,products:chosen.map(p=>({title:p.title,price:p.price,currency:p.currency,url:p.url,score:p.score,rating:p.rating,sold:p.sold,brand:p.brand,image:p.image}))});
      await db.execute({sql:"UPDATE hunt_runs SET status='completed',found_count=?,saved_count=?,ai_provider=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",args:[products.length,saved,ai.provider,active.id]});
      return active;
    } catch(e) {
      Object.assign(active,{status:'failed',error:e.message,finishedAt:new Date().toISOString()});
      await db.execute({sql:"UPDATE hunt_runs SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",args:[e.message,active.id]}).catch(()=>{});
      throw e;
    } finally { active=null; }
  }
  async function data() {
    await ensure();
    const [p,r]=await Promise.all([
      db.execute('SELECT id,marketplace,external_id,url,title,currency,current_price,brand,rating,review_count,sold_count,seller_name,image_url,deal_score,updated_at FROM products ORDER BY deal_score DESC,updated_at DESC LIMIT 50'),
      db.execute('SELECT * FROM hunt_runs ORDER BY id DESC LIMIT 15')
    ]);
    return {products:p.rows,runs:r.rows};
  }
  return {hunt,data,status:()=>({running:!!active,activeJob:active,lastJob:last}),ensure};
}
module.exports={createHuntingEngine,normalize,score};
