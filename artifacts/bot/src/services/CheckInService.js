/**
 * CheckInService — Daily Check-In & Streak System
 *
 * Rewards (Mental Coins only):
 *   Day 1 →  10 MC
 *   Day 2 →  15 MC
 *   Day 3 →  25 MC
 *   Day 4 →  40 MC
 *   Day 5 →  60 MC
 *   Day 6 →  90 MC
 *   Day 7 → 250 MC  🎉 Weekly Jackpot!
 *
 * Milestone bonuses (on top of daily reward):
 *   14-day streak → +450 MC  🏅 Two-Week Champion
 *   30-day streak → +1000 MC 🏆 Monthly Legend
 *   100-day streak → +2000 MC 💎 Centurion
 *
 * Streak resets to 1 if user misses a day.
 * Myanmar Time (UTC+6:30) is used as the day boundary.
 */

const CheckIn  = require('../models/CheckIn');
const User     = require('../models/User');
const { creditKS, creditCoin } = require('./WalletService');
const { auditLog } = require('./logger');

// ── Reward table (by day-in-streak, repeats every 7) ─────────────────────────
const DAILY_REWARD = [
  { coins: 10,  ks: 0,   label: 'Day 1' },   // index 0 → day 1
  { coins: 15,  ks: 0,   label: 'Day 2' },
  { coins: 25,  ks: 0,   label: 'Day 3' },
  { coins: 40,  ks: 0,   label: 'Day 4' },
  { coins: 60,  ks: 0,   label: 'Day 5' },
  { coins: 90,  ks: 0,   label: 'Day 6' },
  { coins: 250, ks: 0,   label: 'Day 7 🎉', milestone: true },  // index 6 → day 7
];

const MILESTONES = [
  { streak: 14,  coins: 450,  ks: 0, label: '🏅 Two-Week Champion!' },
  { streak: 30,  coins: 1000, ks: 0, label: '🏆 Monthly Legend!' },
  { streak: 100, coins: 2000, ks: 0, label: '💎 Centurion!' },
];

// ── Myanmar time helpers ──────────────────────────────────────────────────────
function getMSTDate(d = new Date()) {
  // UTC+6:30
  const offset = 6.5 * 60 * 60 * 1000;
  const mst = new Date(d.getTime() + offset);
  return mst.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getMSTToday() { return getMSTDate(); }

function getMSTYesterday() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return getMSTDate(yesterday);
}

// ── Get reward for a given streak day ────────────────────────────────────────
function getDayReward(streakDay) {
  const idx = (streakDay - 1) % 7;
  return DAILY_REWARD[idx];
}

// ── Check if user can check in today ─────────────────────────────────────────
async function getCheckInStatus(telegramId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) return null;

  const today = getMSTToday();
  const alreadyCheckedIn = await CheckIn.findOne({ userId: user._id, date: today });

  return {
    canCheckIn: !alreadyCheckedIn,
    alreadyCheckedIn: !!alreadyCheckedIn,
    streak: user.checkInStreak || 0,
    longestStreak: user.longestStreak || 0,
    totalCheckIns: user.totalCheckIns || 0,
    lastCheckInDate: user.lastCheckInDate || null,
    todayDate: today,
    nextReward: getDayReward((user.checkInStreak || 0) + 1),
  };
}

