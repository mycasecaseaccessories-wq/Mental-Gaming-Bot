/**
 * Referral campaign minimum-account-age gate — integration logic tests (no DB, no network).
 * Run with `pnpm --filter @workspace/bot test`.
 *
 * Purpose
 * -------
 * A per-campaign `minRefereeAgeDays` anti-fraud gate requires an invited friend's
 * ESTIMATED Telegram account age (derived from their numeric ID) to meet a
 * threshold before their referral counts toward the ACTIVE referral campaign.
 * Fresh throwaway accounts must be blocked from gaming campaigns, while the
 * NORMAL referral commission is still paid regardless.
 *
 * There is no live-DB harness in this package, so we mock only the leaf
 * dependencies (Mongoose models, WalletService, logger, FraudDetector,
 * PromoService, accountAge, config) and run the REAL ReferralService.
 * processTopupCommission → REAL RefCampaignService.onReferralCompleted flow.
 * This exercises the actual gate + commission ordering, not a re-implementation.
 *
 * Covered scenarios (see task):
 *   1. minRefereeAgeDays = 30, referee est. age 10   → commission still paid,
 *      referral NOT counted toward campaign, REF_CAMPAIGN_AGE_REJECT logged.
 *   2. referee est. age 30 (== threshold)            → commission paid AND
 *      referral counted (campaign progress advances).
 *   3. minRefereeAgeDays = 0                          → no gating (counts as before),
 *      even when the referee looks brand new.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mutable shared context the mocks read from (reset before each scenario) ──────
let ctx;

function freshCtx({ minRefereeAgeDays, estAgeDays }) {
  const referrer = { _id: 'REFERRER', telegramId: 111, username: 'alice' };
  const referee = { _id: 'REFEREE', telegramId: 222, username: 'bob' };
  return {
    estAgeDays, // what the mocked estimateAccountAgeDays returns for the referee
    topupAmount: 5000, // well above SystemStatus.referralMinTopup — never the blocker here
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
      minRefereeAgeDays,
      minRefereeTopup: 0, // top-up gate OFF — isolate the age gate
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

// Age estimate is driven per-scenario from ctx so we can simulate young vs old accounts.
mockModule('../src/utils/accountAge', {
  estimateAccountAgeDays: () => ctx.estAgeDays,
});

mockModule('../config/settings', { config: { bot: { adminId: 1 } } });

// Real services under test (load AFTER mocks are in place)
const ReferralService = require('../src/services/ReferralService');

// Silent telegram stub
const telegram = { sendMessage: async () => {} };

async function run({ minRefereeAgeDays, estAgeDays }) {
  ctx = freshCtx({ minRefereeAgeDays, estAgeDays });
  const result = await ReferralService.processTopupCommission(ctx.referee._id, ctx.topupAmount, telegram);
  return result;
}

// ── Scenario 1: young account is blocked from the campaign, commission still paid ─
test('minRefereeAgeDays=30, referee est. age 10 → commission paid, ref NOT counted, age reject logged', async () => {
  await run({ minRefereeAgeDays: 30, estAgeDays: 10 });

  // Normal referral commission STILL paid to the referrer (5000 * 2% = 100 MC)
  const commission = ctx.walletCredits.find(
    (c) => c.fn === 'creditCoin' && c.id === 'REFERRER'
  );
  assert.ok(commission, 'referrer should still receive normal referral commission');
  assert.equal(commission.amount, 100);

  // Referral was NOT counted toward the campaign
  assert.equal(ctx.entryCountCalls, 0, 'young account must not advance campaign progress');

  // The rejection was audited
  assert.ok(
    ctx.auditEvents.includes('REF_CAMPAIGN_AGE_REJECT'),
    'REF_CAMPAIGN_AGE_REJECT should be logged'
  );
  // ...and the campaign reward was NOT granted/audited
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_REWARD'));
});

// ── Scenario 2: account age meets the minimum → referral counts toward campaign ──
test('referee est. age 30 (== minRefereeAgeDays) → commission paid AND ref counted', async () => {
  await run({ minRefereeAgeDays: 30, estAgeDays: 30 });

  const commission = ctx.walletCredits.find(
    (c) => c.fn === 'creditCoin' && c.id === 'REFERRER'
  );
  assert.ok(commission, 'referrer should receive normal referral commission');
  assert.equal(commission.amount, 100); // 5000 * 2%

  assert.equal(ctx.entryCountCalls, 1, 'old-enough account must advance campaign progress');
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_AGE_REJECT'), 'no rejection expected');
});

// ── Scenario 3: gating disabled (minRefereeAgeDays=0) behaves exactly as before ──
test('minRefereeAgeDays=0 → no gating, even a brand-new account still counts', async () => {
  await run({ minRefereeAgeDays: 0, estAgeDays: 0 });

  assert.equal(ctx.entryCountCalls, 1, 'with gating off, any referral counts');
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_AGE_REJECT'), 'no rejection when gating off');
});
