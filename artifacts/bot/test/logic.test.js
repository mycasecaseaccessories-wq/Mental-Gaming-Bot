/**
 * Pure-logic unit tests (no DB, no network). Run with `pnpm --filter @workspace/bot test`.
 * Covers the loyalty tier resolver and shared UI formatting helpers — the bits
 * that must stay in lock-step with the mini-app's tier/display logic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const TierService = require('../src/services/TierService');
const { truncate, price } = require('../src/utils/ui');

test('getTierForAmount maps lifetime/active spend to the correct tier', () => {
  assert.equal(TierService.getTierForAmount(0).id, 'Bronze');
  assert.equal(TierService.getTierForAmount(499_999).id, 'Bronze');
  assert.equal(TierService.getTierForAmount(500_000).id, 'Silver');
  assert.equal(TierService.getTierForAmount(1_999_999).id, 'Silver');
  assert.equal(TierService.getTierForAmount(2_000_000).id, 'Gold');
  assert.equal(TierService.getTierForAmount(6_000_000).id, 'Platinum');
  assert.equal(TierService.getTierForAmount(10_000_000).id, 'Diamond');
  assert.equal(TierService.getTierForAmount(999_999_999).id, 'Diamond');
});

test('getNextTier steps upward and caps at the top tier', () => {
  assert.equal(TierService.getNextTier('Bronze').id, 'Silver');
  assert.equal(TierService.getNextTier('Gold').id, 'Platinum');
  assert.equal(TierService.getNextTier('Diamond'), null);
});

test('ui.truncate respects the max length with an ellipsis', () => {
  assert.equal(truncate('short', 40), 'short');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('', 5), '');
});

test('ui.price formats KS with thousands separators', () => {
  assert.equal(price(1000), '1,000 KS');
  assert.equal(price(0), '0 KS');
  assert.equal(price(1500000), '1,500,000 KS');
});
