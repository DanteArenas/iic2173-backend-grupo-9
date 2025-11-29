// backend/src/services/recommendations.js
/**
 * Recomendaciones PERSONALIZADAS (historial del usuario + TODO el catálogo).
 *
 * - Pagina el catálogo completo vía /properties?page=X&limit=Y hasta totalPages.
 *   Env:
 *     • RECS_PAGE_LIMIT (default 25)
 *     • RECS_MAX_PAGES  (default 200)
 *
 * - Ubicación personalizada:
 *    • SOLO direcciones de reservas ACCEPTED del usuario (tokens).
 *
 * - Precio personalizado:
 *    • Banda CLP desde reservas del usuario (UF→CLP por fecha del ítem).
 *    • Si no hay historial, solo entonces se infiere el rango desde el catálogo (para precio).
 *
 * - Señales:
 *    • recency (decay semanal), popularity (log visitas),
 *    • price_affinity (gauss centrada en mediana CLP del usuario o del catálogo),
 *    • loc_user (Jaccard contra tokens de direcciones reservadas).
 *
 * - Pesos (sin historial de ubicaciones reducimos recency y forzamos diversidad):
 *    • Con historial de ubicación:  recency 0.18, pop 0.12, price 0.55, locUser 0.15
 *    • Sin historial de ubicación:  recency 0.12, pop 0.18, price 0.70, locUser 0.00 + diversifyByCity
 *
 * - Anti-empates:
 *    • Normalización min-max robusta + tiny tie-breaker por id.
 */

const DEBUG = String(process.env.DEBUG_RECS || '').toLowerCase() === '1';

// Fallback a undici si Node no tiene fetch global
let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  try {
    const { fetch: undiciFetch } = require('undici');
    _fetch = undiciFetch;
  } catch {
    throw new Error('Fetch API not available. Install undici or use Node 18+');
  }
}

