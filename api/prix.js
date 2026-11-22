/* Relais de prix pour Yukon 2027 (fonction Vercel)
   GET /api/prix?url=https://magasin.ca/produit/...
   → { price: 129.99, currency: "CAD", source: "json-ld", title: "..." }

   Le navigateur ne peut pas lire la page d'un autre site depuis GitHub Pages (CORS) :
   cette fonction la télécharge côté serveur et n'en renvoie que le prix.
   Ordre de recherche : données structurées JSON-LD (Product → offers),
   balises meta (product:price:amount, og:price:amount, itemprop=price),
   puis premier prix affiché dans le texte (« 129,99 $ » ou « $129.99 »). */

const ALLOWED_ORIGINS = [
  'https://womack82.github.io',
  'http://localhost:8127',
  'http://127.0.0.1:8127',
];
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 9000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /\.vercel\.app$/.test(safeHost(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') return send(res, 405, { error: 'Méthode non permise' });

  const target = checkUrl(req.query && req.query.url);
  if (!target) return send(res, 400, { error: 'Lien invalide' });

  let html;
  try {
    html = await download(target);
  } catch (e) {
    return send(res, 502, { error: 'Page inaccessible' });
  }

  const found = findPrice(html);
  if (!found) return send(res, 404, { error: 'Prix introuvable', title: findTitle(html) });
  res.setHeader('Cache-Control', 'public, s-maxage=3600, max-age=600');
  return send(res, 200, { ...found, title: findTitle(html) });
};

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

/* N'accepte que des liens http(s) publics (pas d'adresse locale ou privée) */
function checkUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':')) return null;            // IPv6 littérale
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return null;
  }
  return u.toString();
}

async function download(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX_BYTES) { ctrl.abort(); break; }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Extraction du prix ---------- */
function toNum(v) {
  if (typeof v === 'number') return v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d.,]/g, '');
  if (!s) return null;
  // « 1 299,99 » / « 1,299.99 » / « 129,99 » / « 129.99 »
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

function findPrice(html) {
  return fromJsonLd(html) || fromMeta(html) || fromText(html);
}

function fromJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const hit = walk(data);
    if (hit) return { ...hit, source: 'json-ld' };
  }
  return null;
}

/* Parcourt le JSON-LD à la recherche d'un produit et de son offre */
function walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = walk(n, depth + 1); if (r) return r; }
    return null;
  }
  const type = [].concat(node['@type'] || []).join(' ');
  if (/Product|Offer/i.test(type) || node.offers) {
    const r = offerPrice(node.offers || node);
    if (r) return r;
  }
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) {
    if (node[k]) { const r = walk(node[k], depth + 1); if (r) return r; }
  }
  return null;
}

function offerPrice(o) {
  if (!o) return null;
  if (Array.isArray(o)) {
    for (const x of o) { const r = offerPrice(x); if (r) return r; }
    return null;
  }
  if (typeof o !== 'object') return null;
  const cur = o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || null;
  const p = toNum(o.price) ?? toNum(o.lowPrice) ?? toNum(o.priceSpecification && o.priceSpecification.price);
  if (p) return { price: p, currency: cur };
  if (o.offers) return offerPrice(o.offers);
  return null;
}

function metaContent(html, attr, name) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']+)["']/i);
  return c ? c[1] : null;
}

function fromMeta(html) {
  const price = toNum(metaContent(html, 'property', 'product:price:amount')) ??
    toNum(metaContent(html, 'property', 'og:price:amount')) ??
    toNum(metaContent(html, 'itemprop', 'price'));
  if (!price) {
    const ip = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
    const p2 = ip && toNum(ip[1]);
    if (p2) return { price: p2, currency: null, source: 'meta' };
    return null;
  }
  const currency = metaContent(html, 'property', 'product:price:currency') || metaContent(html, 'property', 'og:price:currency') || metaContent(html, 'itemprop', 'priceCurrency');
  return { price, currency, source: 'meta' };
}

/* Dernier recours : premier prix affiché dans le corps de la page */
function fromText(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(header|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;| | /g, ' ');
  const m = body.match(/(\d{1,3}(?:[  ]?\d{3})*,\d{2})\s?\$/) || body.match(/\$\s?(\d{1,3}(?:,?\d{3})*\.\d{2})/);
  const p = m && toNum(m[1]);
  return p ? { price: p, currency: null, source: 'texte' } : null;
}

function findTitle(html) {
  const og = metaContent(html, 'property', 'og:title');
  const t = og || ((html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1]) || '';
  return t.replace(/\s+/g, ' ').trim().slice(0, 140);
}

module.exports.findPrice = findPrice;
module.exports.checkUrl = checkUrl;
