// backend/itemsCache.js
// Каталог цін (csgotrader) + швидкі зображення з qwkdev/csapi.
// Пошук, lookup, та форс-резолв картинок.

const PRICE_SRC = "https://prices.csgotrader.app/latest/steam.json";
const IMG_SRC   = "https://raw.githubusercontent.com/qwkdev/csapi/main/data2.json";

// ===== Runtime caches =====
let CATALOG = new Map();        // market_hash_name -> normalized item
let lastUpdated = 0;            // unix ms
export { lastUpdated };

let IMG_MAP = new Map();        // market_hash_name -> absolute image url
let lastImgUpdated = 0;

// In-memory fallback cache for resolved images
const IMAGE_CACHE = new Map();  // `${appid}::${mhn}` -> url|null

function fullImageUrl(icon_url, size = "256fx256f") {
  if (!icon_url) return null;
  return `https://community.cloudflare.steamstatic.com/economy/image/${icon_url}/${size}`;
}
function toNum(x) {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  if (typeof x === "string") return Number(x.replace(/[^0-9.]/g, ""));
  return NaN;
}

/* =================== Loaders =================== */

// qwkdev/csapi image map
async function refreshImageMap() {
  const r = await fetch(IMG_SRC, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Fetch image map failed: ${r.status} ${r.statusText}`);
  const json = await r.json();

  const map = new Map();

  // Підтримуємо і формат об'єкта і формат масиву
  if (Array.isArray(json)) {
    for (const it of json) {
      const key =
        it?.market_hash_name || it?.hash_name || it?.name || null;
      const url = it?.image || it?.icon_url || it?.icon || null;
      if (key && url) map.set(String(key), String(url));
    }
  } else if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json)) {
      const url = v?.image || v?.icon_url || v?.icon || null;
      if (k && url) map.set(String(k), String(url));
    }
  }

  IMG_MAP = map;
  lastImgUpdated = Date.now();
  return { size: IMG_MAP.size, lastImgUpdated };
}

// csgotrader prices
function normalizeEntry(mhn, v) {
  const appid = Number(v?.appId ?? v?.appid ?? 730);
  const name = v?.name ?? mhn;
  const icon_url = v?.icon_url ?? v?.icon_url_large ?? null;

  const priceCandidate =
    (v?.last_24h ?? v?.last_7d ?? v?.last_30d ?? v?.last_90d) ??
    v?.steam?.price ?? v?.steam?.mean ?? v?.steam?.avg ?? v?.steam?.median ??
    v?.lowest_price ?? v?.median_price ?? v?.price;

  const price = toNum(priceCandidate);
  const currency = (v?.steam?.currency ?? "USD").toUpperCase();

  // ПЕРШОЮ чергою беремо картинку з IMG_MAP
  const mappedImg = IMG_MAP.get(mhn) || null;

  return {
    appid,
    market_hash_name: mhn,
    name,
    icon_url,
    image: mappedImg ?? fullImageUrl(icon_url), // якщо в картмапі нема — пробуємо icon_url
    steam: Number.isFinite(price) ? { price, currency } : null,
  };
}

export async function refreshCatalog() {
  // гарантуємо, що карта зображень є перед нормалізацією
  if (IMG_MAP.size === 0) {
    try { await refreshImageMap(); } catch {}
  }

  const r = await fetch(PRICE_SRC, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Fetch catalog failed: ${r.status} ${r.statusText}`);
  const json = await r.json();

  const next = new Map();
  for (const [mhn, v] of Object.entries(json)) {
    next.set(mhn, normalizeEntry(mhn, v));
  }
  CATALOG = next;
  lastUpdated = Date.now();
  return { size: CATALOG.size, lastUpdated };
}

export async function ensureReady() {
  if (IMG_MAP.size === 0) {
    try { await refreshImageMap(); } catch {}
  }
  if (CATALOG.size === 0) {
    await refreshCatalog();
  }
}

/* ============== Image resolving fallbacks ============== */

