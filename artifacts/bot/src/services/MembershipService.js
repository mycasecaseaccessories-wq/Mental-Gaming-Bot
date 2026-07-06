/**
 * MembershipService — Tiered Membership & Level-Up System
 *
 * Tiers:
 *   Silver   (default)  0 KS deposited       — 0% global discount
 *   Gold     ≥ 500,000 KS total deposited     — 2% global discount
 *   Platinum ≥ 2,000,000 KS total deposited   — 5% global discount
 *
 * On every topup approval:
 *   1. recalcTier() is called
 *   2. If tier changed → send Level-Up celebration + badge
 *   3. Log to audit trail
 */

const User = require('../models/User');
const { auditLog } = require('./logger');

// ── Tier configuration ─────────────────────────────────────────────────────────
const TIER_CONFIG = {
  Silver:   { min: 0,         discount: 0,    badge: '🥈', color: '⬜', next: 'Gold'     },
  Gold:     { min: 500_000,   discount: 2,    badge: '🥇', color: '🟨', next: 'Platinum' },
  Platinum: { min: 2_000_000, discount: 5,    badge: '💎', color: '🟦', next: null        },
};

const TIER_ORDER = ['Silver', 'Gold', 'Platinum'];

// ── Dynamic tier config (from GameConfig with 60s cache) ──────────────────────
let _tierCache = null;
let _tierCacheExpiry = 0;

async function getTierConfig() {
  if (Date.now() < _tierCacheExpiry && _tierCache) return _tierCache;
  try {
    const GameConfig = require('../models/GameConfig');
    const cfg = await GameConfig.get();
    _tierCache = {
      Silver:   { min: 0,                  discount: cfg.tierSilverDiscount,   badge: '🥈', color: '⬜', next: 'Gold',     bonusRate: cfg.coinBonusRateSilver   },
      Gold:     { min: cfg.tierGoldMin,     discount: cfg.tierGoldDiscount,     badge: '🥇', color: '🟨', next: 'Platinum', bonusRate: cfg.coinBonusRateGold     },
      Platinum: { min: cfg.tierPlatinumMin, discount: cfg.tierPlatinumDiscount, badge: '💎', color: '🟦', next: null,       bonusRate: cfg.coinBonusRatePlatinum },
    };
    _tierCacheExpiry = Date.now() + 60_000;
    return _tierCache;
  } catch {
    return TIER_CONFIG;
  }
}

// ── Apply tier-based discount to a price ─────────────────────────────────────
function applyTierDiscount(basePrice, tier) {
  const pct = TIER_CONFIG[tier]?.discount || 0;
  if (pct === 0) return { finalPrice: basePrice, discount: 0, pct };
  const discount = Math.floor(basePrice * (pct / 100));
  return { finalPrice: basePrice - discount, discount, pct };
}

// ── Progress bar builder ───────────────────────────────────────────────────────
function formatProgressBar(filled, total = 10, char = { on: '■', off: '□' }) {
  const filledCount = Math.round(filled * total);
  return char.on.repeat(filledCount) + char.off.repeat(total - filledCount);
}

// ── Get tier upgrade progress for a user ─────────────────────────────────────
async function getTierProgress(telegramId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) return null;

  const deposited = user.totalDeposited || 0;
  const tier      = user.membershipTier;
  const cfg       = TIER_CONFIG[tier];
  const nextTier  = cfg.next;

  if (!nextTier) {
    return {
      tier,
      deposited,
      nextTier: null,
      progressPct: 100,
      bar: formatProgressBar(1),
      ksToNext: 0,
      badge: cfg.badge,
      discount: cfg.discount,
      message: `🏆 You've reached the highest tier — *Platinum*!`,
    };
  }

  const nextMin   = TIER_CONFIG[nextTier].min;
  const prevMin   = cfg.min;
  const range     = nextMin - prevMin;
  const progress  = Math.max(0, deposited - prevMin);
  const pct       = Math.min(progress / range, 1);
  const ksToNext  = nextMin - deposited;

  return {
    tier,
    deposited,
    nextTier,
    progressPct: Math.round(pct * 100),
    bar: formatProgressBar(pct),
    ksToNext: Math.max(0, ksToNext),
    badge: cfg.badge,
    discount: cfg.discount,
    nextBadge: TIER_CONFIG[nextTier].badge,
    message: `Spend *${ksToNext.toLocaleString()} KS* more to reach ${TIER_CONFIG[nextTier].badge} *${nextTier}*!`,
  };
}

// ── Check if user should be upgraded and send celebration ─────────────────────
async function checkAndUpgradeTier(userId, telegram) {
  const user = await User.findById(userId);
  if (!user) return null;

  const oldTier = user.membershipTier;
  user.recalcTier();
  const newTier = user.membershipTier;

  if (oldTier === newTier) return null;

  await user.save();

  await auditLog(user.telegramId, 'TIER_UPGRADED', user._id.toString(), 'User', {
    from: oldTier,
    to: newTier,
    deposited: user.totalDeposited,
  });

  if (telegram) {
    await sendLevelUpCelebration(telegram, user, oldTier, newTier).catch(() => {});
  }

  return { oldTier, newTier };
}

// ── Send level-up celebration message ────────────────────────────────────────
async function sendLevelUpCelebration(telegram, user, oldTier, newTier) {
  const newCfg    = TIER_CONFIG[newTier];
  const oldCfg    = TIER_CONFIG[oldTier];
  const name      = user.username ? `@${user.username}` : 'there';

  const perks = {
    Gold:     [`🏷 *2% discount* on all products`, `🪙 *1.5%* Mental Coin bonus on top-ups`, `🥇 Gold badge on your profile`],
    Platinum: [`🏷 *5% discount* on all products`, `🪙 *2%* Mental Coin bonus on top-ups`, `💎 Platinum badge on your profile`, `🎰 Priority customer support`],
  };

  const perkLines = (perks[newTier] || []).join('\n');

  const msg =
    `🎉 *LEVEL UP! Congratulations, ${name}!*\n\n` +
    `${oldCfg.badge} ${oldTier}  →  ${newCfg.badge} *${newTier}*\n\n` +
    `╔══════════════════════╗\n` +
    `║  ${newCfg.badge}  *${newTier.toUpperCase()} MEMBER*  ${newCfg.badge}  ║\n` +
    `╚══════════════════════╝\n\n` +
    `*Your new perks:*\n${perkLines}\n\n` +
    `_Keep depositing to unlock even more rewards!_`;

  await telegram.sendMessage(user.telegramId, msg, { parse_mode: 'Markdown' });
}

// ── Recalc thresholds (re-exports updated thresholds for settings) ────────────
function calcTierFromDeposited(totalDeposited) {
  if (totalDeposited >= TIER_CONFIG.Platinum.min) return 'Platinum';
  if (totalDeposited >= TIER_CONFIG.Gold.min) return 'Gold';
  return 'Silver';
}

module.exports = {
  TIER_CONFIG,
  getTierConfig,
  applyTierDiscount,
  formatProgressBar,
  getTierProgress,
  checkAndUpgradeTier,
  sendLevelUpCelebration,
  calcTierFromDeposited,
};
