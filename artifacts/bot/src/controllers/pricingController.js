const Product = require('../models/Product');
const Currency = require('../models/Currency');

async function computeProductPrice(product) {
  if (product.pricingMode === 'Manual') {
    return product.finalPrice;
  }

  const rate = await Currency.getRate(product.baseCurrency);
  if (!rate) {
    console.warn(`[Pricing] No exchange rate found for ${product.baseCurrency}, using stored finalPrice`);
    return product.finalPrice;
  }

  return product.computeFinalPrice(rate);
}

async function refreshAllAutoPricedProducts() {
  const products = await Product.find({ pricingMode: 'Auto', isActive: true });
  let updated = 0;

  for (const product of products) {
    const rate = await Currency.getRate(product.baseCurrency);
    if (!rate) continue;

    const newPrice = product.computeFinalPrice(rate);
    if (newPrice !== product.finalPrice) {
      product.finalPrice = newPrice;
      await product.save();
      updated++;
    }
  }

  console.log(`[Pricing] Refreshed ${updated}/${products.length} auto-priced products`);
  return updated;
}

async function setManualPrice(productId, newPrice, adminId) {
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');

  product.pricingMode = 'Manual';
  product.finalPrice = newPrice;
  await product.save();

  return product;
}

module.exports = { computeProductPrice, refreshAllAutoPricedProducts, setManualPrice };
