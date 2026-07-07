/**
 * PromoPerksService
 *
 * Promotion perks engine:
 *   - Happy Hour  → extra MC bonus % on top-ups during a configured MMT window
 *   - Cashback    → MC back on completed orders
 *   - Birthday    → daily cron gifts MC on user's birthday (once per year)
 *   - Win-back    → daily cron messages inactive users with a comeback MC bonus
 *   - Leaderboard → monthly top spenders + auto MC prizes on the 1st
 *
 * All settings live on the SystemStatus singleton (see models/SystemStatus.js).
 */

const User = require('../models/User');
const Order = require('../models/Order');
const SystemStatus = require('../models/SystemStatus');
const { creditCoin } = require('./WalletService');
const { auditLog } = require('./logger');
const { config } = require('../../config/settings');

const MMT_OFFSET_MS = 6.5 * 60 * 60 * 1000; // UTC+6:30

// ── MMT time helpers ─────────────────────────────────────────────────────────
function mmtNow() {
  return new Date(Date.now() + MMT_OFFSET_MS); // read with getUTC* methods
}
function mmtHour() {
  return mmtNow().getUTCHours();
}
function mmtToday() {
  const d = mmtNow();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ── Happy Hour ───────────────────────────────────────────────────────────────
function isHappyHourNow(status) {
  if (!status?.happyHourEnabled) return false;
  const pct = status.happyHourBonusPct || 0;
  if (pct <= 0) return false;
  const h = mmtHour();
  const start = status.happyHourStartMMT ?? 18;
  const end = status.happyHourEndMMT ?? 20;
  if (start === end) return false;
  // supports overnight windows (e.g. 22 → 2)
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

/** Returns extra MC for a topup amount if happy hour is active, else 0. */
async function happyHourBonusMC(amountKS) {
  const status = await SystemStatus.get();
  if (!isHappyHourNow(status)) return { bonus: 0, pct: 0 };
  const pct = status.happyHourBonusPct;
  return { bonus: Math.floor((amountKS * pct) / 100), pct };
}

// ── Cashback ─────────────────────────────────────────────────────────────────
/** Credit MC cashback for a completed order. Returns credited amount (0 = off). */
async function giveCashback(order, telegram) {
  const status = await SystemStatus.get();
  const pct = status.cashbackPct || 0;
  if (pct <= 0 || !order?.amount || order.amount <= 0) return 0;
  const mc = Math.floor((order.amount * pct) / 100);
  if (mc <= 0) return 0;

  const userId = order.userId?._id || order.userId;
  await creditCoin(userId, mc, {
    type: 'Bonus',
    note: `Cashback ${pct}% — order #${order._id.toString().slice(-8).toUpperCase()}`,
  });

  const telegramId = order.userId?.telegramId;
  if (telegram && telegramId) {
    try {
      await telegram.sendMessage(
        telegramId,
        `💸 *Cashback ရပါပြီ!*\n\nOrder ပြီးမြောက်လို့ *${mc.toLocaleString()} MC* (${pct}%) ပြန်အမ်းပေးလိုက်ပါပြီ 🎉`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }
  return mc;
}

// ── First-order discount ─────────────────────────────────────────────────────
/** Returns discount % if this user has never placed an order, else 0. */
async function firstOrderDiscountPct(userMongoId) {
  const status = await SystemStatus.get();
  const pct = status.firstOrderDiscountPct || 0;
  if (pct <= 0) return 0;
  const has = await Order.exists({
    userId: userMongoId,
    status: { $in: ['Pending', 'Processing', 'Success'] },
  });
  return has ? 0 : pct;
}

// ── Birthday gifts (daily cron) ──────────────────────────────────────────────
async function runBirthdayGifts(telegram) {
  const status = await SystemStatus.get();
  const gift = status.birthdayGiftMC || 0;
  if (gift <= 0) return { sent: 0 };

  const { year, month, day } = mmtToday();
  const users = await User.find({
    birthdayMonth: month,
    birthdayDay: day,
    isBlocked: { $ne: true },
    $or: [{ lastBirthdayGiftYear: null }, { lastBirthdayGiftYear: { $lt: year } }],
  }).limit(500);

  let sent = 0;
  for (const user of users) {
    // claim first (atomic) to prevent double-credit
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, $or: [{ lastBirthdayGiftYear: null }, { lastBirthdayGiftYear: { $lt: year } }] },
      { $set: { lastBirthdayGiftYear: year } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      await creditCoin(user._id, gift, { type: 'Bonus', note: `Birthday gift ${year}` });
    } catch (e) {
      // credit failed → roll back the claim so tomorrow's/next run can retry
      console.error('[PromoPerks] birthday credit error:', user.telegramId, e.message);
      await User.updateOne(
        { _id: user._id },
        { $set: { lastBirthdayGiftYear: user.lastBirthdayGiftYear || null } }
      ).catch(() => {});
      continue;
    }
    try {
      await telegram.sendMessage(
        user.telegramId,
        `🎂 *Happy Birthday ${user.first_name || ''}!* 🎉\n\nမွေးနေ့လက်ဆောင်အဖြစ် *${gift.toLocaleString()} MC* ထည့်ပေးလိုက်ပါပြီ 🎁\nပျော်ရွှင်တဲ့ မွေးနေ့ဖြစ်ပါစေ! 💙`,
        { parse_mode: 'Markdown' }
      );
      sent++;
    } catch (e) {
      // MC already credited; message failure (e.g. bot blocked) is non-fatal
      console.error('[PromoPerks] birthday send error:', user.telegramId, e.message);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (sent > 0) console.log(`[PromoPerks] 🎂 Birthday gifts sent: ${sent}`);
  return { sent };
}

// ── Win-back (daily cron) ────────────────────────────────────────────────────
async function runWinback(telegram) {
  const status = await SystemStatus.get();
  if (!status.winbackEnabled) return { sent: 0 };
  const days = status.winbackDays || 30;
  const bonus = status.winbackBonusMC || 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const resendGap = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // max once per 90 days

  const users = await User.find({
    lastActive: { $lt: cutoff },
    isBlocked: { $ne: true },
    $or: [{ lastWinbackAt: null }, { lastWinbackAt: { $lt: resendGap } }],
  }).limit(200);

  let sent = 0;
  for (const user of users) {
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, $or: [{ lastWinbackAt: null }, { lastWinbackAt: { $lt: resendGap } }] },
      { $set: { lastWinbackAt: new Date() } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      if (bonus > 0) {
        await creditCoin(user._id, bonus, { type: 'Bonus', note: 'Win-back bonus' });
      }
    } catch (e) {
      // credit failed → roll back the claim so a later run can retry
      console.error('[PromoPerks] winback credit error:', user.telegramId, e.message);
      await User.updateOne(
        { _id: user._id },
        { $set: { lastWinbackAt: user.lastWinbackAt || null } }
      ).catch(() => {});
      continue;
    }
    try {
      await telegram.sendMessage(
        user.telegramId,
        `😢 *လွမ်းနေတယ်နော် ${user.first_name || ''}!*\n\n` +
          `မတွေ့ရတာ ကြာပြီမို့ ` +
          (bonus > 0
            ? `ပြန်လာစေချင်လို့ *${bonus.toLocaleString()} MC* လက်ဆောင် ထည့်ပေးထားပါတယ် 🎁\n`
            : `သတိရလို့ နှုတ်ဆက်လိုက်ပါတယ် 👋\n`) +
          `\n🛍 /shop မှာ ပစ္စည်းအသစ်တွေ ကြည့်လို့ရပါပြီ!`,
        { parse_mode: 'Markdown' }
      );
      sent++;
    } catch (e) {
      // 403 = user blocked the bot; winback flag already set so we won't retry
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (sent > 0) console.log(`[PromoPerks] 😴 Win-back messages sent: ${sent}`);
  return { sent };
}

// ── Monthly spend leaderboard ────────────────────────────────────────────────
/** Top spenders (Success orders) for a month. monthStart/monthEnd = Date bounds. */
async function getTopSpenders(monthStart, monthEnd, limit = 10) {
  return Order.aggregate([
    { $match: { status: 'Success', timestamp: { $gte: monthStart, $lt: monthEnd } } },
    { $group: { _id: '$userId', total: { $sum: '$amount' }, orders: { $sum: 1 } } },
    { $sort: { total: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $project: { total: 1, orders: 1, 'user.first_name': 1, 'user.username': 1, 'user.telegramId': 1, 'user._id': 1 } },
  ]);
}

/** Current-month bounds in MMT. */
function currentMonthBounds() {
  const { year, month } = mmtToday();
  const start = new Date(Date.UTC(year, month - 1, 1) - MMT_OFFSET_MS);
  const end = new Date(Date.UTC(year, month, 1) - MMT_OFFSET_MS);
  return { start, end, year, month };
}

/** Previous-month bounds in MMT. */
function previousMonthBounds() {
  const { year, month } = mmtToday();
  const start = new Date(Date.UTC(year, month - 2, 1) - MMT_OFFSET_MS);
  const end = new Date(Date.UTC(year, month - 1, 1) - MMT_OFFSET_MS);
  return { start, end };
}

function maskName(u) {
  const name = u.first_name || u.username || 'User';
  return name.length <= 2 ? `${name}***` : `${name.slice(0, 3)}***`;
}

// ── Monthly prize award (cron: 1st of month) ─────────────────────────────────
async function awardMonthlyPrizes(telegram) {
  const status = await SystemStatus.get();
  if (!status.leaderboardEnabled) return { awarded: 0 };
  const prizes = (status.leaderboardPrizes || []).filter((p) => p > 0);
  if (!prizes.length) return { awarded: 0 };

  const { start, end } = previousMonthBounds();
  const top = await getTopSpenders(start, end, prizes.length);
  if (!top.length) return { awarded: 0 };

  const medals = ['🥇', '🥈', '🥉', '🏅', '🏅'];
  let awarded = 0;
  const lines = [];
  for (let i = 0; i < top.length && i < prizes.length; i++) {
    const row = top[i];
    const prize = prizes[i];
    try {
      await creditCoin(row.user._id, prize, {
        type: 'Bonus',
        note: `Monthly leaderboard prize — rank ${i + 1}`,
      });
      await telegram.sendMessage(
        row.user.telegramId,
        `${medals[i] || '🏅'} *Leaderboard ဆုရပါပြီ!*\n\nပြီးခဲ့တဲ့လရဲ့ အဝယ်အများဆုံး *No.${i + 1}* ဖြစ်လို့ *${prize.toLocaleString()} MC* ဆုချီးမြှင့်လိုက်ပါတယ် 🎉`,
        { parse_mode: 'Markdown' }
      );
      awarded++;
    } catch (e) {
      console.error('[PromoPerks] prize error:', e.message);
    }
    lines.push(`${medals[i] || '🏅'} ${maskName(row.user)} — ${row.total.toLocaleString()} KS → ${prize.toLocaleString()} MC`);
  }

  try {
    await telegram.sendMessage(
      config.bot.adminId,
      `🏆 *Monthly Leaderboard Prizes Awarded*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  } catch {}
  await auditLog(0, 'LEADERBOARD_PRIZES_AWARDED', 'monthly', 'System', { awarded });
  return { awarded };
}

module.exports = {
  mmtHour,
  mmtToday,
  isHappyHourNow,
  happyHourBonusMC,
  giveCashback,
  firstOrderDiscountPct,
  runBirthdayGifts,
  runWinback,
  getTopSpenders,
  currentMonthBounds,
  previousMonthBounds,
  maskName,
  awardMonthlyPrizes,
};
