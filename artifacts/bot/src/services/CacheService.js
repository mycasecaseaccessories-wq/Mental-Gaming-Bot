/**
 * CacheService — In-memory cache layer (node-cache) for high-frequency reads.
 *
 * Reduces MongoDB round-trips for:
 *   - Currency rates      (TTL: 15 minutes)
 *   - Product listings    (TTL: 5 minutes; invalidated on admin change)
 *   - SystemStatus        (TTL: 60 seconds)
 *
 * Cache-aside pattern: getOrSet(key, fetchFn, ttl)
 *   → Checks cache first; on miss calls fetchFn, stores result, returns it.
 *
 * Cache invalidation:
 *   invalidateProducts()  — call after any product create/update/delete
 *   invalidateRates()     — call after any currency rate change
 *   invalidateStatus()    — call after SystemStatus.set()
 */

const NodeCache = require('node-cache');

// Single shared cache instance; useClones:false avoids deep-copy overhead
const cache = new NodeCache({
  stdTTL:      300,       // default 5-min TTL
  checkperiod: 60,        // scan for expired keys every 60s
  useClones:   false,     // return references (callers must not mutate)
  deleteOnExpire: true,
});

// ── Cache key constants ───────────────────────────────────────────────────────

const KEYS = {
  CURRENCY_RATES:    'currency_rates',
  PRODUCTS_ALL:      'products_all',
  PRODUCTS_CAT:      (cat) => `products_cat:${encodeURIComponent(cat)}`,
  PRODUCTS_FLASH:    'products_flash',
  SYSTEM_STATUS:     'system_status',
};

const TTL = {
  CURRENCY_RATES: 15 * 60,   // 15 minutes
  PRODUCTS:        5 * 60,   // 5 minutes
  SYSTEM_STATUS:       60,   // 1 minute
};

// ── Core cache-aside helper ───────────────────────────────────────────────────

async function getOrSet(key, fetchFn, ttl = 300) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const data = await fetchFn();
  if (data !== undefined && data !== null) {
    cache.set(key, data, ttl);
  }
  return data;
}

// ── Currency rates ────────────────────────────────────────────────────────────

async function getCachedRates() {
  return getOrSet(
    KEYS.CURRENCY_RATES,
    () => require('../models/Currency').find().sort({ currencyCode: 1 }),
    TTL.CURRENCY_RATES,
  );
}

function invalidateRates() {
  cache.del(KEYS.CURRENCY_RATES);
}

// ── Product listings ──────────────────────────────────────────────────────────

/**
 * Get active products for a specific category (used by shop navigation).
 * Cached per category — one cache entry per category string.
 */
async function getCachedProducts(category) {
  const key = KEYS.PRODUCTS_CAT(category);
  return getOrSet(
    key,
    () => require('../models/Product')
      .find({ category, isActive: true })
      .sort({ finalPrice: 1 }),
    TTL.PRODUCTS,
  );
}

/**
 * Get active products belonging to a catalog (used by catalog-driven shop nav).
 * Matches by catalogId OR legacy category name (for products without catalogId).
 * Cached per catalog id; key starts with "products" so invalidateProducts() clears it.
 */
async function getCachedCatalogProducts(catalogId, categoryName) {
  const key = `products_catalog:${String(catalogId)}`;
  return getOrSet(
    key,
    () => require('../models/Product')
      .find({
        isActive: true,
        $or: [
          { catalogId },
          { catalogId: { $in: [null, undefined] }, category: categoryName },
        ],
      })
      .sort({ finalPrice: 1 }),
    TTL.PRODUCTS,
  );
}

/**
 * Get all active products (used by analytics and export views).
 */
async function getAllCachedProducts() {
  return getOrSet(
    KEYS.PRODUCTS_ALL,
    () => require('../models/Product').find({ isActive: true }).sort({ category: 1, finalPrice: 1 }),
    TTL.PRODUCTS,
  );
}

/**
 * Get currently active flash-sale products.
 */
async function getCachedFlashProducts() {
  return getOrSet(
    KEYS.PRODUCTS_FLASH,
    () => {
      const now = new Date();
      return require('../models/Product').find({
        isActive: true,
        flashSalePrice: { $ne: null },
        flashSaleStart: { $lte: now },
        flashSaleEnd:   { $gte: now },
      });
    },
    60, // Flash sales change frequently — 1-min TTL
  );
}

/**
 * Invalidate all product-related cache entries.
 * Call this whenever an admin creates, updates, or deletes a product.
 */
function invalidateProducts() {
  const keys = cache.keys().filter((k) => k.startsWith('products'));
  if (keys.length) cache.del(keys);
}

// ── SystemStatus ──────────────────────────────────────────────────────────────

async function getCachedStatus() {
  return getOrSet(
    KEYS.SYSTEM_STATUS,
    () => require('../models/SystemStatus').get(),
    TTL.SYSTEM_STATUS,
  );
}

function invalidateStatus() {
  cache.del(KEYS.SYSTEM_STATUS);
}

// ── Cache stats (for /sysinfo) ─────────────────────────────────────────────────

function getStats() {
  const stats = cache.getStats();
  const keys  = cache.keys();
  const hitRate = (stats.hits + stats.misses) > 0
    ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
    : 0;

  return {
    keys:     keys.length,
    hits:     stats.hits,
    misses:   stats.misses,
    hitRate,
    ksize:    stats.ksize,
    vsize:    stats.vsize,
    keyList:  keys,
  };
}

/** Flush the entire cache (used by CronService nightly). */
function flushAll() {
  cache.flushAll();
}

module.exports = {
  KEYS,
  TTL,
  getOrSet,
  getCachedRates,
  invalidateRates,
  getCachedProducts,
  getCachedCatalogProducts,
  getAllCachedProducts,
  getCachedFlashProducts,
  invalidateProducts,
  getCachedStatus,
  invalidateStatus,
  getStats,
  flushAll,
  // Expose raw cache for advanced use
  _cache: cache,
};
