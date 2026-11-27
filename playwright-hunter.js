'use strict';
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
const { chromium } = require('playwright');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const productPattern = /-i(\d+)(?:-s\d+)?\.html?(?:$|[?#])/i;

function isAllowedProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['daraz.pk','www.daraz.pk'].includes(url.hostname) &&
      productPattern.test(url.pathname + url.search);
  } catch { return false; }
}

async function extractProducts(page, keyword) {
  return page.evaluate(({ keyword }) => {
    const results = [], seen = new Set();
    for (const anchor of document.querySelectorAll('a[href*="-i"]')) {
      let url;
      try { url = new URL(anchor.getAttribute('href') || '', location.origin).href; }
      catch { continue; }
      if (!/^https:\/\/(www\.)?daraz\.pk\//i.test(url) ||
          !/-i\d+(?:-s\d+)?\.html?(?:$|[?#])/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      let card = anchor;
      for (let i=0; i<5 && card.parentElement; i++) {
        const t=(card.innerText||'').trim();
        if (t.length>15 && t.length<1800 && (/(?:Rs\.?|PKR)\s*[\d,]+/i.test(t) || card.querySelector('[class*="price"],[data-price]'))) break;
        card=card.parentElement;
      }
      const text=(card.innerText||anchor.innerText||'').replace(/\s+/g,' ').trim();
      const img=card.querySelector('img');
      const title=(anchor.getAttribute('title')||img?.getAttribute('alt')||anchor.innerText||'').replace(/\s+/g,' ').trim();
      const priceNode=card.querySelector('[class*="ooOxS"],[class*="c13VH6"],[class*="price"],[data-price]');
      const priceText=priceNode?.getAttribute('data-price')||priceNode?.innerText||(text.match(/(?:Rs\.?|PKR)\s*[\d,]+(?:\.\d{1,2})?/i)||[])[0]||'';
      const price=Number(String(priceText).replace(/,/g,'').replace(/[^\d.]/g,''));
      const priceMatches=text.match(/(?:Rs\.?|PKR)\s*[\d,]+(?:\.\d{1,2})?/ig)||[];
      const original=priceMatches.length>1?Number(priceMatches[1].replace(/[^\d.]/g,'')):null;
      const rating=text.match(/\b([0-5](?:\.\d))\b/);
      const reviews=text.match(/([\d,]+)\s*(?:ratings|reviews)/i);
      const sold=text.match(/([\d,]+)\s*(?:sold|orders)/i);
      if(!title||!Number.isFinite(price)||price<=0) continue;
      results.push({
        id:(url.match(/-i(\d+)(?:-s\d+)?\.html?/i)||[])[1]||'',url,title,price,
        originalPrice:original&&original>price?original:null,currency:'PKR',country:'pk',
        brand:'',sellerName:'',rating:rating?Number(rating[1]):null,
        reviewCount:reviews?Number(reviews[1].replace(/,/g,'')):null,
        soldCount:sold?Number(sold[1].replace(/,/g,'')):null,
        imageUrl:img?.currentSrc||img?.getAttribute('src')||img?.getAttribute('data-src')||'',
        searchKeyword:keyword,inStock:true
      });
    }
    return results;
  },{keyword});
}

async function searchProducts(keyword, options={}) {
  const q=String(keyword||'').trim().slice(0,100);
  if(!q) throw new Error('A product search keyword is required.');
  const limit=Math.max(1,Math.min(50,Number(options.maxProducts)||20));
  let browser;
  try {
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({locale:'en-PK',viewport:{width:1365,height:900}});
    const page=await context.newPage();
    page.setDefaultNavigationTimeout(45000);
    const response=await page.goto('https://www.daraz.pk/catalog/?q='+encodeURIComponent(q),{waitUntil:'domcontentloaded',timeout:45000});
    if(!response||response.status()>=400) throw new Error('Daraz search returned HTTP '+(response?response.status():'no response')+'.');
    await wait(1800);
    const body=(await page.locator('body').innerText().catch(()=> '')).slice(0,5000);
    if(/captcha|verify you are human|access denied|unusual traffic/i.test(body)) {
      throw new Error('Daraz did not allow this automated request. No CAPTCHA or access-control bypass is attempted.');
    }
    const products=await extractProducts(page,q);
    await context.close();
    return products.slice(0,limit);
  } catch(error) {
    if(/Executable doesn't exist|browserType\.launch/i.test(error.message)) {
      throw new Error('Playwright Chromium is unavailable. Check Fable deployment build logs for the browser installation step.');
    }
    throw error;
  } finally { if(browser) await browser.close().catch(()=>{}); }
}

async function searchMany(keywords,options={}) {
  const limit=Math.max(1,Math.min(50,Number(options.maxProducts)||20));
  const unique=new Map(),errors=[];
  const selected=[...new Set(keywords.map(x=>String(x||'').trim()).filter(Boolean))].slice(0,5);
  const perKeyword=Math.max(3,Math.ceil(limit/Math.max(1,selected.length)));
  for(const keyword of selected) {
    if(unique.size>=limit) break;
    try {
      const rows=await searchProducts(keyword,{maxProducts:perKeyword});
      for(const row of rows) {
        const key=row.id||row.url;
        if(key&&!unique.has(key)) unique.set(key,row);
        if(unique.size>=limit) break;
      }
    } catch(error) { errors.push({keyword,message:error.message}); }
    await wait(1600);
  }
  if(!unique.size&&errors.length) throw new Error('No products collected. '+errors.map(x=>x.keyword+': '+x.message).join(' | '));
  return {products:[...unique.values()],errors};
}
module.exports={searchProducts,searchMany,isAllowedProductUrl};