// ── Perform check-in ──────────────────────────────────────────────────────────
async function doCheckIn(telegramId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const today     = getMSTToday();
  const yesterday = getMSTYesterday();

  // Already checked in today?
  const existing = await CheckIn.findOne({ userId: user._id, date: today });
  if (existing) throw new Error('already_checked_in');

  // Calculate new streak
  const lastDate  = user.lastCheckInDate;
  let newStreak   = 1;

  if (lastDate === yesterday) {
    newStreak = (user.checkInStreak || 0) + 1;
  } else if (lastDate === today) {
    throw new Error('already_checked_in');
  }
  // else: streak broken → reset to 1

  // Get daily reward
  const dayReward = getDayReward(newStreak);
  let totalCoins  = dayReward.coins;
  let totalKS     = dayReward.ks;
  let isMilestone = !!dayReward.milestone;
  let milestoneLabel = dayReward.milestone ? dayReward.label : null;

  // Check streak milestones
  const milestone = MILESTONES.find((m) => m.streak === newStreak);
  if (milestone) {
    totalCoins  += milestone.coins;
    totalKS     += milestone.ks;
    isMilestone  = true;
    milestoneLabel = milestone.label;
  }

  // Save check-in record
  const record = await CheckIn.create({
    userId:    user._id,
    telegramId,
    date:      today,
    streakDay: newStreak,
    coinReward: totalCoins,
    ksReward:   totalKS,
    isMilestone,
    milestoneLabel,
  });

  // Update user streak fields
  user.checkInStreak   = newStreak;
  user.lastCheckInDate = today;
  user.totalCheckIns   = (user.totalCheckIns || 0) + 1;
  if (newStreak > (user.longestStreak || 0)) {
    user.longestStreak = newStreak;
  }
  await user.save();

  // Credit rewards
  if (totalCoins > 0) {
    await creditCoin(user._id, totalCoins, {
      type: 'Bonus',
      note: `Daily check-in — Streak Day ${newStreak}`,
    });
  }
  if (totalKS > 0) {
    await creditKS(user._id, totalKS, {
      type: 'Bonus',
      note: `Daily check-in milestone — Streak Day ${newStreak}`,
    });
  }

  await auditLog(telegramId, 'DAILY_CHECKIN', record._id.toString(), 'CheckIn', {
    streakDay: newStreak,
    coins: totalCoins,
    ks: totalKS,
  });

  const updatedUser = await User.findById(user._id);

  return {
    streak:          newStreak,
    coinReward:      totalCoins,
    ksReward:        totalKS,
    isMilestone,
    milestoneLabel,
    isStreakBroken:  newStreak === 1 && (user.checkInStreak > 1 || lastDate !== yesterday),
    user:            updatedUser,
    nextReward:      getDayReward(newStreak + 1),
  };
}

// ── Get calendar data for a given month ──────────────────────────────────────
async function getMonthCalendar(telegramId, year, month) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) return null;

  const records = await CheckIn.getMonthRecords(user._id, year, month);
  const checkedDays = new Set(records.map((r) => parseInt(r.date.split('-')[2])));

  const today     = getMSTToday();
  const todayDay  = parseInt(today.split('-')[2]);
  const todayMonth = parseInt(today.split('-')[1]);
  const todayYear  = parseInt(today.split('-')[0]);

  return { checkedDays, year, month, todayDay, todayMonth, todayYear };
}

// ── Build ASCII calendar ───────────────────────────────────────────────────────
function buildCalendar(year, month, checkedDays, todayDay, todayMonth, todayYear) {
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const startOffset = firstDay === 0 ? 6 : firstDay - 1; // Mon-first offset
  const daysInMonth = new Date(year, month, 0).getDate();

  const isCurrentMonth = month === todayMonth && year === todayYear;

  let header = `📅 *${MONTH_NAMES[month]} ${year}*\n`;
  header += `\`${DAYS.join('  ')}\`\n`;

  let row = '`';
  let col = 0;

  // Padding for first week
  for (let i = 0; i < startOffset; i++) {
    row += '    ';
    col++;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday   = isCurrentMonth && day === todayDay;
    const checked   = checkedDays.has(day);
    const isPast    = isCurrentMonth ? day < todayDay : year < todayYear || (year === todayYear && month < todayMonth);

    let cell;
    if (checked)    cell = ' ✅';
    else if (isToday) cell = ' 📍';
    else if (isPast)  cell = ' 🔲';
    else              cell = ` ${String(day).padStart(2)}`;

    row += cell + ' ';
    col++;

    if (col === 7) {
      row += '`\n`';
      col = 0;
    }
  }

  // Pad last row
  while (col > 0 && col < 7) {
    row += '    ';
    col++;
  }
  row += '`';

  return header + row;
}

// ── Get upcoming rewards preview ──────────────────────────────────────────────
function getRewardPreview(currentStreak) {
  const lines = [];
  for (let i = 1; i <= 7; i++) {
    const r = getDayReward(i);
    const done = i <= (currentStreak % 7 || (currentStreak > 0 && currentStreak % 7 === 0 ? 7 : 0));
    const current = (currentStreak % 7 || 7) === i;
    const prefix = done ? '✅' : current ? '▶️' : `  ${i}.`;
    const ksLine = r.ks > 0 ? ` + ${r.ks.toLocaleString()} KS` : '';
    lines.push(`${prefix} ${r.label}: *+${r.coins} MC*${ksLine}`);
  }
  return lines.join('\n');
}

module.exports = {
  doCheckIn,
  getCheckInStatus,
  getMonthCalendar,
  buildCalendar,
  getRewardPreview,
  getDayReward,
  DAILY_REWARD,
  MILESTONES,
  getMSTToday,
};
