/**
 * ExternalApiService — Modular provider bridge for game top-up APIs.
 *
 * Architecture:
 *   BaseProvider (interface) → SmileOneProvider | UniPinProvider | CodashopProvider
 *
 * Provider registry is keyed by provider slug ('smileone', 'unipin', 'codashop').
 * Each Product can have deliveryMode: 'Manual' | 'Auto' and an apiProvider slug.
 *
 * Admin toggle: /toggledelivery <productId>
 *
 * To add a new provider:
 *   1. Extend BaseProvider
 *   2. Register in PROVIDERS map
 *   3. Set product.apiProvider = 'your_slug' in the database
 */

const axios  = require('axios');
const Product     = require('../models/Product');
const ProviderLog = require('../models/ProviderLog');

// ── Base Provider Interface ────────────────────────────────────────────────────

class BaseProvider {
  constructor(config) {
    this.config  = config;
    this.name    = config.name;
    this.baseUrl = config.baseUrl;
    this.enabled = !!config.enabled;
  }

  /**
   * Top up a player's account.
   * @returns {{ success: Boolean, externalRef: String|null, message: String }}
   */
  async topup({ playerId, zoneId, productSku, quantity, orderId }) {
    throw new Error(`${this.name}: topup() not implemented`);
  }

  /**
   * Verify a player's existence and return their nickname.
   * @returns {{ valid: Boolean, nickname: String|null, error: String|null }}
   */
  async verifyPlayer(playerId, zoneId) {
    throw new Error(`${this.name}: verifyPlayer() not implemented`);
  }

  /**
   * Check the provider's current credit/balance.
   * @returns {{ balance: Number|null, currency: String, error: String|null }}
   */
  async checkBalance() {
    throw new Error(`${this.name}: checkBalance() not implemented`);
  }

  /**
   * Helper: make an authenticated HTTP request and log it.
   */
  async _request({ method = 'POST', path, data = {}, orderId = null, action = 'request' }) {
    const url  = `${this.baseUrl}${path}`;
    const t0   = Date.now();
    let response = null;

    try {
      response = await axios({
        method,
        url,
        data,
        headers: this._headers(),
        timeout: 15000,
      });

      const duration = Date.now() - t0;
      await ProviderLog.create({
        orderId,
        provider: this.name,
        action,
        externalRef: response.data?.order_id || response.data?.transactionId || null,
        requestData: this._sanitize(data),
        statusCode: response.status,
        responseData: response.data,
        success: true,
        durationMs: duration,
      });

      return { ok: true, data: response.data, status: response.status };
    } catch (err) {
      const duration = Date.now() - t0;
      await ProviderLog.create({
        orderId,
        provider: this.name,
        action,
        requestData: this._sanitize(data),
        statusCode: err.response?.status || null,
        responseData: err.response?.data || {},
        success: false,
        errorMessage: err.message,
        durationMs: duration,
      }).catch(() => {});

      return { ok: false, error: err.message, status: err.response?.status || 0 };
    }
  }

  _headers() { return { 'Content-Type': 'application/json' }; }

  // Remove secrets from logged data
  _sanitize(obj) {
    const clone = { ...obj };
    const sensitiveKeys = ['secret', 'password', 'token', 'key', 'apiKey'];
    for (const k of sensitiveKeys) delete clone[k];
    return clone;
  }
}

// ── SmileOne Provider ─────────────────────────────────────────────────────────
// API docs: https://developer.smile.one/
// Supports: Mobile Legends, Genshin Impact, Free Fire (Brazil/global)

class SmileOneProvider extends BaseProvider {
  constructor(cfg) {
    super({ name: 'smileone', baseUrl: 'https://api.smile.one/v1', ...cfg });
    this.userId     = cfg.userId     || process.env.SMILEONE_USER_ID;
    this.userSecret = cfg.userSecret || process.env.SMILEONE_SECRET;
  }

  _headers() {
    const ts = Math.floor(Date.now() / 1000).toString();
    const crypto = require('crypto');
    const sign = crypto
      .createHmac('md5', this.userSecret || '')
      .update(`${this.userId}${ts}`)
      .digest('hex');

    return {
      'Content-Type': 'application/json',
      'user-id': this.userId || '',
      'sign': sign,
      'time': ts,
    };
  }

  async topup({ playerId, zoneId, productSku, quantity = 1, orderId }) {
    if (!this.enabled) return { success: false, message: 'SmileOne provider is disabled' };

    const result = await this._request({
      method: 'POST',
      path: '/topup',
      data: {
        role_id:    playerId,
        zone_id:    zoneId,
        product_id: productSku,
        quantity,
        order_id:   orderId?.toString(),
      },
      orderId,
      action: 'topup',
    });

    if (!result.ok) return { success: false, message: result.error };

    const d = result.data;
    if (d?.status === 'success' || d?.code === 0) {
      return { success: true, externalRef: d.order_id || d.transactionId, message: d.message };
    }
    return { success: false, message: d?.message || 'Unknown SmileOne error' };
  }

