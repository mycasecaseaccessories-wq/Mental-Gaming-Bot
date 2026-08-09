const test = require('node:test');
const assert = require('node:assert/strict');

const LiveFeedService = require('../src/services/LiveFeedService');

test('maskUsername keeps a recognizable prefix without exposing the full username', () => {
  assert.equal(LiveFeedService.maskUsername({ username: 'mgmg12345' }), '@mgmg****');
  assert.equal(LiveFeedService.maskUsername({ username: '@alice' }), '@alic****');
});

test('maskUserId keeps only the leading digits', () => {
  assert.equal(LiveFeedService.maskUserId(123456789), '123456****');
  assert.equal(LiveFeedService.maskUserId(42), '42****');
});

test('maskedUser falls back to the masked Telegram ID', () => {
  assert.equal(LiveFeedService.maskedUser({ id: 123456789 }), '123456****');
  assert.equal(LiveFeedService.maskedUser({}), '@user****');
});