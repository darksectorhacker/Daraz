'use strict';

const s = value => typeof value === 'string' ? value.trim() : '';
const numeric = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

function isDarazProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'daraz.pk' || url.hostname.endsWith('.daraz.pk')) &&
      /-i\d+\.html(?:$|[?#])/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function normalizeProduct(row, keyword) {
  const url = s(row.url || row.productUrl || row.product_url || row.link);
  const id = String(row.id || row.productId || row.product_id || row.itemId ||
    (url.match(/-i(\d+)\.html/i) || [])[1] || '').trim();
  const price = numeric(row.price ?? row.currentPrice ?? row.current_price ?? row.salePrice);
  const title = s(row.title || row.name || row.productTitle || row.product_title);
  if (!id || !title || !price || !isDarazProductUrl(url)) return null;

  return {
    id,
    url,
    title,
    price,
    originalPrice: numeric(row.originalPrice ?? row.original_price ?? row.listPrice),
    currency: s(row.currency) || 'PKR',
    brand: s(row.brand),
    sellerName: s(row.sellerName || row.seller_name || row.seller),
    rating: numeric(row.rating || row.averageRating),
    reviewCount: numeric(row.reviewCount || row.review_count || row.ratingsCount),
    soldCount: numeric(row.soldCount || row.sold_count || row.unitsSold),
    imageUrl: s(row.imageUrl || row.image_url || row.image),
    inStock: row.inStock !== false && row.in_stock !== false,
    searchKeyword: keyword,
    raw: row
  };
}

function score(product) {
  let value = 25;
  if (product.rating !== null) value += Math.min(20, product.rating * 4);
  if (product.reviewCount !== null) value += Math.min(10, Math.log10(product.reviewCount + 1) * 5);
  if (product.soldCount !== null) value += Math.min(15, Math.log10(product.soldCount + 1) * 5);
  if (product.inStock) value += 5;
  if (product.originalPrice && product.originalPrice > product.price) {
    const discount = (product.originalPrice - product.price) / product.originalPrice * 100;
    if (discount <= 70) value += Math.min(15, discount * 0.25);
  }
  return Math.round(Math.min(100, value));
}

function createHuntingEngine({ db, config = {} }) {
  let active = null;
  let last = null;
  let ready = false;
  let readyPromise = null;

  async function ensure() {
    if (!db) throw new Error('Turso database is not configured.');
    if (ready) return;
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS hunt_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        query TEXT,
        target_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        found_count INTEGER DEFAULT 0,
        saved_count INTEGER DEFAULT 0,
        ai_provider TEXT,
        error TEXT,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      )`);

      for (const column of [
        'brand TEXT', 'rating REAL', 'review_count INTEGER', 'sold_count INTEGER',
        'seller_name TEXT', 'image_url TEXT', 'deal_score REAL',
        'comparable_count INTEGER', 'best_observed_price REAL', 'source_data TEXT'
      ]) {
        try {
          await db.execute('ALTER TABLE products ADD COLUMN ' + column);
        } catch (error) {
          if (!/duplicate column/i.test(error.message)) throw error;
        }
      }
      ready = true;
    })();

    try {
      await readyPromise;
    } catch (error) {
      readyPromise = null;
      throw error;
    }
  }

  async function fetchApprovedProducts(keyword, limit) {
    const feedUrl = s(config.darazFeedUrl);
    if (!feedUrl) {
      throw new Error('Daraz data source is not configured. Add DARAZ_PRODUCT_FEED_URL for an approved Daraz or affiliate product API/feed.');
    }

    let endpoint;
    try {
      endpoint = new URL(feedUrl);
    } catch {
      throw new Error('DARAZ_PRODUCT_FEED_URL must be a valid HTTPS URL.');
    }
    if (endpoint.protocol !== 'https:') {
      throw new Error('The configured Daraz product feed must use HTTPS.');
    }

    endpoint.searchParams.set('q', keyword);
    endpoint.searchParams.set('limit', String(Math.max(1, Math.min(50, limit))));

    const headers = { Accept: 'application/json' };
    if (s(config.darazFeedToken)) {
      headers.Authorization = 'Bearer ' + s(config.darazFeedToken);
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      throw new Error('Approved Daraz feed returned HTTP ' + response.status + '.');
    }

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload
      : Array.isArray(payload.products) ? payload.products
      : Array.isArray(payload.items) ? payload.items
      : Array.isArray(payload.data?.products) ? payload.data.products
      : [];

    if (!rows.length) return [];
    return rows.map(row => normalizeProduct(row, keyword)).filter(Boolean).slice(0, limit);
  }

  async function saveProducts(products) {
    let saved = 0;

    for (const product of products) {
      const existing = await db.execute({
        sql: 'SELECT id,current_price FROM products WHERE marketplace=? AND external_id=? LIMIT 1',
        args: ['daraz.pk', product.id]
      });

      const values = [
        product.url, product.title, product.currency, product.price,
        product.brand || null, product.rating, product.reviewCount,
        product.soldCount, product.sellerName || null, product.imageUrl || null,
        product.score, product.comparableCount, product.bestObservedPrice,
        JSON.stringify(product.raw)
      ];

      if (existing.rows.length) {
        const productId = Number(existing.rows[0].id);
        const previousPrice = Number(existing.rows[0].current_price);
        await db.execute({
          sql: 'UPDATE products SET url=?,title=?,currency=?,current_price=?,updated_at=CURRENT_TIMESTAMP,brand=?,rating=?,review_count=?,sold_count=?,seller_name=?,image_url=?,deal_score=?,comparable_count=?,best_observed_price=?,source_data=? WHERE id=?',
          args: [...values, productId]
        });
        if (previousPrice !== product.price) {
          await db.execute({
            sql: 'INSERT INTO price_history(product_id,price) VALUES(?,?)',
            args: [productId, product.price]
          });
        }
      } else {
        const inserted = await db.execute({
          sql: 'INSERT INTO products(marketplace,external_id,url,title,currency,current_price,brand,rating,review_count,sold_count,seller_name,image_url,deal_score,comparable_count,best_observed_price,source_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          args: ['daraz.pk', product.id, ...values]
        });
        await db.execute({
          sql: 'INSERT INTO price_history(product_id,price) VALUES(?,?)',
          args: [Number(inserted.lastInsertRowid), product.price]
        });
      }
      saved += 1;
    }
    return saved;
  }

  async function hunt({ mode, keyword, targetCount }) {
    if (active) throw new Error('A hunt is already running.');
    await ensure();
    if (active) throw new Error('A hunt is already running.');

    const count = Math.max(1, Math.min(50, Number(targetCount) || 5));
    const selectedMode = mode === 'manual' ? 'manual' : 'auto';
    const query = selectedMode === 'manual' ? s(keyword).slice(0, 100) : 'AI-selected Daraz product categories';
    if (selectedMode === 'manual' && !query) throw new Error('Enter a keyword for Manual Hunt.');

    active = {
      mode: selectedMode,
      query,
      targetCount: count,
      status: 'running',
      startedAt: new Date().toISOString()
    };
    last = active;

    let runId = null;
    try {
      const run = await db.execute({
        sql: 'INSERT INTO hunt_runs(mode,query,target_count,status) VALUES(?,?,?,?)',
        args: [selectedMode, query, count, 'running']
      });
      runId = Number(run.lastInsertRowid);
      active.id = runId;

      if (!config.geminiKey && !config.groqKey) {
        throw new Error('Configure GEMINI_API_KEY or GROQ_API_KEY in Faable before starting the Agent.');
      }
      if (!s(config.darazFeedUrl)) {
        throw new Error('Daraz data source is not configured. Connect an approved Daraz/affiliate product API or feed using DARAZ_PRODUCT_FEED_URL.');
      }

      const { runDarazAgent } = await import('./daraz-agent.mjs');
      const prompt = selectedMode === 'manual'
        ? 'Find up to ' + count + ' relevant Daraz.pk Pakistan products for this exact search intent: ' + query + '. Search only this intent; do not broaden into unrelated categories.'
        : 'Autonomously discover up to ' + count + ' potentially useful Daraz.pk Pakistan products. Choose a small number of sensible product-category search terms. Do not claim market demand or popularity unless the returned product data explicitly supports it.';

      const agentResult = await runDarazAgent({
        config,
        prompt,
        maxProducts: count,
        searchProducts: fetchApprovedProducts
      });

      const unique = new Map();
      for (const product of agentResult.products) {
        if (!unique.has(product.id)) unique.set(product.id, product);
      }

      const products = [...unique.values()];
      if (!products.length) {
        throw new Error('The Agent completed but the approved data source returned no valid Daraz products. Check the feed response format and credentials.');
      }

      const titleKey = title => s(title).toLowerCase()
        .replace(/\b(black|white|blue|red|green|pink|purple|silver|gold|grey|gray|beige|brown|navy)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

      const groups = new Map();
      for (const product of products) {
        const key = titleKey(product.title);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(product);
      }

      for (const product of products) {
        const peers = groups.get(titleKey(product.title)) || [];
        product.comparableCount = peers.length;
        product.bestObservedPrice = peers.length > 1
          ? Math.min(...peers.map(item => item.price))
          : null;
        product.score = score(product);
      }

      products.sort((a, b) => b.score - a.score || a.price - b.price);
      const selected = products.slice(0, count);
      const savedCount = await saveProducts(selected);

      Object.assign(active, {
        status: 'completed',
        foundCount: products.length,
        savedCount,
        aiProvider: agentResult.provider,
        agentSummary: agentResult.text,
        aiNotes: [],
        products: selected.map(product => ({
          title: product.title,
          price: product.price,
          currency: product.currency,
          url: product.url,
          score: product.score,
          rating: product.rating,
          sold: product.soldCount,
          brand: product.brand,
          image: product.imageUrl
        }))
      });

      await db.execute({
        sql: "UPDATE hunt_runs SET status='completed',found_count=?,saved_count=?,ai_provider=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",
        args: [products.length, savedCount, agentResult.provider, runId]
      });
      return active;
    } catch (error) {
      Object.assign(active, {
        status: 'failed',
        error: error.message,
        finishedAt: new Date().toISOString()
      });
      if (runId) {
        await db.execute({
          sql: "UPDATE hunt_runs SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",
          args: [error.message, runId]
        }).catch(() => {});
      }
      throw error;
    } finally {
      active = null;
    }
  }

  async function data() {
    await ensure();
    const [products, runs] = await Promise.all([
      db.execute('SELECT id,marketplace,external_id,url,title,currency,current_price,brand,rating,review_count,sold_count,seller_name,image_url,deal_score,comparable_count,best_observed_price,updated_at FROM products ORDER BY deal_score DESC,updated_at DESC LIMIT 50'),
      db.execute('SELECT * FROM hunt_runs ORDER BY id DESC LIMIT 15')
    ]);
    return { products: products.rows, runs: runs.rows };
  }

  return {
    hunt,
    data,
    status: () => ({
      running: Boolean(active),
      activeJob: active,
      lastJob: last,
      agent: 'Vercel AI SDK ToolLoopAgent',
      dataSourceConfigured: Boolean(s(config.darazFeedUrl))
    }),
    ensure
  };
}

module.exports = { createHuntingEngine, normalizeProduct, score, isDarazProductUrl };
