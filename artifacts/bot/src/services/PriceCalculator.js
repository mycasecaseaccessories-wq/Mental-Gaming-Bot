/**
 * PriceCalculator
 *
 * Calculates a SuggestedPrice for a product given a currency rate.
 * NEVER writes to the database — it only returns computed values.
 * The Admin must explicitly approve before finalPrice is updated.
 *
 * Profit Modes:
 *   percentage  → SuggestedPrice = ceil(baseCost × rateToMMK × (1 + margin/100))
 *   fixedUnit   → profit scales linearly with quantity:
 *                 profit = (quantity / baseUnit) × baseProfitKS
 *                 SuggestedPrice = ceil(baseCost × rateToMMK) + profit
 */

const Product = require('../models/Product');
const Currency = require('../models/Currency');

/**
 * Calculate suggested price for a single product.
 * @param {Object} product  - Mongoose Product document
 * @param {number} rateToMMK - Exchange rate: 1 unit baseCurrency = X MMK
 * @returns {{ suggestedPrice: number, breakdown: Object } | null}
 */
function calculateSuggested(product, rateToMMK) {
  if (product.pricingMode === 'Manual') return null;

  const convertedCost = product.baseCost * rateToMMK;

  let profit = 0;
  let profitBreakdown = {};

  if (product.profitMode === 'fixedUnit') {
    if (!product.baseUnit || !product.baseProfitKS) {
      console.warn(`[PriceCalc] Product "${product.name}" is fixedUnit but missing baseUnit/baseProfitKS — falling back to 0 profit`);
      profit = 0;
      profitBreakdown = { mode: 'fixedUnit', error: 'missing baseUnit or baseProfitKS' };
    } else {
      profit = Math.ceil((product.quantity / product.baseUnit) * product.baseProfitKS);
      profitBreakdown = {
        mode: 'fixedUnit',
        quantity: product.quantity,
        baseUnit: product.baseUnit,
        baseProfitKS: product.baseProfitKS,
        scaledProfit: profit,
      };
    }
    const suggestedPrice = Math.ceil(convertedCost) + profit;
    return {
      suggestedPrice,
      breakdown: {
        baseCost: product.baseCost,
        currency: product.baseCurrency,
        rateToMMK,
        convertedCost: Math.ceil(convertedCost),
        profit,
        suggestedPrice,
        ...profitBreakdown,
      },
    };
  }

  // Default: percentage
  const margin = product.profitMargin ?? 10;
  const suggestedPrice = Math.ceil(convertedCost * (1 + margin / 100));
  profit = suggestedPrice - Math.ceil(convertedCost);

  return {
    suggestedPrice,
    breakdown: {
      mode: 'percentage',
      baseCost: product.baseCost,
      currency: product.baseCurrency,
      rateToMMK,
      convertedCost: Math.ceil(convertedCost),
      marginPct: margin,
      profit,
      suggestedPrice,
    },
  };
}

/**
 * Preview: compute suggested prices for ALL Auto products linked to a currency.
 * Does NOT save anything to DB.
 *
 * @param {string} currencyCode - e.g. 'BRL'
 * @param {number} newRate      - new rateToMMK
 * @returns {Array<{ product, oldPrice, suggestedPrice, diff, breakdown }>}
 */
async function previewCurrencyImpact(currencyCode, newRate) {
  const products = await Product.find({
    baseCurrency: currencyCode.toUpperCase(),
    pricingMode: 'Auto',
    isActive: true,
  });

  const results = [];
  for (const product of products) {
    const calc = calculateSuggested(product, newRate);
    if (!calc) continue;

    results.push({
      product,
      oldPrice: product.finalPrice,
      suggestedPrice: calc.suggestedPrice,
      diff: calc.suggestedPrice - product.finalPrice,
      breakdown: calc.breakdown,
    });
  }

  return results;
}

/**
 * Apply: save suggestedPrice to each product's suggestedPrice field (not finalPrice yet).
 * Admin must call approveSuggestions() to commit.
 */
async function storeSuggestions(previews) {
  const ops = previews.map(({ product, suggestedPrice }) => ({
    updateOne: {
      filter: { _id: product._id },
      update: { $set: { suggestedPrice } },
    },
  }));

  if (ops.length > 0) await Product.bulkWrite(ops);
  return ops.length;
}

/**
 * Approve All: commit all pending suggestedPrices to finalPrice for a given currency.
 */
async function approveAllSuggestions(currencyCode) {
  const products = await Product.find({
    baseCurrency: currencyCode.toUpperCase(),
    pricingMode: 'Auto',
    isActive: true,
    suggestedPrice: { $ne: null },
  });

  const ops = products.map((p) => ({
    updateOne: {
      filter: { _id: p._id },
      update: { $set: { finalPrice: p.suggestedPrice }, $unset: { suggestedPrice: '' } },
    },
  }));

  if (ops.length > 0) await Product.bulkWrite(ops);
  return ops.length;
}

/**
 * Approve a single product's suggested price.
 */
async function approveSingleProduct(productId) {
  const product = await Product.findById(productId);
  if (!product || product.suggestedPrice == null) throw new Error('No pending suggestion for this product');

  product.finalPrice = product.suggestedPrice;
  product.suggestedPrice = null;
  await product.save();
  return product;
}

/**
 * Override a single product manually and lock it to Manual mode.
 */
async function setManualPrice(productId, newPrice) {
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');

  product.pricingMode = 'Manual';
  product.finalPrice = newPrice;
  product.suggestedPrice = null;
  await product.save();
  return product;
}

/**
 * calcTierDiscount — Apply membership tier discount to an order price.
 *
 * Tier rates (defined in MembershipService):
 *   Silver   → 0%
 *   Gold     → 2%
 *   Platinum → 5%
 *
 * Called at checkout (orderScene Step 0) AFTER flash-sale price is resolved
 * and BEFORE promo code discount is applied.
 *
 * @param {number} basePrice  - price after flash sale, before promo
 * @param {string} tier       - 'Silver' | 'Gold' | 'Platinum'
 * @returns {{ finalPrice: number, discount: number, pct: number }}
 */
function calcTierDiscount(basePrice, tier) {
  const { applyTierDiscount } = require('./MembershipService');
  return applyTierDiscount(basePrice, tier);
}

module.exports = {
  calculateSuggested,
  previewCurrencyImpact,
  storeSuggestions,
  approveAllSuggestions,
  approveSingleProduct,
  setManualPrice,
  calcTierDiscount,
};
