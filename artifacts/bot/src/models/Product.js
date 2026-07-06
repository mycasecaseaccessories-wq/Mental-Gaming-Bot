const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    region:   { type: String, required: true, trim: true },

    productType: {
      type:    String,
      enum:    ['DirectTopup', 'DigitalCode'],
      default: 'DirectTopup',
      comment: 'DirectTopup = admin delivers manually | DigitalCode = code pulled from DB',
    },

    baseCurrency: { type: String, enum: ['BRL', 'PHP', 'USD', 'MMK'], required: true },
    baseCost:     { type: Number, required: true, min: 0 },
    quantity:     { type: Number, default: 1 },

    profitMode:    { type: String, enum: ['percentage', 'fixedUnit'], default: 'percentage' },
    profitMargin:  { type: Number, default: 10, min: 0 },
    baseUnit:      { type: Number, default: null },
    baseProfitKS:  { type: Number, default: null },

    suggestedPrice: { type: Number, default: null },
    finalPrice:     { type: Number, required: true, min: 0 },

    stockCount:            { type: Number, default: -1, comment: '-1 = unlimited' },
    stockWarningThreshold: { type: Number, default: 5 },
    // null = unlimited qty per order (UI shows up to 10); 1 = no qty selector; N = max N per order
    maxQuantity:           { type: Number, default: null },

    pricingMode: { type: String, enum: ['Auto', 'Manual'], default: 'Auto' },
    isApiEnabled: { type: Boolean, default: false },
    isActive:     { type: Boolean, default: true },

    // ── Availability Status ───────────────────────────────────────────────────
    // 'active'       → orderable
    // 'out_of_stock' → visible, cannot order
    // 'coming_soon'  → visible, disabled, shows "Coming Soon" badge
    // 'hidden'       → not shown in mini app or shop listings
    status: {
      type:    String,
      enum:    ['active', 'out_of_stock', 'coming_soon', 'hidden'],
      default: 'active',
    },
    imageUrl:     { type: String, default: null },
    description:  { type: String, default: '' },

    // ── Flash Sale ───────────────────────────────────────────────────────────
    flashSalePrice:    { type: Number,  default: null },
    flashSaleStart:    { type: Date,    default: null },
    flashSaleEnd:      { type: Date,    default: null },
    flashSaleNotified: { type: Boolean, default: false },

    // ── Bundle ───────────────────────────────────────────────────────────────
    bundleGroup: {
      type:    String,
      default: null,
      comment: 'Products sharing same bundleGroup get 5% off when 2+ are bought',
    },

    // ── Catalog ───────────────────────────────────────────────────────────────
    catalogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Catalog',
      default: null,
      index: true,
    },
    sortOrder: { type: Number, default: 0 },

    // ── Checkout field overrides (null = use catalog defaults) ────────────────
    checkoutFieldsOverride: {
      type: [{
        key:         { type: String, required: true },
        label:       { type: String, required: true },
        fieldType:   { type: String, enum: ['text', 'number', 'email', 'textarea'], default: 'text' },
        required:    { type: Boolean, default: true },
        placeholder: { type: String, default: '' },
        helpText:    { type: String, default: '' },
        sortOrder:   { type: Number, default: 0 },
      }],
      default: null,
      comment: 'null = inherit from catalog; [] = no fields required; array = override',
    },

    // Stash of a custom checkout override while the product is temporarily set to
    // "no fields" ([]), so toggling back restores the custom fields instead of losing them.
    previousCheckoutFieldsOverride: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ── External API / Auto-Delivery ─────────────────────────────────────────
    // deliveryMode: 'Manual' = staff fulfils manually  |  'Auto' = sent via provider API
    deliveryMode: {
      type:    String,
      enum:    ['Manual', 'Auto'],
      default: 'Manual',
      index:   true,
    },
    apiProvider: {
      type:    String,
      default: null,
      comment: 'Provider slug: smileone | unipin | codashop',
    },
    apiProductSku: {
      type:    String,
      default: null,
      comment: "Provider's internal product ID / SKU",
    },
  },
  { timestamps: true, versionKey: false }
);

productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ region: 1 });
productSchema.index({ baseCurrency: 1, pricingMode: 1 });
productSchema.index({ flashSaleEnd: 1 });

productSchema.methods.isInStock = function () {
  return this.stockCount === -1 || this.stockCount > 0;
};

productSchema.methods.isLowStock = function () {
  return this.stockCount !== -1 && this.stockCount > 0 && this.stockCount <= this.stockWarningThreshold;
};

productSchema.methods.getEffectivePrice = function () {
  const now = new Date();
  if (
    this.flashSalePrice &&
    this.flashSaleStart &&
    this.flashSaleEnd &&
    now >= this.flashSaleStart &&
    now <= this.flashSaleEnd
  ) {
    const msLeft = this.flashSaleEnd - now;
    return { price: this.flashSalePrice, isFlashSale: true, msLeft };
  }
  return { price: this.finalPrice, isFlashSale: false, msLeft: 0 };
};

module.exports = mongoose.model('Product', productSchema);
