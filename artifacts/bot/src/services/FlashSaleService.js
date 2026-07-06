/**
 * FlashSaleService
 *
 * Checks if a product has an active flash sale.
 * Provides countdown formatting.
 * Runs a cron-style check to notify admin channel when a sale starts.
 */

const Product = require('../models/Product');
const { config } = require('../../config/settings');

// ── Countdown formatter: ms → HH:MM:SS ───────────────────────────────────────
function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Get effective price with flash sale context ─────────────────────────────
function getEffectivePrice(product) {
  return product.getEffectivePrice();
}

// ── Flash sale label for product buttons ─────────────────────────────────────
function flashLabel(product) {
  const { isFlashSale, msLeft } = product.getEffectivePrice();
  if (!isFlashSale) return '';
  return `🔥 FLASH SALE — ⏳ ${formatCountdown(msLeft)}`;
}

// ── Activate a flash sale (admin command) ─────────────────────────────────────
async function activateFlashSale(productId, salePrice, startDate, endDate) {
  const product = await Product.findByIdAndUpdate(
    productId,
    {
      flashSalePrice: salePrice,
      flashSaleStart: startDate,
      flashSaleEnd: endDate,
      flashSaleNotified: false,
    },
    { new: true }
  );
  if (!product) throw new Error('Product not found');
  return product;
}

// ── Deactivate a flash sale ────────────────────────────────────────────────────
async function deactivateFlashSale(productId) {
  return Product.findByIdAndUpdate(
    productId,
    { flashSalePrice: null, flashSaleStart: null, flashSaleEnd: null, flashSaleNotified: false },
    { new: true }
  );
}

// ── Get all currently active flash sales ─────────────────────────────────────
async function getActiveFlashSales() {
  const now = new Date();
  return Product.find({
    flashSalePrice: { $ne: null },
    flashSaleStart: { $lte: now },
    flashSaleEnd: { $gte: now },
    isActive: true,
  });
}

// ── Notify channel for newly started flash sales (call from a cron job) ───────
async function notifyNewFlashSales(telegram) {
  const now = new Date();
  const starting = await Product.find({
    flashSalePrice: { $ne: null },
    flashSaleStart: { $lte: now },
    flashSaleEnd: { $gte: now },
    flashSaleNotified: false,
    isActive: true,
  });

  for (const product of starting) {
    const { price: salePrice, msLeft } = product.getEffectivePrice();
    const savings = product.finalPrice - salePrice;
    const pct = Math.round((savings / product.finalPrice) * 100);

    const msg =
      `🔥 *FLASH SALE STARTED!*\n\n` +
      `📦 *${product.name}*\n` +
      `💰 Sale Price: *${salePrice.toLocaleString()} KS* _(was ${product.finalPrice.toLocaleString()} KS)_\n` +
      `📉 Save: *${savings.toLocaleString()} KS (${pct}% off)*\n` +
      `⏳ Ends in: *${formatCountdown(msLeft)}*\n\n` +
      `_Shop now → /shop_`;

    try {
      const target = config.bot.newsChannelId || config.bot.adminId;
      await telegram.sendMessage(target, msg, { parse_mode: 'Markdown' });
      await Product.findByIdAndUpdate(product._id, { flashSaleNotified: true });
    } catch (err) {
      console.error('[FlashSale] Notify failed:', err.message);
    }
  }

  // Auto-expire ended sales
  await Product.updateMany(
    { flashSaleEnd: { $lt: now }, flashSaleNotified: true },
    { flashSalePrice: null, flashSaleStart: null, flashSaleEnd: null, flashSaleNotified: false }
  );
}

// ── Start the background flash sale checker (every 60s) ─────────────────────
function startFlashSaleWatcher(telegram) {
  notifyNewFlashSales(telegram).catch(() => {});
  return setInterval(() => {
    notifyNewFlashSales(telegram).catch(() => {});
  }, 60_000);
}

module.exports = {
  formatCountdown,
  getEffectivePrice,
  flashLabel,
  activateFlashSale,
  deactivateFlashSale,
  getActiveFlashSales,
  notifyNewFlashSales,
  startFlashSaleWatcher,
};