  async verifyPlayer(playerId, zoneId) {
    if (!this.enabled) return { valid: false, nickname: null, error: 'Provider disabled' };

    const result = await this._request({
      method: 'POST',
      path: '/checkrole',
      data: { role_id: playerId, zone_id: zoneId },
      action: 'verifyPlayer',
    });

    if (!result.ok) return { valid: false, nickname: null, error: result.error };

    const d = result.data;
    if (d?.status === 'success' && d?.role_name) {
      return { valid: true, nickname: d.role_name, error: null };
    }
    return { valid: false, nickname: null, error: d?.message || 'Player not found' };
  }

  async checkBalance() {
    const result = await this._request({ method: 'GET', path: '/balance', action: 'checkBalance' });
    if (!result.ok) return { balance: null, currency: 'USD', error: result.error };
    return {
      balance:  result.data?.balance ?? null,
      currency: result.data?.currency || 'USD',
      error:    null,
    };
  }
}

// ── UniPin Provider ───────────────────────────────────────────────────────────
// Stub — fill in when API keys are obtained

class UniPinProvider extends BaseProvider {
  constructor(cfg) {
    super({ name: 'unipin', baseUrl: 'https://unipin-api.example.com', ...cfg });
    this.apiKey = cfg.apiKey || process.env.UNIPIN_API_KEY;
  }

  _headers() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey || ''}` };
  }

  async topup({ playerId, zoneId, productSku, quantity, orderId }) {
    // TODO: Implement when UniPin API keys are provisioned
    return { success: false, message: 'UniPin integration pending API key setup' };
  }

  async verifyPlayer(playerId, zoneId) {
    return { valid: false, nickname: null, error: 'UniPin player verification not yet implemented' };
  }

  async checkBalance() {
    return { balance: null, currency: 'USD', error: 'UniPin balance check not yet implemented' };
  }
}

// ── Codashop Provider ─────────────────────────────────────────────────────────
// Stub — Codashop doesn't have a public reseller API yet; placeholder for future

class CodashopProvider extends BaseProvider {
  constructor(cfg) {
    super({ name: 'codashop', baseUrl: 'https://codashop-api.example.com', ...cfg });
  }

  async topup() {
    return { success: false, message: 'Codashop reseller API not yet available' };
  }

  async verifyPlayer() {
    return { valid: false, nickname: null, error: 'Not implemented' };
  }

  async checkBalance() {
    return { balance: null, currency: 'USD', error: 'Not implemented' };
  }
}

// ── Provider Registry ─────────────────────────────────────────────────────────

const PROVIDER_CLASSES = { smileone: SmileOneProvider, unipin: UniPinProvider, codashop: CodashopProvider };

const _instances = {};

function getProvider(slug) {
  if (!_instances[slug]) {
    const Cls = PROVIDER_CLASSES[slug];
    if (!Cls) return null;
    _instances[slug] = new Cls({ enabled: true });
  }
  return _instances[slug];
}

// ── Core: process an order via external API ───────────────────────────────────

async function processOrderViaApi(order, product) {
  if (!product) product = await Product.findById(order.productId);
  if (!product) return { success: false, manual: false, message: 'Product not found' };
  if (product.deliveryMode !== 'Auto' || !product.apiProvider) {
    return { success: false, manual: true, message: 'Product is in Manual delivery mode' };
  }

  const provider = getProvider(product.apiProvider);
  if (!provider) return { success: false, manual: true, message: `Unknown provider: ${product.apiProvider}` };

  return provider.topup({
    playerId:   order.gameId,
    zoneId:     order.zoneId,
    productSku: product.apiProductSku,
    quantity:   product.quantity || 1,
    orderId:    order._id,
  });
}

// ── Toggle product delivery mode ──────────────────────────────────────────────

async function toggleDeliveryMode(productId) {
  const product = await Product.findById(productId);
  if (!product) return null;

  const newMode = product.deliveryMode === 'Auto' ? 'Manual' : 'Auto';
  product.deliveryMode = newMode;
  await product.save();
  return product;
}

async function setProviderConfig(productId, providerSlug, productSku) {
  return Product.findByIdAndUpdate(
    productId,
    { $set: { apiProvider: providerSlug, apiProductSku: productSku, deliveryMode: 'Auto' } },
    { new: true }
  );
}

// ── Provider health check ─────────────────────────────────────────────────────

async function checkAllProviders() {
  const results = {};
  for (const [slug, Cls] of Object.entries(PROVIDER_CLASSES)) {
    const p = getProvider(slug);
    try {
      const bal = await p.checkBalance();
      results[slug] = { slug, enabled: p.enabled, balance: bal.balance, currency: bal.currency, error: bal.error };
    } catch (err) {
      results[slug] = { slug, enabled: p.enabled, error: err.message };
    }
  }
  return results;
}

// ── Recent provider log summary ───────────────────────────────────────────────

async function getProviderStats(hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000);
  return ProviderLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id:         '$provider',
        total:       { $sum: 1 },
        success:     { $sum: { $cond: ['$success', 1, 0] } },
        avgDuration: { $avg: '$durationMs' },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

module.exports = {
  processOrderViaApi,
  toggleDeliveryMode,
  setProviderConfig,
  checkAllProviders,
  getProviderStats,
  getProvider,
  BaseProvider,
  SmileOneProvider,
  UniPinProvider,
};