// Надійний парсер зі сторінки листингу (використовуємо тільки як fallback)
async function fetchSteamListingImage(appid, market_hash_name) {
  const url = `https://steamcommunity.com/market/listings/${appid}/${encodeURIComponent(market_hash_name)}`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const html = await r.text();

  const mIcon = html.match(/"icon_url"\s*:\s*"([^"]+)"/);
  if (mIcon && mIcon[1]) {
    const raw = mIcon[1].replace(/\\\//g, "/");
    return fullImageUrl(raw, "256fx256f");
  }
  const mImg = html.match(/https?:\/\/[^"' ]+\/economy\/image\/[^"' )]+/i);
  if (mImg && mImg[0]) {
    let img = mImg[0];
    if (!/\/\d+fx\d+f(?:$|[/?#])/.test(img)) {
      if (!img.endsWith("/")) img += "/";
      img += "256fx256f";
    }
    return img;
  }
  return null;
}

async function ensureImageFor(item) {
  if (item.image) return item.image;

  // 1) пробуємо швидкий маппінг із qwkdev/csapi
  const mapped = IMG_MAP.get(item.market_hash_name);
  if (mapped) {
    item.image = mapped;
    return mapped;
  }

  // 2) пам'ятковий кеш
  const key = `${item.appid}::${item.market_hash_name}`;
  if (IMAGE_CACHE.has(key)) return IMAGE_CACHE.get(key);

  // 3) fallback — парс листингу Steam
  const img = await fetchSteamListingImage(item.appid, item.market_hash_name);
  IMAGE_CACHE.set(key, img ?? null);
  if (img) item.image = img;
  return img;
}

/* ============== Public helpers ============== */

export async function resolveImage(appid, market_hash_name) {
  await ensureReady();
  // спершу qwkdev/csapi
  const fast = IMG_MAP.get(market_hash_name);
  if (fast) return fast;

  // далі — якщо є в каталозі
  const it = CATALOG.get(market_hash_name);
  if (it) {
    await ensureImageFor(it);
    return it.image ?? null;
  }

  // крайній випадок — парс сторінки
  const img = await fetchSteamListingImage(appid, market_hash_name);
  return img ?? null;
}

export function searchItems(q, limit = 10) {
  if (!q) return [];
  const s = q.toLowerCase();

  const scored = [];
  for (const it of CATALOG.values()) {
    const n = it.name.toLowerCase();
    const m = it.market_hash_name.toLowerCase();

    let score = -Infinity;
    if (n.startsWith(s)) score = 100 - n.length;
    else if (m.startsWith(s)) score = 90 - m.length;
    else if (n.includes(s)) score = 80 - n.indexOf(s);
    else if (m.includes(s)) score = 70 - m.indexOf(s);

    if (score > -Infinity) scored.push([score, it]);
    if (scored.length > 2000) break;
  }

  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, it]) => it);
}

export async function searchItemsWithImages(q, limit = 10) {
  await ensureReady();
  const list = searchItems(q, limit);
  await Promise.all(list.map((it) => ensureImageFor(it)));
  return list.map((it) => ({
    name: it.name,
    market_hash_name: it.market_hash_name,
    appid: it.appid,
    image: it.image ?? null,
    price: it.steam?.price ?? null,
    currency: it.steam?.currency ?? "USD",
  }));
}

export async function lookupItemsAsync(names = []) {
  await ensureReady();
  const out = {};
  const items = [];
  for (const name of names) {
    const it = CATALOG.get(name);
    if (!it) continue;
    items.push(it);
  }
  await Promise.all(items.map((it) => ensureImageFor(it)));
  for (const it of items) {
    out[it.market_hash_name] = {
      name: it.name,
      image: it.image ?? null,
      icon_url: it.icon_url ?? null,
      price: it.steam?.price ?? null,
      currency: it.steam?.currency ?? "USD",
      appid: it.appid,
    };
  }
  return out;
}

export function catalogSize() {
  return CATALOG.size;
}
export function getItem(mhn) {
  return CATALOG.get(mhn) ?? null;
}

// Автооновлення: ціни — кожні 15 хв, картинки — кожні 6 год
const REFRESH_MS = Number(process.env.ITEMS_REFRESH_MS || 15 * 60 * 1000);
const REFRESH_IMG_MS = Number(process.env.ITEMS_IMAGES_REFRESH_MS || 6 * 60 * 60 * 1000);

setInterval(() => { refreshCatalog().catch(() => void 0); }, REFRESH_MS);
setInterval(() => { refreshImageMap().catch(() => void 0); }, REFRESH_IMG_MS);

// Пробуємо підтягнути картмап одразу на старті
refreshImageMap().catch(() => void 0);