// ---------- helpers de texto / tokens ----------
function normText(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s,.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  return new Set(normText(s).split(/[,\s/|-]+/).filter(Boolean));
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

function minmax(arr) {
  if (!arr.length) return { min: 0, max: 1, den: 1, apply: () => 0.5 };
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const den = max - min;
  if (den < 1e-9) return { min, max, den: 1, apply: () => 0.5 };
  return { min, max, den, apply: v => (v - min) / den };
}

// ---------- fetch JSON con auth ----------
async function getJSON(url, token, expectOk = true) {
  const r = await _fetch(url, {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
  });
  if (!expectOk) return r;
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text().catch(()=>r.statusText)}`);
  return r.json();
}

// ---------- UF cache por fecha ----------
const ufCache = new Map(); // 'YYYY-MM-DD' -> number
async function ufAt(apiBaseUrl, token, tsIso) {
  const d = new Date(tsIso || Date.now());
  const key = d.toISOString().slice(0, 10);
  if (ufCache.has(key)) return ufCache.get(key);
  try {
    const j = await getJSON(`${apiBaseUrl}/utils/uf?date=${encodeURIComponent(key)}`, token);
    const v = Number(j?.uf);
    const val = Number.isFinite(v) && v > 0 ? v : null;
    ufCache.set(key, val);
    return val;
  } catch {
    ufCache.set(key, null);
    return null;
  }
}

// ---------- conversión precio→CLP ----------
async function priceToClp(apiBaseUrl, token, price, currency, tsIso) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const ccy = (currency || '').toString().toUpperCase();
  if (!ccy || ccy === 'CLP' || ccy === '$') return Math.round(p);
  if (ccy === 'UF') {
    const v = await ufAt(apiBaseUrl, token, tsIso);
    return (v && v > 0) ? Math.round(p * v) : null;
  }
  return null; // otras monedas: sin conversión definida aquí
}

// ---------- cuantiles ----------
function quantileSorted(sortedArr, q) {
  if (!sortedArr.length) return null;
  const pos = (sortedArr.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  const h = pos - lo;
  return Math.round(sortedArr[lo] * (1 - h) + sortedArr[hi] * h);
}

// ---------- historial del usuario ----------
async function getUserAcceptedReservations(apiBaseUrl, token) {
  let list = [];
  try {
    const r = await getJSON(`${apiBaseUrl}/reservations`, token);
    list = Array.isArray(r) ? r : [];
  } catch { /* sin reservas o error */ }
  const acc = list
    .filter(x => String(x?.status || '').toUpperCase() === 'ACCEPTED')
    .sort((a, b) => new Date(b?.created_at || 0) - new Date(a?.created_at || 0));
  if (!acc.length) return [];
  const details = await Promise.all(
    acc.map(async (row) => {
      try {
        const d = await getJSON(`${apiBaseUrl}/reservations/${encodeURIComponent(row.request_id)}`, token);
        return { row, prop: d?.property_details || null };
      } catch {
        return { row, prop: null };
      }
    })
  );
  return details.filter(x => x.prop);
}

// ---------- extracción de “ciudad” básica desde location ----------
function extractCity(raw) {
  const s = (raw || '').toString().trim();
  if (!s) return 'unknown';
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  let city = parts[parts.length - 1] || parts[0] || 'unknown';
  city = city.toLowerCase()
             .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
             .replace(/\s+/g, ' ')
             .replace(/[^\p{L}\p{N}\s.-]/gu, '')
             .trim();
  return city || 'unknown';
}

// ---------- diversificación por ciudad (cap por ciudad) ----------
function diversifyByCity(sortedItems, topN, maxPerCity = 3) {
  const byCityCount = new Map();
  const picked = [];
  for (const it of sortedItems) {
    const city = extractCity(it.data?.location);
    const c = byCityCount.get(city) || 0;
    if (c < maxPerCity) {
      picked.push(it);
      byCityCount.set(city, c + 1);
      if (picked.length >= topN) break;
    }
  }
  if (picked.length < topN) {
    for (const it of sortedItems) {
      if (picked.length >= topN) break;
      if (!picked.includes(it)) picked.push(it);
    }
  }
  return picked.slice(0, topN);
}

// ---------- catálogo completo con paginación ----------
async function fetchAllProperties(apiBaseUrl, token, filter) {
  const PAGE_LIMIT = Math.max(1, Number(process.env.RECS_PAGE_LIMIT || 25));
  const MAX_PAGES  = Math.max(1, Number(process.env.RECS_MAX_PAGES  || 200));

  const rows = [];
  const seen = new Set();

  let page = 1;
  let totalPages = null;
  let pagesFetched = 0;

  while (page <= MAX_PAGES && (totalPages == null || page <= totalPages)) {
    const qs = new URLSearchParams();
    qs.set('limit', String(PAGE_LIMIT));
    qs.set('page', String(page));
    if (filter.price != null) qs.set('price', String(filter.price));
    if (filter.location)      qs.set('location', String(filter.location));
    if (filter.date)          qs.set('date', String(filter.date));
    if (filter.currency)      qs.set('currency', String(filter.currency));

    const url = `${apiBaseUrl}/properties?${qs.toString()}`;
    const j = await getJSON(url, token);

    if (totalPages == null && Number.isFinite(Number(j?.totalPages))) {
      totalPages = Number(j.totalPages);
    }

    const props = Array.isArray(j?.properties) ? j.properties : [];
    if (props.length === 0) break;

    for (const p of props) {
      const id = p?.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      rows.push(p);
    }

    pagesFetched += 1;
    page += 1;

    // techo duro
    if (rows.length >= PAGE_LIMIT * MAX_PAGES) break;
  }

  if (DEBUG) {
    console.log(`[RECS] fetched=${rows.length} pages=${pagesFetched}${totalPages ? `/${totalPages}` : ''} limit=${PAGE_LIMIT}`);
  }
  return rows;
}

// ---------- pipeline principal ----------
async function runRecommendationJob(params, ctx) {
  const top_n = Number.isFinite(params?.top_n) ? params.top_n : 8;
  const filter = (params?.filter && typeof params.filter === 'object') ? params.filter : {};

  const apiBaseUrl = typeof ctx?.apiBaseUrl === 'string' ? ctx.apiBaseUrl.replace(/\/$/, '') : '';
  const token = typeof ctx?.token === 'string' ? ctx.token : '';
  if (!apiBaseUrl) throw new Error('Missing apiBaseUrl');
  if (!token) throw new Error('Missing user token');

  // 1) Catálogo completo
  const rows = await fetchAllProperties(apiBaseUrl, token, filter);
  if (!rows.length) return { recommendations: [] };

  // 2) Historial del usuario (ACCEPTED)
  const accepted = await getUserAcceptedReservations(apiBaseUrl, token);

  // 3) Preferencias del usuario desde historial
  let userPriceClp = [];
  const userLocCounts = new Map();
  for (const { prop } of accepted) {
    const d = prop?.data || {};
    const clp = await priceToClp(apiBaseUrl, token, d.price, d.currency, d.timestamp);
    if (Number.isFinite(clp) && clp > 0) userPriceClp.push(clp);

    const toks = tokenize(d.location || '');
    for (const t of toks) userLocCounts.set(t, (userLocCounts.get(t) || 0) + 1);
  }
  userPriceClp.sort((a, b) => a - b);

  const priceMedianUser = quantileSorted(userPriceClp, 0.5);
  const priceP25User    = quantileSorted(userPriceClp, 0.25);
  const priceP75User    = quantileSorted(userPriceClp, 0.75);

  const hasUserLocPrefs = userLocCounts.size > 0;
  const userLocTokenSets = hasUserLocPrefs
    ? Array.from(userLocCounts.entries())
        .sort((a,b)=>b[1]-a[1])
        .slice(0, 8)
        .map(([key, count]) => ({ tokens: new Set([key]), weight: count }))
    : [];
  const maxUserLocCount = hasUserLocPrefs
    ? Math.max(1, ...userLocTokenSets.map(x => x.weight))
    : 1;

  // 4) Precio de catálogo si no hay historial de precio
  const catalogClp = [];
  for (const p of rows) {
    const d = p?.data || {};
    const clp = await priceToClp(apiBaseUrl, token, d.price, d.currency, d.timestamp);
    if (Number.isFinite(clp) && clp > 0) catalogClp.push(clp);
  }
  catalogClp.sort((a, b) => a - b);

  const priceMedian = Number.isFinite(priceMedianUser) ? priceMedianUser : quantileSorted(catalogClp, 0.5);
  const priceP25    = Number.isFinite(priceP25User)    ? priceP25User    : quantileSorted(catalogClp, 0.25);
  const priceP75    = Number.isFinite(priceP75User)    ? priceP75User    : quantileSorted(catalogClp, 0.75);

  // 5) Features por candidato
  const now = Date.now();
  const recency_raw = [], pop_raw = [], price_aff_raw = [], loc_user_raw = [];

  const candidateClpList = await Promise.all(
    rows.map(p => {
      const d = p?.data || {};
      return priceToClp(apiBaseUrl, token, d.price, d.currency, d.timestamp);
    })
  );

  const raw = rows.map((p, idx) => {
    const updatedMs = new Date(p?.updated_at || p?.data?.timestamp || 0).getTime();
    const updated = Number.isFinite(updatedMs) ? updatedMs : 0;
    const ageDays = Math.max(0, (now - updated) / 86400000);

    const recency = 1 / (1 + ageDays / 7);
    const visits = Math.max(0, Number(p?.visits || 0));
    const pop = Math.log10(1 + visits) / 2;

    const candClp = candidateClpList[idx];
    let priceAff = 0.5;
    if (Number.isFinite(candClp) && Number.isFinite(priceMedian) && priceMedian > 0) {
      const iqr = (Number.isFinite(priceP75) && Number.isFinite(priceP25) && priceP75 > priceP25)
        ? (priceP75 - priceP25)
        : 0.3 * priceMedian;
      const sigma = Math.max(1, iqr / 1.349); // IQR ≈ 1.349σ
      const diff = candClp - priceMedian;
      priceAff = Math.exp(-0.5 * Math.pow(diff / sigma, 2));
    }

    let locUser = 0;
    if (hasUserLocPrefs) {
      const candTok = tokenize(p?.data?.location || '');
      for (const pref of userLocTokenSets) {
        const sim = jaccard(candTok, pref.tokens);
        const rel = pref.weight / maxUserLocCount;
        locUser = Math.max(locUser, sim * rel);
      }
    }

    recency_raw.push(recency);
    pop_raw.push(pop);
    price_aff_raw.push(priceAff);
    loc_user_raw.push(locUser);

    return { p, recency, pop, priceAff, locUser, candClp };
  });

  // 6) Normalización
  const rn = minmax(recency_raw);
  const pn = minmax(pop_raw);
  const an = minmax(price_aff_raw);
  const lnUser = minmax(loc_user_raw);

  // 7) Pesos
  let weights = hasUserLocPrefs
    ? { recency: 0.05, pop: 0.20, price: 0.45, locUser: 0.30 }
    : { recency: 0.05, pop: 0.20, price: 0.75, locUser: 0.00 };

  const sumW = Object.values(weights).reduce((a,b)=>a+b,0) || 1;
  for (const k of Object.keys(weights)) weights[k] /= sumW;

  // 8) Score
  const scored = raw.map((x) => {
    const rec = rn.apply(x.recency);
    const pp  = pn.apply(x.pop);
    const pa  = an.apply(x.priceAff);
    const lu  = lnUser.apply(x.locUser);

    let s = weights.recency*rec + weights.pop*pp + weights.price*pa + weights.locUser*lu;

    // tiny stable tie-breaker
    const id = Number(x.p?.id || 0);
    s += ((id % 10007) / 10007) * 1e-6;

    if (DEBUG) {
      const city = extractCity(x.p?.data?.location);
      console.log('[RECS]', {
        id: x.p?.id,
        s: Number(s.toFixed(6)),
        rec: Number(rec.toFixed(3)),
        pop: Number(pp.toFixed(3)),
        price: Number(pa.toFixed(3)),
        locUser: Number(lu.toFixed(3)),
        clp: x.candClp || null,
        city
      });
    }

    return { property_id: x.p.id, score: s, data: x.p.data };
  });

  // 9) Normaliza y selecciona top_n (con diversificación si no hay prefs de ubicación)
  let sMin = Math.min(...scored.map(z => z.score));
  let sMax = Math.max(...scored.map(z => z.score));
  if (!Number.isFinite(sMin) || !Number.isFinite(sMax)) return { recommendations: [] };
  if (sMax - sMin < 1e-6) { sMin -= 5e-4; sMax += 5e-4; }
  const sDen = Math.max(1e-6, sMax - sMin);

  const normalized = scored
    .map(z => ({ ...z, score: (z.score - sMin) / sDen })) // 0..1
    .sort((a, b) => b.score - a.score);

  const MAX_PER_CITY = Number(process.env.RECS_MAX_PER_CITY || 3);
  const finalList = hasUserLocPrefs
    ? normalized.slice(0, top_n)
    : diversifyByCity(normalized, top_n, MAX_PER_CITY);

  return { recommendations: finalList };
}

module.exports = { runRecommendationJob };
