/**
 * Shared checkout-field resolver.
 *
 * Resolves the ordered list of checkout field definitions for a product:
 *   product override  >  catalog fields  >  parent-catalog fields  >  legacy fallback
 *
 * Used by both the order wizard (orderScene) and the coin-reward redemption
 * flow (rewardScene) so field logic stays in ONE place.
 */

const Catalog = require('../models/Catalog');

// Games that require a Zone / Server ID (legacy fallback for products with no catalog)
const ZONE_REQUIRED = ['mobile legends', 'ml', 'moonton'];

function needsZone(gameName = '') {
  return ZONE_REQUIRED.some((g) => gameName.toLowerCase().includes(g));
}

async function resolveCheckoutFields(product) {
  // Product has explicit override (empty array means "no fields")
  if (Array.isArray(product.checkoutFieldsOverride) && product.checkoutFieldsOverride !== null) {
    return product.checkoutFieldsOverride
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }
  // Pull from catalog (or parent catalog if sub-catalog has no fields)
  if (product.catalogId) {
    const catalog = await Catalog.findById(product.catalogId).lean();
    if (catalog?.checkoutFields?.length) {
      return catalog.checkoutFields
        .slice()
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }
    // Sub-catalog with no fields → inherit from parent catalog
    if (catalog?.parentCategory) {
      const parent = await Catalog.findById(catalog.parentCategory).lean();
      if (parent?.checkoutFields?.length) {
        return parent.checkoutFields
          .slice()
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      }
    }
  }
  // Legacy fallback: DirectTopup products always need a Game ID
  if (product.productType === 'DirectTopup') {
    return [
      { key: 'game_id', label: 'Game ID', fieldType: 'text', required: true, placeholder: 'Enter your Player ID' },
      ...(needsZone(product.category || product.name)
        ? [{ key: 'zone_id', label: 'Server ID', fieldType: 'number', required: true, placeholder: 'Your Server / Zone ID' }]
        : []),
    ];
  }
  return [];
}

module.exports = { resolveCheckoutFields, needsZone, ZONE_REQUIRED };
