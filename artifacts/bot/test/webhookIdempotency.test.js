const test = require('node:test');
const assert = require('node:assert/strict');

function mockModule(relPath, exports) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

const event = {
  _id: 'EVENT-1',
  source: 'kpay',
  eventType: 'payment.failed',
  status: 'pending',
  retryCount: 0,
  payload: { externalRef: 'EXT-1' },
};
let transactionUpdates = 0;

const webhookModel = {
  find: () => ({
    sort() {
      return this;
    },
    limit: async () => (event.status === 'pending' ? [event] : []),
  }),
  findOneAndUpdate: async (filter, update) => {
    if (filter.status === 'pending') {
      if (event.status !== 'pending') return null;
      event.status = update.status;
      return event;
    }
    if (filter.status === 'processing') {
      event.status = update.status;
      Object.assign(event, update);
      return event;
    }
    return event;
  },
  findByIdAndUpdate: async (_id, update) => {
    Object.assign(event, update);
    return event;
  },
};

mockModule('../src/models/WebhookEvent', webhookModel);
mockModule('../src/models/Order', {});
mockModule('../src/models/User', {});
mockModule('../src/models/Transaction', {
  findOneAndUpdate: async () => {
    transactionUpdates += 1;
    return { telegramId: 1001, amountKS: 5000 };
  },
});

const { processPendingEvents } = require('../src/services/WebhookProcessor');

test('concurrent webhook polling claims a pending event only once', async () => {
  await Promise.all([processPendingEvents(null), processPendingEvents(null)]);

  assert.equal(transactionUpdates, 1);
  assert.equal(event.status, 'processed');
});
