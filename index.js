require('dotenv').config();
const http = require('http');
const { createClient } = require('@libsql/client');
const { createHuntingEngine } = require('./hunting');

const PORT = Number(process.env.PORT) || 3000;
const DB_URL = process.env.TURSO_DATABASE_URL;
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN;
let db = null;
let dbConnected = false;

if (DB_URL && DB_TOKEN) db = createClient({ url: DB_URL, authToken: DB_TOKEN });

const hunting = createHuntingEngine({
  db,
  config: {
    geminiKey: process.env.GEMINI_API_KEY || '',
    groqKey: process.env.GROQ_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  }
});

async function prepareDatabase() {
  if (!db) return;
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL,
      external_id TEXT,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      currency TEXT,
      current_price REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(marketplace, external_id)
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      price REAL NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      target_price REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);
    dbConnected = true;
    console.log('Turso connected; core tables initialized.');
  } catch (err) {
    dbConnected = false;
    console.error('Turso setup failed:', err.message);
  }
}

const page = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#070a09"><title>PriceNova | Product Intelligence</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap');
:root{--bg:#070a09;--panel:#0d130f;--line:#1d2b22;--green:#39e58b;--text:#e8f1eb;--muted:#819188}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif}.layout{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:235px;background:#090e0b;border-right:1px solid var(--line);padding:23px 15px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:11px;padding:0 8px 30px}.logo{width:37px;height:37px;border-radius:11px;background:linear-gradient(140deg,#42ee98,#116b43);display:grid;place-items:center;color:#06120a;font-family:'Space Grotesk';font-weight:800}.brandname{font:700 18px 'Space Grotesk'}.brandname span{color:var(--green)}.navlabel{font-size:10px;color:#64736a;letter-spacing:1.5px;font-weight:700;padding:12px 10px}.nav{display:grid;gap:5px}.nav button{border:0;background:none;color:#9eada3;padding:11px;border-radius:9px;text-align:left;display:flex;gap:12px;cursor:pointer;font-size:13px}.nav button:hover{background:#111a15;color:#e6eee8}.nav button.active{background:#12251a;color:var(--green);box-shadow:inset 2px 0 var(--green)}.glyph{width:18px;text-align:center}.bottom{margin-top:auto}.dbcard{border:1px solid var(--line);border-radius:10px;background:#0d1510;padding:12px;margin:10px 3px 15px}.dbstatus{font-size:11px;font-weight:700;display:flex;align-items:center;gap:8px}.dot{height:7px;width:7px;background:#66736b;border-radius:50%}.dot.good{background:var(--green);box-shadow:0 0 8px #39e58b66}.dbcard p{font-size:10px;color:var(--muted);line-height:1.5;margin:8px 0 0}.owner{border-top:1px solid var(--line);padding:14px 5px 0;display:flex;gap:10px;align-items:center}.avatar{width:33px;height:33px;border-radius:50%;display:grid;place-items:center;background:#15241b;color:var(--green);font-size:11px;font-weight:700}.owner strong{display:block;font-size:12px}.owner small{color:var(--muted);font-size:10px}main{margin-left:235px;padding:28px 34px 45px;max-width:1600px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}.crumb{font-size:12px;color:var(--muted)}.crumb b{color:#dce7df;font-weight:500}.topright{display:flex;gap:9px}.pill{border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:11px;color:#9caaa1;display:flex;align-items:center;gap:8px}.intro{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:24px}.intro h1{font:600 27px 'Space Grotesk';letter-spacing:-.8px;margin:0 0 8px}.intro p{font-size:13px;color:var(--muted);margin:0}.launch{border:0;border-radius:9px;background:#1a2920;color:#68776d;padding:11px 15px;font-size:12px;font-weight:700;cursor:not-allowed}.cards{display:grid;grid-template-columns:1fr 1fr;gap:15px}.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px}.cardhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.cardhead h2{font:600 14px 'Space Grotesk';margin:0}.cardhead small{font-size:10px;color:var(--muted)}.empty{min-height:205px;border:1px dashed #26362b;background:#0a100c;border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:22px}.emptyicon{width:42px;height:42px;border-radius:13px;background:#14251a;color:var(--green);display:grid;place-items:center;font-size:18px;margin-bottom:12px}.empty strong{font-size:12px;margin-bottom:7px}.empty p{font-size:11px;color:var(--muted);line-height:1.5;max-width:275px;margin:0}.wide{grid-column:1/-1}.tablehead{display:flex;justify-content:space-between;align-items:center;padding:15px;border-bottom:1px solid var(--line)}.tablehead h2{font:600 14px 'Space Grotesk';margin:0}.tablehead small{font-size:10px;color:var(--muted)}.tableempty{padding:35px;text-align:center;color:var(--muted);font-size:11px}.toast{position:fixed;right:20px;bottom:20px;background:#14251a;border:1px solid #2c7047;color:#dbf6e5;border-radius:9px;padding:12px 15px;font-size:12px;opacity:0;transition:.2s}.toast.show{opacity:1}
@media(max-width:950px){main{padding:22px}.cards{grid-template-columns:1fr}.wide{grid-column:auto}}
@media(max-width:700px){.sidebar{width:68px;padding:18px 8px}.brand{justify-content:center;padding:0 0 25px}.brandname,.navlabel,.navtext,.dbcard,.ownerinfo,.navlabel{display:none}.nav button{justify-content:center;padding:12px 7px}.bottom{display:flex;align-items:center;flex-direction:column}.owner{justify-content:center;padding-top:12px}main{margin-left:68px;width:calc(100% - 68px);padding:18px 13px}.intro h1{font-size:21px}.intro p{font-size:11px;max-width:220px}.intro .launch{font-size:10px;padding:9px 10px}.top{margin-bottom:24px}.topright .pill:nth-child(2){display:none}}
</style></head><body><div class="layout">
<aside class="sidebar"><div class="brand"><div class="logo">P</div><div class="brandname">Price<span>Nova</span></div></div>
<div class="navlabel">WORKSPACE</div><nav class="nav">
<button class="active" data-section="Overview"><span class="glyph">⌂</span><span class="navtext">Overview</span></button>
<button data-section="Product Hunt"><span class="glyph">⌕</span><span class="navtext">Product Hunt</span></button>
<button data-section="Watchlist"><span class="glyph">◈</span><span class="navtext">Watchlist</span></button>
<button data-section="Price Alerts"><span class="glyph">♧</span><span class="navtext">Price Alerts</span></button>
<button data-section="Analytics"><span class="glyph">▥</span><span class="navtext">Analytics</span></button></nav>
<div class="navlabel">PREFERENCES</div><nav class="nav"><button data-section="Settings"><span class="glyph">⚙</span><span class="navtext">Settings</span></button><button data-section="Help"><span class="glyph">?</span><span class="navtext">Help Center</span></button></nav>
<div class="bottom"><div class="dbcard"><div class="dbstatus"><span class="dot" id="dbDot"></span><span id="dbLabel">Turso not configured</span></div><p id="dbInfo">Set Turso credentials in your environment to enable storage.</p></div><div class="owner"><div class="avatar">PN</div><div class="ownerinfo"><strong>PriceNova</strong><small>Product workspace</small></div></div></div></aside>
<main><header class="top"><div class="crumb">Workspace / <b id="breadcrumb">Overview</b></div><div class="topright"><div class="pill"><span class="dot"></span> Engine not installed</div><div class="pill">Version 1.0</div></div></header>
<section class="intro"><div><h1 id="pageTitle">Overview <span style="color:var(--green)">✦</span></h1><p id="subtitle">Your product intelligence workspace. No records yet.</p></div><button class="launch" disabled>⌕ &nbsp; Hunting engine pending</button></section>
<section class="cards">
<div class="card"><div class="cardhead"><h2>Price activity</h2><small>Live data only</small></div><div class="empty"><div class="emptyicon">⌁</div><strong>No price history</strong><p>Real price movement will appear after the product tracking engine is built and starts collecting data.</p></div></div>
<div class="card"><div class="cardhead"><h2>System status</h2><small>Readiness</small></div><div class="empty"><div class="emptyicon">◈</div><strong id="sysTitle">Awaiting setup</strong><p id="sysMessage">Turso connection is being prepared. The hunting engine is not active.</p></div></div>
<div class="card wide"><div class="tablehead"><div><h2>Products</h2><small>Stored products only — no demo entries</small></div><div class="pill" id="count">0 records</div></div><div class="tableempty" id="productEmpty">No products stored yet. This section will show real products after the discovery engine is connected.</div></div>
<div class="card"><div class="cardhead"><h2>Watchlist</h2><small>Tracked items</small></div><div class="empty"><div class="emptyicon">◇</div><strong>Nothing saved</strong><p>Your watchlist will appear here when real product tracking is implemented.</p></div></div>
<div class="card"><div class="cardhead"><h2>Price alerts</h2><small>Notification rules</small></div><div class="empty"><div class="emptyicon">♧</div><strong>No alert rules</strong><p>Price alerts will be available after products and monitoring are implemented.</p></div></div>
</section></main></div><div class="toast" id="toast"></div>
<script>
const toast=document.getElementById('toast');let t;
function notify(s){toast.textContent=s;toast.classList.add('show');clearTimeout(t);t=setTimeout(()=>toast.classList.remove('show'),2300)}
document.querySelectorAll('.nav button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');let p=b.dataset.section;document.getElementById('breadcrumb').textContent=p;document.getElementById('pageTitle').innerHTML=p+' <span style="color:var(--green)">✦</span>';document.getElementById('subtitle').textContent=p==='Overview'?'Your product intelligence workspace. No records yet.':p+' module is reserved until it is implemented.';notify(p+' is not implemented yet')}));
async function status(){try{let r=await fetch('/api/status');let d=await r.json();let ok=d.database.connected;document.getElementById('dbDot').classList.toggle('good',ok);document.getElementById('dbLabel').textContent=ok?'Turso connected':d.database.configured?'Turso connection error':'Turso not configured';document.getElementById('dbInfo').textContent=ok?'Database tables are initialized and ready for real records.':d.database.configured?'Check your Turso credentials and server log.':'Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your environment.';document.getElementById('sysTitle').textContent=ok?'Storage ready':'Awaiting setup';document.getElementById('sysMessage').textContent=ok?'Turso is connected. Waiting for the product engine to write real data.':'Turso is not connected. The hunting engine is not active.'}catch(e){document.getElementById('dbLabel').textContent='Server unavailable'}}
status();
</script></body></html>`;

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000;
const ADMIN_COOKIE = 'pn_admin_session';
const adminSessions = new Map();
const loginAttempts = new Map();

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const item = part.trim();
    const index = item.indexOf('=');
    if (index > -1 && item.slice(0, index) === name) {
      return decodeURIComponent(item.slice(index + 1));
    }
  }
  return '';
}

function getAdminSession(req) {
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL;
  return session;
}

function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' ||
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAge) {
  return ADMIN_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge +
    (isSecureRequest(req) ? '; Secure' : '');
}

function sendAdminFile(res, filename) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('Admin page is not available yet.');
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });
  res.end(fs.readFileSync(filePath));
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function getClientKey(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

function loginRateLimit(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return loginAttempts.get(key);
  }
  return current;
}

const protectedPages = new Set(['/UserManagement.html', '/Conversion.html', '/Clicks.html', '/Hunting.html']);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, {
      app: 'PriceNova',
      engine: { installed: true, provider: 'Playwright + Chromium', browserInstall: 'npm postinstall', ai: { geminiConfigured: Boolean(process.env.GEMINI_API_KEY), groqConfigured: Boolean(process.env.GROQ_API_KEY) } },
      database: { configured: Boolean(DB_URL && DB_TOKEN), connected: dbConnected },
      admin: { passwordConfigured: Boolean(ADMIN_PASSWORD) }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/hunt') {
    if (!ADMIN_PASSWORD || !getAdminSession(req)) return json(res, 401, { error: 'Admin authentication required.' });
    let body;
    try { body = await readJsonBody(req, 8192); }
    catch (err) { return json(res, 400, { error: err.message }); }
    try {
      await databaseReady;
      const result = await hunting.hunt(body);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/hunt/data') {
    if (!ADMIN_PASSWORD || !getAdminSession(req)) return json(res, 401, { error: 'Admin authentication required.' });
    try {
      await databaseReady;
      return json(res, 200, await hunting.data());
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/session') {
    if (!ADMIN_PASSWORD) return json(res, 503, { authenticated: false, error: 'ADMIN_PASSWORD is not configured.' });
    return json(res, 200, { authenticated: Boolean(getAdminSession(req)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!ADMIN_PASSWORD) return json(res, 503, { error: 'Set ADMIN_PASSWORD in your hosting environment first.' });
    const key = getClientKey(req);
    const attempts = loginRateLimit(key);
    if (attempts.count >= 5) {
      return json(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    let body;
    try { body = await readJsonBody(req); }
    catch (err) { return json(res, 400, { error: err.message }); }

    const submitted = typeof body.password === 'string' ? body.password : '';
    const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
    const submittedBuffer = Buffer.from(submitted);
    const valid = expectedBuffer.length === submittedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, submittedBuffer);

    if (!valid) {
      attempts.count += 1;
      return json(res, 401, { error: 'Incorrect password.' });
    }

    loginAttempts.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + ADMIN_SESSION_TTL });
    return json(res, 200, { authenticated: true }, {
      'Set-Cookie': sessionCookie(req, token, Math.floor(ADMIN_SESSION_TTL / 1000))
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = getCookie(req, ADMIN_COOKIE);
    if (token) adminSessions.delete(token);
    return json(res, 200, { success: true }, {
      'Set-Cookie': sessionCookie(req, '', 0)
    });
  }

  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/Admin.html' || url.pathname === '/admin.html')) {
    return sendAdminFile(res, 'Admin.html');
  }

  if (req.method === 'GET' && protectedPages.has(url.pathname)) {
    if (!ADMIN_PASSWORD || !getAdminSession(req)) {
      res.writeHead(302, { Location: '/Admin.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const filename = url.pathname.slice(1);
    return sendAdminFile(res, filename);
  }

  return json(res, 404, { error: 'Not found' });
});

const databaseReady = prepareDatabase();
server.listen(PORT, '0.0.0.0', () => console.log('PriceNova server listening on port ' + PORT));
