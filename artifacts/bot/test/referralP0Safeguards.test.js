const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeSourceTxId } = require('../src/services/WebhookProcessor');

test('refund webhook normalizes approved top-up IDs to the referral source txId', () => {
  assert.equal(normalizeSourceTxId('TOPUP-123'), 'TOPUP-123');
  assert.equal(normalizeSourceTxId('TOPUP-123_approved'), 'TOPUP-123');
  assert.equal(normalizeSourceTxId(''), '');
});

test('refund webhook source normalization is safe for non-string references', () => {
  assert.equal(normalizeSourceTxId(12345), '12345');
  assert.equal(normalizeSourceTxId(null), '');
});
