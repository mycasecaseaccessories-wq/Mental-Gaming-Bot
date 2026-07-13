/**
 * Referral campaign minimum-top-up gate — integration logic tests (no DB, no network).
 * Run with `pnpm --filter @workspace/bot test`.
 *
 * Purpose
 * -------
 * A per-campaign `minRefereeTopup` (KS) requires an invited friend to deposit at
 * least a set amount before their referral counts toward the ACTIVE referral
 * campaign. The NORMAL referral commission must still be paid regardless.
 *
 * There is no live-DB harness in this package, so we mock only the leaf
 * dependencies (Mongoose models, WalletService, logger, FraudDetector,
 * PromoService, accountAge, config) and run the REAL ReferralService.
 * processTopupCommission → REAL RefCampaignService.onReferralCompleted flow.
 * This exercises the actual gate + commission ordering, not a re-implementation.
 *
 * Covered scenarios (see task):
 *   1. minRefereeTopup = 10000, first top-up 5000  → commission still paid,
 *      referral NOT counted toward campaign, REF_CAMPAIGN_TOPUP_REJECT logged.
 *   2. first top-up 10000+                          → commission paid AND
 *      referral counted (campaign progress advances).
 *   3. minRefereeTopup = 0                          → no gating (counts as before).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mutable shared context the mocks read from (reset before each scenario) ──────
let ctx;

function freshCtx({ minRefereeTopup, topupAmount }) {
  const referrer = { _id: 'REFERRER', telegramId: 111, username: 'alice' };
  const referee = { _id: 'REFEREE', telegramId: 222, username: 'bob' };
  return {
    topupAmount,
    referrer,
    referee,
    // Referral doc returned by Referral.findOne — mutable, has a no-op save()
    referral: {
      _id: 'REF1',
      referrerId: referrer._id,
      commissionMode: 'first',
      commissionRate: 2,
      bonusPaid: false,
      totalCommissionKS: 0,
      totalCommissionCoins: 0,
      completedAt: null,
      topupAmount: 0,
      commissionHistory: [],
      status: 'Pending',
      isFraudSuspected: false,
      save: async () => {},
    },
    // Active campaign returned by RefCampaign.getActive
    camp: {
      _id: { toString: () => 'CAMP1' },
      title: 'Test Campaign',
      requiredRefs: 5,
      rewardType: 'mc',
      rewardAmount: 100,
      maxInvitesPerUser: 0,
      maxRewardsPerUser: 1,
      totalRewardLimit: 0,
      totalRewardsClaimed: 0,
      minRefereeAgeDays: 0,
      minRefereeTopup,
      isActive: true,
    },
    // recorders
    walletCredits: [], // { fn, id, amount }
    auditEvents: [], // action strings
    entryCountCalls: 0, // times a referral was atomically counted toward campaign
  };
}

// ── Inject leaf-module mocks into require.cache BEFORE loading the services ──────
function mockModule(relPath, exports) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

mockModule('../src/models/Referral', {
  findOne: async () => ctx.referral,
  countDocuments: async () => 0, // completedBefore = 0 → Bronze tier
});

mockModule('../src/models/User', {
  findById: async (id) => {
    if (id === ctx.referee._id) return ctx.referee;
    if (id === ctx.referrer._id) return ctx.referrer;
    return null;
  },
  findByTelegramId: async () => null,
  findOne: async () => null,
});

mockModule('../src/models/SystemStatus', {
  get: async () => ({
    referralEnabled: true,
    referralMinTopup: 1000,
    referralCommissionMode: 'first',
    referralCommissionRate: 2,
    referralTiers: [],
    referralWelcomeBonusCoins: 50,
    referralWelcomeBonusKS: 200,
  }),
});

mockModule('../src/models/RefCampaign', {
  getActive: async () => ctx.camp,
  findOneAndUpdate: async () => ctx.camp, // quota reserve (unused — reward loop never fires)
  updateOne: async () => {},
  findById: async () => null,
});

mockModule('../src/models/RefCampaignEntry', {
  updateOne: async () => {}, // idempotent entry upsert
  findOneAndUpdate: async (filter, update) => {
    // The "count this referral" call is identifiable by $inc.totalRefs === 1.
    if (update && update.$inc && update.$inc.totalRefs === 1) {
      ctx.entryCountCalls += 1;
      // countedRefs (1) < requiredRefs (5) → no reward earned this round
      return { _id: 'ENTRY1', countedRefs: 1, rewardsClaimed: 0 };
    }
    // reward-reserve call → nothing earned, break the loop
    return null;
  },
  findById: async () => ({ _id: 'ENTRY1', countedRefs: 1, rewardsClaimed: 0 }),
});

mockModule('../src/services/WalletService', {
  creditCoin: async (id, amount) => { ctx.walletCredits.push({ fn: 'creditCoin', id, amount }); },
  creditKS: async (id, amount) => { ctx.walletCredits.push({ fn: 'creditKS', id, amount }); },
});

mockModule('../src/services/logger', {
  auditLog: async (_uid, action) => { ctx.auditEvents.push(action); },
});

mockModule('../src/services/FraudDetector', {
  checkReferralFraud: async () => ({ shouldBlock: false, flags: [] }),
  checkTopupFraud: async () => {},
});

mockModule('../src/services/PromoService', {
  generateCoupon: async () => ({ code: 'REF-TEST' }),
});

mockModule('../src/utils/accountAge', {
  estimateAccountAgeDays: () => 9999,
});

mockModule('../config/settings', { config: { bot: { adminId: 1 } } });

// Real services under test (load AFTER mocks are in place)
const ReferralService = require('../src/services/ReferralService');

// Silent telegram stub
const telegram = { sendMessage: async () => {} };

async function run({ minRefereeTopup, topupAmount }) {
  ctx = freshCtx({ minRefereeTopup, topupAmount });
  const result = await ReferralService.processTopupCommission(ctx.referee._id, topupAmount, telegram);
  return result;
}

// ── Scenario 1: tiny top-up is blocked from the campaign, commission still paid ──
test('minRefereeTopup=10000, first top-up 5000 → commission paid, ref NOT counted, reject logged', async () => {
  await run({ minRefereeTopup: 10000, topupAmount: 5000 });

  // Normal referral commission STILL paid to the referrer (5000 * 2% = 100 MC)
  const commission = ctx.walletCredits.find(
    (c) => c.fn === 'creditCoin' && c.id === 'REFERRER'
  );
  assert.ok(commission, 'referrer should still receive normal referral commission');
  assert.equal(commission.amount, 100);

  // Referral was NOT counted toward the campaign
  assert.equal(ctx.entryCountCalls, 0, 'tiny top-up must not advance campaign progress');

  // The rejection was audited
  assert.ok(
    ctx.auditEvents.includes('REF_CAMPAIGN_TOPUP_REJECT'),
    'REF_CAMPAIGN_TOPUP_REJECT should be logged'
  );
  // ...and the campaign reward was NOT granted/audited
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_REWARD'));
});

// ── Scenario 2: top-up meets the minimum → referral counts toward the campaign ───
test('first top-up 10000 (== minRefereeTopup) → commission paid AND ref counted', async () => {
  await run({ minRefereeTopup: 10000, topupAmount: 10000 });

  const commission = ctx.walletCredits.find(
    (c) => c.fn === 'creditCoin' && c.id === 'REFERRER'
  );
  assert.ok(commission, 'referrer should receive normal referral commission');
  assert.equal(commission.amount, 200); // 10000 * 2%

  assert.equal(ctx.entryCountCalls, 1, 'qualifying top-up must advance campaign progress');
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_TOPUP_REJECT'), 'no rejection expected');
});

// ── Scenario 3: gating disabled (minRefereeTopup=0) behaves exactly as before ────
test('minRefereeTopup=0 → no gating, small top-up still counts', async () => {
  await run({ minRefereeTopup: 0, topupAmount: 5000 });

  assert.equal(ctx.entryCountCalls, 1, 'with gating off, any qualifying top-up counts');
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_TOPUP_REJECT'), 'no rejection when gating off');
});
