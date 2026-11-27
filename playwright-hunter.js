'use strict';

const { load } = require('cheerio');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const productPattern = /-i(\d+)(?:-s\d+)?\.html?(?:$|[?#])/i;

function isAllowedProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['daraz.pk', 'www.daraz.pk'].includes(url.hostname) &&
      productPattern.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function parsePrice(value) {
  const match = String(value || '').replace(/\s+/g, ' ').match(/(?:Rs\.?|PKR)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function inspectPage(html) {
  const $ = load(html);
  const anchors = $('a[href*="-i"]');
  const validLinks = [];
  anchors.each((_, el) => {
    try {
      const href = new URL($(el).attr('href') || '', 'https://www.daraz.pk').href;
      if (isAllowedProductUrl(href)) validLinks.push(href);
    } catch {}
  });
  const text = $('body').text().replace(/\\s+/g, ' ');
  const embeddedMarkers = [
    '__NEXT_DATA__',
    'window.pageData',
    'window.__',
    'productList',
    'listItems',
    'rootPage',
    'sku'
  ];
  const foundMarkers = embeddedMarkers.filter(marker => html.toLowerCase().includes(marker.toLowerCase()));
  return {
    htmlBytes: Buffer.byteLength(html),
    anchorCount: $('a').length,
    darazProductPatternLinks: anchors.length,
    validDarazProductUrls: new Set(validLinks).size,
    imageCount: $('img').length,
    priceLikeTextCount: (text.match(/(?:Rs\\.?|PKR)\\s*[\\d,]+(?:\\.\\d{1,2})?/ig) || []).length,
    embeddedDataMarkers: foundMarkers
  };
}

function extractProducts(html, keyword, limit) {
  const $ = load(html);
  const results = [];
  const seen = new Set();

  $('a[href*="-i"]').each((_, element) => {
    const anchor = $(element);
    let url;
    try {
      url = new URL(anchor.attr('href') || '', 'https://www.daraz.pk').href;
    } catch {
      return;
    }
    if (!isAllowedProductUrl(url) || seen.has(url)) return;

    const candidates = anchor.parents().slice(0, 9).toArray();
    let card = anchor;
    let cardText = anchor.text().trim();

    for (const candidate of candidates) {
      const node = $(candidate);
      const text = node.text().replace(/\s+/g, ' ').trim();
      if (text.length > 12 && text.length < 2200 && parsePrice(text)) {
        card = node;
        cardText = text;
        break;
      }
    }

    const image = card.find('img').first();
    const title = String(
      anchor.attr('title') ||
      image.attr('alt') ||
      anchor.text() ||
      ''
    ).replace(/\s+/g, ' ').trim();

    const priceNode = card.find(
      '[class*="ooOxS"],[class*="c13VH6"],[class*="price"],[data-price]'
    ).first();
    const price = parsePrice(
      priceNode.attr('data-price') ||
      priceNode.text() ||
      cardText
    );

    if (!title || !price) return;

    const id = (url.match(productPattern) || [])[1] || '';
    if (!id || seen.has(id)) return;
    seen.add(url);
    seen.add(id);

    const priceMatches = cardText.match(/(?:Rs\.?|PKR)\s*[\d,]+(?:\.\d{1,2})?/ig) || [];
    const originalPrice = priceMatches.length > 1
      ? Number(priceMatches[1].replace(/[^\d.]/g, ''))
      : null;
    const ratingMatch = cardText.match(/\b([0-5](?:\.\d))\b/);
    const reviewMatch = cardText.match(/([\d,]+)\s*(?:ratings|reviews)/i);
    const soldMatch = cardText.match(/([\d,]+)\s*(?:sold|orders)/i);
    const imageUrl = image.attr('data-src') || image.attr('data-lazy-src') || image.attr('src') || '';

    results.push({
      id,
      url,
      title,
      price,
      originalPrice: originalPrice && originalPrice > price ? originalPrice : null,
      currency: 'PKR',
      country: 'pk',
      brand: '',
      sellerName: '',
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      reviewCount: reviewMatch ? Number(reviewMatch[1].replace(/,/g, '')) : null,
      soldCount: soldMatch ? Number(soldMatch[1].replace(/,/g, '')) : null,
      imageUrl: imageUrl ? new URL(imageUrl, 'https://www.daraz.pk').href : '',
      searchKeyword: keyword,
      inStock: true
    });

    if (results.length >= limit) return false;
  });

  return results.slice(0, limit);
}

async function searchProducts(keyword, options = {}) {
  const q = String(keyword || '').trim().slice(0, 100);
  if (!q) throw new Error('A product search keyword is required.');
  const limit = Math.max(1, Math.min(50, Number(options.maxProducts) || 20));
  const url = 'https://www.daraz.pk/catalog/?q=' + encodeURIComponent(q);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-PK,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error) {
    throw new Error('Daraz request failed: ' + error.message);
  }

  if (response.status === 403 || response.status === 429) {
    throw new Error('Daraz returned HTTP ' + response.status + '. The request was not permitted; no access-control bypass is attempted.');
  }
  if (!response.ok) {
    throw new Error('Daraz search returned HTTP ' + response.status + '.');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error('Daraz returned an unexpected response type: ' + (contentType || 'unknown') + '.');
  }

  const html = await response.text();
  const diagnostics = inspectPage(html);
  const responseInfo = {
    status: response.status,
    finalUrl: response.url,
    contentType,
    ...diagnostics
  };
  if (!html || html.length < 500) {
    throw new Error('Daraz returned an empty or incomplete search page. Diagnostics: ' + JSON.stringify(responseInfo));
  }

  const pageText = load(html).text().slice(0, 7000);
  if (/captcha|verify you are human|access denied|unusual traffic/i.test(pageText)) {
    throw new Error('Daraz did not allow this request. No CAPTCHA or access-control bypass is attempted. Diagnostics: ' + JSON.stringify(responseInfo));
  }

  const products = extractProducts(html, q, limit);
  if (!products.length) {
    throw new Error('No products extracted. Diagnostics: ' + JSON.stringify(responseInfo));
  }
  return products;
}

async function searchMany(keywords, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.maxProducts) || 20));
  const unique = new Map();
  const errors = [];
  const selected = [...new Set(keywords.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 5);
  const perKeyword = Math.max(3, Math.ceil(limit / Math.max(1, selected.length)));

  for (const keyword of selected) {
    if (unique.size >= limit) break;
    try {
      const rows = await searchProducts(keyword, { maxProducts: perKeyword });
      for (const row of rows) {
        const key = row.id || row.url;
        if (key && !unique.has(key)) unique.set(key, row);
        if (unique.size >= limit) break;
      }
    } catch (error) {
      errors.push({ keyword, message: error.message });
    }
    await wait(1600);
  }

  if (!unique.size && errors.length) {
    throw new Error('No products collected. ' + errors.map(x => x.keyword + ': ' + x.message).join(' | '));
  }
  return { products: [...unique.values()], errors };
}

module.exports = { searchProducts, searchMany, isAllowedProductUrl, extractProducts, inspectPage };
