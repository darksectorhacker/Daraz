'use strict';
const {searchMany,isAllowedProductUrl}=require('./playwright-hunter');
const s=v=>typeof v==='string'?v.trim():'';
const n=v=>{if(typeof v==='number'&&Number.isFinite(v))return v;if(typeof v!=='string')return null;const x=Number(v.replace(/[^0-9.]/g,''));return Number.isFinite(x)&&x>0?x:null;};
function normalize(x){return{id:String(x.id||'').trim(),url:s(x.url),title:s(x.title),price:n(x.price),original:n(x.originalPrice),currency:s(x.currency)||'PKR',marketplace:'daraz.pk',brand:s(x.brand),seller:s(x.sellerName),rating:n(x.rating),reviews:n(x.reviewCount),sold:n(x.soldCount),image:s(x.imageUrl),stock:x.inStock!==false,raw:x};}
function score(p){let v=p.price?25:0;if(p.rating!==null)v+=Math.min(20,p.rating*4);if(p.reviews!==null)v+=Math.min(10,Math.log10(p.reviews+1)*5);if(p.sold!==null)v+=Math.min(15,Math.log10(p.sold+1)*5);if(p.stock)v+=5;if(p.original&&p.price&&p.original>p.price){const d=(p.original-p.price)/p.original*100;if(d<=70)v+=Math.min(15,d*.25);}return Math.round(Math.min(100,v));}
async function aiReview(products,cfg){
 if(!products.length||(!cfg.geminiKey&&!cfg.groqKey))return{provider:'disabled',notes:[]};
 const compact=products.slice(0,10).map((p,index)=>({index,title:p.title,price:p.price,originalPrice:p.original,rating:p.rating,reviews:p.reviews,sold:p.sold,score:p.score}));
 const prompt='Review collected product candidates. Never invent facts, sales, discounts or historical prices. Return JSON {"notes":[{"index":0,"risk":"low|medium|high","reason":"short"}]}. Candidates: '+JSON.stringify(compact);
 try{
  if(!cfg.geminiKey)throw new Error('Gemini key missing');
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(cfg.geminiModel||'gemini-2.5-flash')+':generateContent?key='+encodeURIComponent(cfg.geminiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.2,responseMimeType:'application/json'}})});
  const d=await r.json();if(!r.ok)throw new Error(d.error?.message||'Gemini request failed');
  return{provider:'gemini',...JSON.parse(d.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'{}')};
 }catch(primary){
  if(!cfg.groqKey)return{provider:'unavailable',notes:[],warning:primary.message};
  try{
   const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.groqKey},body:JSON.stringify({model:cfg.groqModel||'llama-3.3-70b-versatile',temperature:.2,response_format:{type:'json_object'},messages:[{role:'system',content:'Analyze product data. Never invent facts or historical prices. Return JSON only.'},{role:'user',content:prompt}]})});
   const d=await r.json();if(!r.ok)throw new Error(d.error?.message||'Groq request failed');
   return{provider:'groq',...JSON.parse(d.choices?.[0]?.message?.content||'{}')};
  }catch(e){return{provider:'unavailable',notes:[],warning:e.message};}
 }
}
function createHuntingEngine({db,config={}}){
 let active=null,last=null,ready=false,readyPromise=null;
 async function ensure(){
  if(!db)throw new Error('Turso database is not configured.');
  if(ready)return;if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
   await db.execute('CREATE TABLE IF NOT EXISTS hunt_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,mode TEXT NOT NULL,query TEXT,target_count INTEGER NOT NULL,status TEXT NOT NULL,found_count INTEGER DEFAULT 0,saved_count INTEGER DEFAULT 0,ai_provider TEXT,error TEXT,started_at TEXT DEFAULT CURRENT_TIMESTAMP,finished_at TEXT)');
   for(const col of ['brand TEXT','rating REAL','review_count INTEGER','sold_count INTEGER','seller_name TEXT','image_url TEXT','deal_score REAL','comparable_count INTEGER','best_observed_price REAL','source_data TEXT']){
    try{await db.execute('ALTER TABLE products ADD COLUMN '+col);}catch(e){if(!/duplicate column/i.test(e.message))throw e;}
   }ready=true;
  })();
  try{await readyPromise;}catch(e){readyPromise=null;throw e;}
 }
 function comparisonKey(title){return s(title).toLowerCase().replace(/\\b(black|white|blue|red|green|pink|purple|silver|gold|grey|gray|beige|brown|navy)\\b/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\\s+/g,' ').trim();}\n async function save(rows){
  let saved=0;
  for(const p of rows){
   if(!p.id||!isAllowedProductUrl(p.url)||!p.title||!p.price)continue;
   const old=await db.execute({sql:'SELECT id,current_price FROM products WHERE marketplace=? AND external_id=? LIMIT 1',args:[p.marketplace,p.id]});
   if(old.rows.length){
    const id=Number(old.rows[0].id),oldPrice=Number(old.rows[0].current_price);
    await db.execute({sql:'UPDATE products SET url=?,title=?,currency=?,current_price=?,updated_at=CURRENT_TIMESTAMP,brand=?,rating=?,review_count=?,sold_count=?,seller_name=?,image_url=?,deal_score=?,comparable_count=?,best_observed_price=?,source_data=? WHERE id=?',args:[p.url,p.title,p.currency,p.price,p.brand||null,p.rating,p.reviews,p.sold,p.seller||null,p.image||null,p.score,p.comparableCount,p.bestObservedPrice,JSON.stringify(p.raw),id]});
    if(oldPrice!==p.price)await db.execute({sql:'INSERT INTO price_history(product_id,price) VALUES(?,?)',args:[id,p.price]});
   }else{
    const ins=await db.execute({sql:'INSERT INTO products(marketplace,external_id,url,title,currency,current_price,brand,rating,review_count,sold_count,seller_name,image_url,deal_score,comparable_count,best_observed_price,source_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',args:[p.marketplace,p.id,p.url,p.title,p.currency,p.price,p.brand||null,p.rating,p.reviews,p.sold,p.seller||null,p.image||null,p.score,p.comparableCount,p.bestObservedPrice,JSON.stringify(p.raw)]});
    // First observation is the baseline; no earlier discount is fabricated.
    await db.execute({sql:'INSERT INTO price_history(product_id,price) VALUES(?,?)',args:[Number(ins.lastInsertRowid),p.price]});
   }saved++;
  }return saved;
 }
 async function hunt({mode,keyword,targetCount}){
  if(active)throw new Error('A hunt is already running.');
  await ensure();
  if(active)throw new Error('A hunt is already running.');
  const count=Math.max(1,Math.min(50,Number(targetCount)||5)),m=mode==='manual'?'manual':'auto';
  const query=m==='manual'?s(keyword).slice(0,100):'electronics product discovery';
  if(m==='manual'&&!query)throw new Error('Enter a keyword for Manual Hunt.');
  const seeds=config.autoKeywords||['smartphone','wireless earbuds','power bank','smart watch','laptop','bluetooth speaker','computer monitor','gaming mouse','keyboard','wifi router','air fryer','electric kettle','security camera','SSD','tablet'];
  const keywords=m==='manual'?[query]:seeds.slice(0,Math.min(5,Math.max(3,Math.ceil(count/10))));
  const maxProducts=Math.min(50,Math.max(count*4,15));
  active={mode:m,query,targetCount:count,status:'running',startedAt:new Date().toISOString()};last=active;
  let runId=null;
  try{
   const run=await db.execute({sql:'INSERT INTO hunt_runs(mode,query,target_count,status) VALUES(?,?,?,?)',args:[m,query,count,'running']});
   runId=Number(run.lastInsertRowid);active.id=runId;
   const collected=await searchMany(keywords,{maxProducts}),map=new Map();
   for(const raw of collected.products){const p=normalize(raw);if(p.id&&isAllowedProductUrl(p.url)&&p.title&&p.price)map.set(p.marketplace+':'+p.id,p);}
   const products=[...map.values()];
   const groups=new Map();
   for(const p of products){const key=comparisonKey(p.title);if(key){if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}}
   for(const p of products){
    const peers=groups.get(comparisonKey(p.title))||[];
    p.comparableCount=peers.length;
    p.bestObservedPrice=peers.length>1?Math.min(...peers.map(x=>x.price)):null;
    p.score=score(p);
   }
   products.sort((a,b)=>b.score-a.score||a.price-b.price);
   const chosen=products.slice(0,count),ai=await aiReview(chosen,config),saved=await save(chosen);
   Object.assign(active,{status:'completed',foundCount:products.length,savedCount:saved,aiProvider:ai.provider,aiNotes:ai.notes||[],collectionWarnings:collected.errors,products:chosen.map(p=>({title:p.title,price:p.price,currency:p.currency,url:p.url,score:p.score,rating:p.rating,sold:p.sold,brand:p.brand,image:p.image}))});
   await db.execute({sql:"UPDATE hunt_runs SET status='completed',found_count=?,saved_count=?,ai_provider=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",args:[products.length,saved,ai.provider,runId]});
   return active;
  }catch(e){
   Object.assign(active,{status:'failed',error:e.message,finishedAt:new Date().toISOString()});
   if(runId)await db.execute({sql:"UPDATE hunt_runs SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",args:[e.message,runId]}).catch(()=>{});
   throw e;
  }finally{active=null;}
 }
 async function data(){
  await ensure();
  const [p,r]=await Promise.all([
   db.execute('SELECT id,marketplace,external_id,url,title,currency,current_price,brand,rating,review_count,sold_count,seller_name,image_url,deal_score,comparable_count,best_observed_price,updated_at FROM products ORDER BY deal_score DESC,updated_at DESC LIMIT 50'),
   db.execute('SELECT * FROM hunt_runs ORDER BY id DESC LIMIT 15')
  ]);return{products:p.rows,runs:r.rows};
 }
 return{hunt,data,status:()=>({running:Boolean(active),activeJob:active,lastJob:last}),ensure};
}
module.exports={createHuntingEngine,normalize,score};
