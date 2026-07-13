/**
 * Referral campaign REWARD reservation/rollback loop — logic tests (no DB, no network).
 * Run with `pnpm --filter @workspace/bot test`.
 *
 * Purpose
 * -------
 * `RefCampaignService.onReferralCompleted` is the money-sensitive core of the
 * campaign feature: it reserves a reward slot from the user's progress, reserves
 * a campaign-wide quota slot, delivers, and rolls BOTH reservations back if
 * delivery fails or the quota is full. A regression here could double-pay a
 * winner, overshoot `totalRewardLimit`, or leave counters inconsistent.
 *
 * There is no live-DB harness in this package, so (like refCampaignTopup.test.js)
 * we mock only the leaf dependencies. Crucially, the RefCampaign / RefCampaignEntry
 * mocks are STATEFUL: findOneAndUpdate / updateOne faithfully apply the conditional
 * filter + $inc/$set against in-memory docs — mimicking MongoDB's atomic update
 * semantics — so the REAL reservation/rollback ordering is exercised, not a
 * re-implementation.
 *
 * Covered scenarios (see task):
 *   1. Reaching `requiredRefs` grants exactly one reward + audits REF_CAMPAIGN_REWARD.
 *   2. A wallet-credit failure rolls back BOTH the per-user and campaign-wide
 *      reservations (counters returned to pre-reward state, nothing audited).
 *   3. Hitting `totalRewardLimit` auto-ends the campaign (isActive → false) and
 *      blocks any further reward beyond the limit.
 *   4. `maxRewardsPerUser` caps a single user's claims even with surplus progress.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mutable shared context the mocks read from (reset before each scenario) ──────
let ctx;

// Faithful single-doc atomic update: returns null (no match) if any filter
// condition fails, otherwise applies $inc/$set in place and returns a fresh copy.
function applyUpdate(doc, filter, update) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '_id') continue; // routing key, not a value predicate here
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$lt' in v && !(doc[k] < v.$lt)) return null;
      if ('$gte' in v && !(doc[k] >= v.$gte)) return null;
      if ('$lte' in v && !(doc[k] <= v.$lte)) return null;
      if ('$gt' in v && !(doc[k] > v.$gt)) return null;
    } else if (doc[k] !== v) {
      return null;
    }
  }
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) doc[k] = v;
  return { ...doc };
}

function freshCtx(overrides = {}) {
  const referrer = { _id: 'REFERRER', telegramId: 111, username: 'alice' };
  const referee = { _id: 'REFEREE', telegramId: 222, username: 'bob' };
  const campId = { toString: () => 'CAMP1' };
  const camp = {
    _id: campId,
    title: 'Test Campaign',
    requiredRefs: 1,
    rewardType: 'mc',
    rewardAmount: 100,
    rewardLabel: 'Prize',
    maxInvitesPerUser: 0,
    maxRewardsPerUser: 0,
    totalRewardLimit: 0,
    totalRewardsClaimed: 0,
    minRefereeAgeDays: 0,
    minRefereeTopup: 0,
    isActive: true,
    ...overrides.camp,
  };
  const entry = {
    _id: 'ENTRY1',
    campaignId: campId,
    telegramId: referrer.telegramId,
    userId: referrer._id,
    countedRefs: 0,
    totalRefs: 0,
    rewardsClaimed: 0,
    ...overrides.entry,
  };
  return {
    referrer,
    referee,
    camp,
    entry,
    walletCredits: [], // { fn, id, amount }
    walletShouldThrow: overrides.walletShouldThrow || false,
    auditEvents: [], // action strings
    couponsIssued: 0,
  };
}

// ── Inject leaf-module mocks into require.cache BEFORE loading the service ───────
function mockModule(relPath, exports) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

mockModule('../src/models/RefCampaign', {
  // getActive is realistic: only an active campaign is returned.
  getActive: async () => (ctx.camp.isActive ? ctx.camp : null),
  findOneAndUpdate: async (filter, update) => applyUpdate(ctx.camp, filter, update),
  updateOne: async (filter, update) => { applyUpdate(ctx.camp, filter, update); return {}; },
  findById: async () => ({ ...ctx.camp }),
});

mockModule('../src/models/RefCampaignEntry', {
  updateOne: async (filter, update) => { applyUpdate(ctx.entry, filter, update); return {}; },
  findOneAndUpdate: async (filter, update) => applyUpdate(ctx.entry, filter, update),
  findById: async () => ({ ...ctx.entry }),
});

mockModule('../src/services/WalletService', {
  creditCoin: async (id, amount) => {
    if (ctx.walletShouldThrow) throw new Error('wallet down');
    ctx.walletCredits.push({ fn: 'creditCoin', id, amount });
  },
  creditKS: async (id, amount) => {
    if (ctx.walletShouldThrow) throw new Error('wallet down');
    ctx.walletCredits.push({ fn: 'creditKS', id, amount });
  },
});

mockModule('../src/services/PromoService', {
  generateCoupon: async () => { ctx.couponsIssued += 1; return { code: 'REF-TEST' }; },
});

mockModule('../src/services/logger', {
  auditLog: async (_uid, action) => { ctx.auditEvents.push(action); },
});

mockModule('../src/utils/accountAge', {
  estimateAccountAgeDays: () => 9999,
});

mockModule('../config/settings', { config: { bot: { adminId: 1 } } });

// Real service under test (load AFTER mocks are in place)
const RefCampaignService = require('../src/services/RefCampaignService');

// Silent telegram stub
const telegram = { sendMessage: async () => {} };

async function complete() {
  return RefCampaignService.onReferralCompleted(ctx.referrer, telegram, ctx.referee, 999999);
}

// ── Scenario 1: hitting requiredRefs grants exactly one reward ───────────────────
test('reaching requiredRefs grants exactly one reward and audits REF_CAMPAIGN_REWARD', async () => {
  ctx = freshCtx({ camp: { requiredRefs: 1, maxRewardsPerUser: 1 }, entry: { countedRefs: 0 } });

  const result = await complete();

  assert.deepEqual(result, { granted: ['100 MC'] }, 'exactly one reward returned');
  assert.equal(ctx.walletCredits.length, 1, 'wallet credited exactly once');
  assert.equal(ctx.walletCredits[0].fn, 'creditCoin');
  assert.equal(ctx.walletCredits[0].amount, 100);
  assert.equal(ctx.walletCredits[0].id, 'REFERRER');

  const rewardAudits = ctx.auditEvents.filter((a) => a === 'REF_CAMPAIGN_REWARD');
  assert.equal(rewardAudits.length, 1, 'REF_CAMPAIGN_REWARD audited exactly once');

  // Counters consistent: +1 counted, -requiredRefs spent, 1 reward claimed.
  assert.equal(ctx.entry.rewardsClaimed, 1);
  assert.equal(ctx.entry.countedRefs, 0);
  assert.equal(ctx.camp.totalRewardsClaimed, 1);
});

// ── Scenario 2: wallet-credit failure rolls BOTH reservations back ───────────────
test('wallet-credit failure rolls back per-user AND campaign-wide reservations', async () => {
  ctx = freshCtx({
    camp: { requiredRefs: 1, maxRewardsPerUser: 1, totalRewardLimit: 5, totalRewardsClaimed: 0 },
    entry: { countedRefs: 0 },
    walletShouldThrow: true,
  });

  const result = await complete();

  // No reward paid or audited.
  assert.deepEqual(result, { granted: [] }, 'no reward granted on wallet failure');
  assert.equal(ctx.walletCredits.length, 0, 'no successful wallet credit recorded');
  assert.ok(!ctx.auditEvents.includes('REF_CAMPAIGN_REWARD'), 'no reward audit on failure');

  // Both reservations rolled back to pre-reward state:
  //   entry: countedRefs restored to the counted value (1), rewardsClaimed back to 0
  //   campaign: totalRewardsClaimed back to 0
  assert.equal(ctx.entry.rewardsClaimed, 0, 'per-user rewardsClaimed rolled back');
  assert.equal(ctx.entry.countedRefs, 1, 'per-user countedRefs rolled back');
  assert.equal(ctx.camp.totalRewardsClaimed, 0, 'campaign-wide quota rolled back');
  assert.equal(ctx.camp.isActive, true, 'campaign stays active after a rollback');
});

// ── Scenario 3: totalRewardLimit auto-ends the campaign and blocks overshoot ─────
test('hitting totalRewardLimit auto-ends the campaign and blocks further rewards', async () => {
  // Surplus progress (countedRefs would fund 2 rewards) but the campaign-wide
  // limit is 1 → exactly one reward, then the campaign closes.
  ctx = freshCtx({
    camp: { requiredRefs: 1, maxRewardsPerUser: 0, totalRewardLimit: 1, totalRewardsClaimed: 0 },
    entry: { countedRefs: 1 }, // becomes 2 after this referral is counted
  });

  const result = await complete();

  assert.equal(result.granted.length, 1, 'only one reward despite surplus progress');
  assert.equal(ctx.walletCredits.length, 1, 'quota limit prevents a second payout');
  assert.equal(ctx.camp.totalRewardsClaimed, 1, 'quota never overshoots totalRewardLimit');
  assert.equal(ctx.camp.isActive, false, 'campaign auto-ended when quota filled');
  assert.equal(ctx.camp.endReason, 'quota_full', 'end reason recorded');

  // A later completion is now blocked outright (getActive returns null).
  ctx.walletCredits = [];
  ctx.auditEvents = [];
  const after = await complete();
  assert.equal(after, null, 'no active campaign → nothing granted');
  assert.equal(ctx.walletCredits.length, 0, 'no further payouts after quota full');
  assert.equal(ctx.camp.totalRewardsClaimed, 1, 'quota unchanged after blocked attempt');
});

// ── Scenario 4: maxRewardsPerUser caps a single user's claims ────────────────────
test('maxRewardsPerUser caps a single user even with surplus progress', async () => {
  // Enough progress for 2 rewards, but the per-user cap is 1.
  ctx = freshCtx({
    camp: { requiredRefs: 1, maxRewardsPerUser: 1, totalRewardLimit: 0 },
    entry: { countedRefs: 1 }, // becomes 2 after this referral is counted
  });

  const result = await complete();

  assert.equal(result.granted.length, 1, 'per-user cap limits payout to one');
  assert.equal(ctx.walletCredits.length, 1, 'wallet credited exactly once');
  assert.equal(ctx.entry.rewardsClaimed, 1, 'rewardsClaimed capped at maxRewardsPerUser');
  assert.equal(ctx.entry.countedRefs, 1, 'surplus progress left unspent');
  assert.equal(
    ctx.auditEvents.filter((a) => a === 'REF_CAMPAIGN_REWARD').length,
    1,
    'exactly one reward audited',
  );
});
