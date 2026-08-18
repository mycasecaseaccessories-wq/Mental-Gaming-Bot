const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatGroupedProductAnnouncement,
  groupedProductKeyboard,
} = require('../src/services/BroadcastService');

const products = [
  {
    _id: '507f1f77bcf86cd799439011',
    name: 'Claude Premium Seat 1 Month',
    finalPrice: 7425,
    isActive: true,
  },
  {
    _id: '507f1f77bcf86cd799439012',
    name: 'Perplexity PRO 1 Year',
    finalPrice: 4000,
    flashSalePrice: 3500,
    flashSaleEnd: new Date('2030-01-01T12:00:00.000Z'),
    isActive: true,
  },
];

test('grouped normal announcement includes all products in one message', () => {
  const text = formatGroupedProductAnnouncement(products, 'new');
  assert.match(text, /NEW PRODUCTS/);
  assert.match(text, /Claude Premium Seat 1 Month/);
  assert.match(text, /Perplexity PRO 1 Year/);
  assert.match(text, /7,425 KS/);
  assert.match(text, /4,000 KS/);
});

test('grouped flash announcement includes sale prices and earliest expiry', () => {
  const text = formatGroupedProductAnnouncement(products.map((product) => ({
    ...product,
    flashSalePrice: product.flashSalePrice || Math.round(product.finalPrice * 0.9),
    flashSaleEnd: product.flashSaleEnd || new Date('2030-01-01T12:00:00.000Z'),
  })), 'flash');
  assert.match(text, /FLASH SALE/);
  assert.match(text, /3,500 KS/);
  assert.match(text, /Ends at:/);
});

test('grouped keyboard provides one direct purchase button per product', () => {
  const keyboard = groupedProductKeyboard(products);
  assert.equal(keyboard.reply_markup.inline_keyboard.length, 2);
  assert.match(keyboard.reply_markup.inline_keyboard[0][0].url, /start=product_507f1f77bcf86cd799439011/);
  assert.match(keyboard.reply_markup.inline_keyboard[1][0].url, /start=product_507f1f77bcf86cd799439012/);
});
