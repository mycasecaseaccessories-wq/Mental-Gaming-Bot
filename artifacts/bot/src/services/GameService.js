/**
 * GameService — Spin Wheel & Gacha
 *
 * Prize pool with weighted random selection.
 * Cooldown: 1 spin per 24 hours OR spend Mental Coins for extra spins.
 *
 * Prize tiers:
 *   "Thank You"    weight 55  (no reward)
 *   "50 MC"        weight 25
 *   "200 MC"       weight 10
 *   "500 MC"        weight 5
 *   "1000 KS"       weight 3
 *   "5000 KS"       weight 1
 *   "Free Spin"    weight 1
 */

const User = require('../models/User');
const GameConfig = require('../models/GameConfig');
const { creditCoin, debitCoin } = require('./WalletService');

const SPIN_COST_COINS = 50;
const DAILY_FREE_SPIN = true;

const PRIZE_POOL = [
  { id: 'thanks',      label: '🎉 Thank You!',     type: 'none',  value: 0,     weight: 55 },
  { id: 'coins_50',    label: '🪙 50 Mental Coins', type: 'coin',  value: 50,    weight: 25 },
  { id: 'coins_200',   label: '🪙 200 Coins',       type: 'coin',  value: 200,   weight: 10 },
  { id: 'coins_500',   label: '🪙 500 Coins',       type: 'coin',  value: 500,   weight: 5  },
  { id: 'ks_1000',     label: '🪙 1,000 Coins',     type: 'coin', value: 1000,  weight: 3  },
  { id: 'ks_5000',     label: '🪙 5,000 Coins',     type: 'coin', value: 5000,  weight: 1  },
  { id: 'free_spin',   label: '🎰 Free Spin!',      type: 'spin',  value: 1,     weight: 1  },
];

// Map GameConfig.spinWeight* → default prize id so admin weight edits take effect.
const WEIGHT_FIELDS = {
  thanks:    'spinWeightThanks',
  coins_50:  'spinWeightCoins50',
  coins_200: 'spinWeightCoins200',
  coins_500: 'spinWeightCoins500',
  ks_1000:   'spinWeightKS1000',
  ks_5000:   'spinWeightKS5000',
  free_spin: 'spinWeightFreeSpin',
};

// Build the effective prize pool from defaults + admin weights + custom prizes.
async function getEffectivePrizePool() {
  const cfg = await GameConfig.get();
  const pool = PRIZE_POOL.map((p) => ({
    ...p,
    weight: cfg[WEIGHT_FIELDS[p.id]] ?? p.weight,
  }));
  for (const c of (cfg.customSpinPrizes || [])) {
    pool.push({
      id:     `custom_${c._id}`,
      label:  c.label,
      type:   c.type,
      value:  c.value || 0,
      weight: c.weight || 0,
    });
  }
  return pool;
}

// ── Effective paid-spin cost (admin-editable via GameConfig) ─────────────────
async function getSpinCost() {
  const cfg = await GameConfig.get();
  return cfg.spinCostCoins ?? SPIN_COST_COINS;
}

// ── Weighted random pick (uses dynamic pool) ─────────────────────────────────
async function pickPrize() {
  const pool   = await getEffectivePrizePool();
  const total  = pool.reduce((s, p) => s + p.weight, 0) || 1;
  let rand = Math.random() * total;
  for (const prize of pool) {
    rand -= prize.weight;
    if (rand <= 0) return prize;
  }
  return pool[0];
}

// ── Check if user can spin for free ──────────────────────────────────────────
function canFreeSpinToday(user) {
  if (!user.lastSpinAt) return true;
  const last = new Date(user.lastSpinAt);
  const now = new Date();
  const mstLast = new Date(last.getTime() + 6.5 * 60 * 60 * 1000);
  const mstNow  = new Date(now.getTime() + 6.5 * 60 * 60 * 1000);
  return mstLast.toDateString() !== mstNow.toDateString();
}

function nextFreeSpinIn(user) {
  if (!user.lastSpinAt) return 0;
  const nextMidnight = new Date(user.lastSpinAt);
  nextMidnight.setUTCHours(17, 30, 0, 0); // midnight MST = 17:30 UTC
  if (nextMidnight <= new Date()) nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  return Math.max(0, nextMidnight - new Date());
}

// ── Spin! ─────────────────────────────────────────────────────────────────────
async function spin(telegramId, { usePaidSpin = false } = {}) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const freeSpin = canFreeSpinToday(user);

  if (!freeSpin && !usePaidSpin) {
    const ms = nextFreeSpinIn(user);
    throw new Error(`daily_limit:${ms}`);
  }

  if (!freeSpin && usePaidSpin) {
    const spinCost = await getSpinCost();
    if (user.balanceCoin < spinCost) {
      throw new Error(`not_enough_coins:${user.balanceCoin}`);
    }
    await debitCoin(user._id, spinCost, { type: 'Debit', note: 'Paid spin' });
  }

  user.lastSpinAt = new Date();
  await user.save();

  const prize = await pickPrize();

  if ((prize.type === 'coin' || prize.type === 'ks') && prize.value > 0) {
    // Policy: all spin rewards are paid in Mental Coins (legacy 'ks' prizes included).
    await creditCoin(user._id, prize.value, { type: 'Bonus', note: `Spin wheel prize: ${prize.label}` });
  } else if (prize.type === 'spin') {
    // Grant a free spin ticket by resetting lastSpinAt
    user.lastSpinAt = null;
    await user.save();
  }

  const updatedUser = await User.findByTelegramId(telegramId);
  return { prize, user: updatedUser, usedFreeSpin: freeSpin };
}

// ── Animation frames ──────────────────────────────────────────────────────────
const WHEEL_FRAMES = [
  '🎰 | 🍒 💎 🎯 | Spinning...',
  '🎰 | 💎 🎯 🌟 | Spinning...',
  '🎰 | 🎯 🌟 🍀 | Spinning...',
  '🎰 | 🌟 🍀 💰 | Spinning...',
  '🎰 | 🍀 💰 🎰 | Spinning...',
  '🎰 | 💰 🎰 🎲 | Spinning...',
  '🎰 | 🎲 🎯 🌟 | Slowing...',
  '🎰 | 🎯 🌟 💎 | Slowing...',
  '🎰 | 🌟 💎 🍀 | Almost...',
];

module.exports = {
  spin,
  pickPrize,
  canFreeSpinToday,
  nextFreeSpinIn,
  PRIZE_POOL,
  getEffectivePrizePool,
  SPIN_COST_COINS,
  getSpinCost,
  WHEEL_FRAMES,
};
