const test = require('node:test');
const assert = require('node:assert/strict');

function mockModule(relPath, exports) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

const calls = [];
const session = {
  startTransaction: () => calls.push('start'),
  commitTransaction: async () => calls.push('commit'),
  abortTransaction: async () => calls.push('abort'),
  endSession: async () => calls.push('end'),
};
const user = {
  _id: 'USER-1',
  balanceKS: 1000,
  balanceCoin: 10,
  membershipTier: 'Silver',
  totalDeposited: 0,
  recalcTier() {
    calls.push('recalc-tier');
  },
  save: async (options) => calls.push(options?.session ? 'user-save-session' : 'user-save'),
};
const pending = {
  _id: 'TX-DOC',
  txId: 'TOPUP-1',
  type: 'Topup',
  status: 'Pending',
  amount: 5000,
  userId: user,
  paymentMethod: 'KPay',
  screenshotUrl: 'file-1',
  save: async (options) => calls.push(options?.session ? 'pending-save-session' : 'pending-save'),
};

mockModule('mongoose', { startSession: async () => session });
mockModule('../src/models/User', {
  findById: () => ({ session: async () => user }),
});
mockModule('../src/models/Transaction', {
  findOne: () => ({
    populate() {
      return this;
    },
    session: async () => pending,
  }),
  exists: () => ({ session: async () => null }),
  create: async (docs, options) => {
    calls.push(options?.session ? 'transaction-create-session' : 'transaction-create');
    return Array.isArray(docs) ? [{ ...docs[0] }] : docs;
  },
  isDuplicate: async () => false,
});
mockModule('../src/models/GameConfig', {
  get: async () => ({
    coinBonusRateSilver: 0.01,
    coinBonusRateGold: 0.015,
    coinBonusRatePlatinum: 0.02,
  }),
});
mockModule('../src/services/PromoPerksService', {
  happyHourBonusMC: async () => ({ bonus: 0, pct: 0 }),
});
mockModule('../src/models/SystemStatus', { get: async () => ({ topupCouponEnabled: false }) });

const { approveTopup } = require('../src/services/WalletService');

test('approveTopup commits pending state, wallet credit and bonus ledger atomically', async () => {
  const result = await approveTopup('TOPUP-1', 9001);

  assert.equal(result.amountKS, 5000);
  assert.equal(result.bonusCoins, 50);
  assert.deepEqual(
    calls.filter((call) => ['start', 'commit', 'abort', 'end'].includes(call)),
    ['start', 'commit', 'end'],
  );
  assert.ok(calls.includes('pending-save-session'));
  assert.ok(calls.filter((call) => call === 'transaction-create-session').length >= 2);
  assert.ok(!calls.includes('abort'));
});
