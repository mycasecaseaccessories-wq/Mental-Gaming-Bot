/**
 * Daily Check-In Commands
 *
 * /checkin   — perform today's check-in or show status if already done
 * /streak    — show streak stats + 7-day reward preview
 * /calendar  — current month check-in calendar view
 */

const { Markup } = require('telegraf');
const {
  doCheckIn,
  getCheckInStatus,
  getMonthCalendar,
  buildCalendar,
  getRewardPreview,
  getMSTToday,
  MILESTONES,
} = require('../services/CheckInService');
const { checkRestrictions } = require('../middlewares/checkRestrictions');
const { price } = require('../utils/ui');
const { t } = require('../utils/i18n');
const User = require('../models/User');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Animated check-in: stamp effect ──────────────────────────────────────────
async function animateCheckIn(ctx, msgRef, result) {
  const frames = [
    '⬜ ⬜ ⬜\n⬜ ⬜ ⬜\n⬜ ⬜ ⬜',
    '🟨 ⬜ ⬜\n⬜ ⬜ ⬜\n⬜ ⬜ ⬜',
    '🟨 🟨 ⬜\n🟨 ⬜ ⬜\n⬜ ⬜ ⬜',
    '🟩 🟩 🟩\n🟩 🟩 🟩\n🟩 🟩 🟩',
    '✅ ✅ ✅\n✅ ✅ ✅\n✅ ✅ ✅',
  ];

  for (const frame of frames) {
    await sleep(350);
    await ctx.telegram.editMessageText(
      msgRef.chatId, msgRef.messageId, undefined,
      `📅 *Stamping...*\n\n${frame}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

// ── Format streak fire display ────────────────────────────────────────────────
function streakBar(streak) {
  if (streak === 0) return '○ ○ ○ ○ ○ ○ ○';
  const filled = Math.min(streak % 7 || 7, 7);
  const dots = Array.from({ length: 7 }, (_, i) => i < filled ? '🔥' : '○').join(' ');
  return dots;
}

// ── Result message ────────────────────────────────────────────────────────────
function buildResultText(ctx, result) {
  const streakEmoji = result.streak >= 30 ? '🏆' : result.streak >= 14 ? '🏅' : result.streak >= 7 ? '🎉' : '🔥';
  const dayWord = result.streak !== 1 ? t(ctx, 'common.days') : t(ctx, 'common.day');
  const streakText  = `${streakEmoji} *${t(ctx, 'checkin.streak_label')}: ${result.streak} ${dayWord}!*`;
  const bar = streakBar(result.streak);

  const brokenNote = result.isStreakBroken ? `\n${t(ctx, 'checkin.broken')}` : '';

  const milestoneNote = result.isMilestone && result.milestoneLabel
    ? `\n\n${t(ctx, 'checkin.milestone')}\n${result.milestoneLabel}`
    : '';

  const ksLine = result.ksReward > 0
    ? `\n💰 *+${result.ksReward.toLocaleString()} KS* ${t(ctx, 'checkin.bonus')}!`
    : '';

  const nextR = result.nextReward;
  const nextKs = nextR.ks > 0 ? ` + ${nextR.ks.toLocaleString()} KS` : '';

  return (
    `${t(ctx, 'checkin.complete')}\n\n` +
    `${streakText}\n` +
    `${bar}\n` +
    brokenNote +
    `\n🪙 *+${result.coinReward} Mental Coins* ${t(ctx, 'checkin.earned')}!` +
    ksLine +
    `\n💳 ${t(ctx, 'checkin.coin_balance')}: *${result.user.balanceCoin.toLocaleString()} MC*` +
    milestoneNote +
    `\n\n_${t(ctx, 'checkin.tomorrow')}: *+${nextR.coins} MC*${nextKs}_`
  );
}

module.exports = function registerCheckIn(bot) {

  // ── /checkin ────────────────────────────────────────────────────────────────
  bot.command('checkin', checkRestrictions('checkin'), async (ctx) => {
    await handleCheckIn(ctx);
  });

  bot.hears(['🗓 Check In', '🗓 နေ့စဉ်ဝင်', '✅ Check In', 'checkin'], checkRestrictions('checkin'), async (ctx) => {
    await handleCheckIn(ctx);
  });

  async function handleCheckIn(ctx) {
    const status = await getCheckInStatus(ctx.from.id);
    if (!status) return ctx.reply(t(ctx, 'common.user_not_found'));

    if (status.alreadyCheckedIn) {
      const nextMidnight = new Date();
      nextMidnight.setUTCHours(17, 30, 0, 0); // midnight MST
      if (nextMidnight <= new Date()) nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
      const hoursLeft = Math.ceil((nextMidnight - new Date()) / 3600000);

      const bar = streakBar(status.streak);
      const dayWord = status.streak !== 1 ? t(ctx, 'common.days') : t(ctx, 'common.day');
      await ctx.reply(
        `${t(ctx, 'checkin.already_today')}\n\n` +
        `🔥 ${t(ctx, 'checkin.current_streak')}: *${status.streak} ${dayWord}*\n` +
        `${bar}\n\n` +
        `⏳ ${t(ctx, 'checkin.next_in')}: *~${hoursLeft}h*\n\n` +
        `_${t(ctx, 'checkin.tomorrow_reward')}: *+${status.nextReward.coins} MC*${status.nextReward.ks > 0 ? ` + ${status.nextReward.ks} KS` : ''}_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(ctx, 'checkin.calendar'),  'ci_calendar')],
            [Markup.button.callback(t(ctx, 'checkin.my_streak'), 'ci_streak')],
          ]),
        }
      );
      return;
    }

    // Animate then process
    const msgRef = {
      chatId:    ctx.chat.id,
      messageId: (await ctx.reply('📅 *Preparing check-in...*', { parse_mode: 'Markdown' })).message_id,
    };

    try {
      await animateCheckIn(ctx, msgRef, null);

      const result = await doCheckIn(ctx.from.id);

      await ctx.telegram.editMessageText(
        msgRef.chatId, msgRef.messageId, undefined,
        buildResultText(ctx, result),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(ctx, 'checkin.calendar'),  'ci_calendar')],
            [Markup.button.callback(t(ctx, 'checkin.my_streak'), 'ci_streak')],
          ]),
        }
      ).catch(() => {});
    } catch (err) {
      if (err.message === 'already_checked_in') {
        await ctx.telegram.editMessageText(
          msgRef.chatId, msgRef.messageId, undefined,
          '✅ You already checked in today! Come back tomorrow.'
        ).catch(() => {});
      } else {
        await ctx.telegram.editMessageText(
          msgRef.chatId, msgRef.messageId, undefined,
          `❌ ${err.message}`
        ).catch(() => {});
      }
    }
  }

  // ── /streak ─────────────────────────────────────────────────────────────────
  bot.command('streak', async (ctx) => {
    await showStreak(ctx);
  });

  async function showStreak(ctx) {
    const { t } = require('../utils/i18n');
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.start_first'));

    const status   = await getCheckInStatus(ctx.from.id);
    const streak   = user.checkInStreak || 0;
    const longest  = user.longestStreak || 0;
    const total    = user.totalCheckIns || 0;
    const bar      = streakBar(streak);

    const dayWord = t(ctx, streak === 1 ? 'common.day' : 'common.days');
    const daysWord = t(ctx, 'common.days');

    const nextMilestone = MILESTONES.find((m) => m.streak > streak);
    const milestoneText = nextMilestone
      ? `\n🎯 ${t(ctx, 'streak.next_milestone')}: *Day ${nextMilestone.streak}* — +${nextMilestone.coins} MC + ${nextMilestone.ks.toLocaleString()} KS`
      : `\n${t(ctx, 'streak.all_milestones')}`;

    const today = getMSTToday();
    const checkedToday = user.lastCheckInDate === today;

    const text =
      `${t(ctx, 'streak.title')}\n\n` +
      `🔥 ${t(ctx, 'streak.current')}: *${streak} ${dayWord}*\n` +
      `${bar}\n\n` +
      `🏆 ${t(ctx, 'streak.longest')}: *${longest} ${daysWord}*\n` +
      `📅 ${t(ctx, 'streak.total')}: *${total}*\n` +
      `${checkedToday ? t(ctx, 'streak.checked_today') : t(ctx, 'streak.not_yet_today')}\n` +
      milestoneText +
      `\n\n${t(ctx, 'streak.reward_preview')}\n${getRewardPreview(streak)}`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        checkedToday
          ? [Markup.button.callback(t(ctx, 'streak.checked_today'), 'ci_noop')]
          : [Markup.button.callback(t(ctx, 'streak.checkin_now'), 'ci_do')],
        [Markup.button.callback(t(ctx, 'streak.view_calendar'), 'ci_calendar')],
      ]),
    });
  }

  // ── /calendar ───────────────────────────────────────────────────────────────
  bot.command('calendar', async (ctx) => {
    await showCalendar(ctx);
  });

  async function showCalendar(ctx, year = null, month = null) {
    const { t } = require('../utils/i18n');
    const today = getMSTToday();
    const [y, m] = (year && month)
      ? [year, month]
      : [parseInt(today.slice(0, 4)), parseInt(today.slice(5, 7))];

    const data = await getMonthCalendar(ctx.from.id, y, m);
    if (!data) return ctx.reply(t(ctx, 'common.start_first'));

    const calendar = buildCalendar(y, m, data.checkedDays, data.todayDay, data.todayMonth, data.todayYear);
    const checkedCount = data.checkedDays.size;
    const dayWord = t(ctx, checkedCount === 1 ? 'common.day' : 'common.days');

    const prevMonth = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const nextMonth = m === 12 ? { y: y + 1, m: 1  } : { y, m: m + 1 };

    await ctx.reply(
      `${calendar}\n\n` +
      `✅ ${t(ctx, 'calendar.checked_in')} *${checkedCount}* ${dayWord} ${t(ctx, 'calendar.this_month')}\n\n` +
      `${t(ctx, 'calendar.legend')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('◀', `ci_cal:${prevMonth.y}:${prevMonth.m}`),
            Markup.button.callback(`${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m]} ${y}`, 'ci_noop'),
            Markup.button.callback('▶', `ci_cal:${nextMonth.y}:${nextMonth.m}`),
          ],
          [Markup.button.callback(t(ctx, 'calendar.my_streak_btn'), 'ci_streak')],
        ]),
      }
    );
  }

  // ── Actions ──────────────────────────────────────────────────────────────────
  bot.action('ci_do', async (ctx) => {
    await ctx.answerCbQuery('Checking in!');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await handleCheckIn(ctx);
  });

  bot.action('ci_calendar', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await showCalendar(ctx);
  });

  bot.action('ci_streak', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await showStreak(ctx);
  });

  bot.action(/^ci_cal:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const year  = parseInt(ctx.match[1]);
    const month = parseInt(ctx.match[2]);

    const today = getMSTToday();
    const [y, m] = (year && month)
      ? [year, month]
      : [parseInt(today.slice(0, 4)), parseInt(today.slice(5, 7))];

    const data     = await getMonthCalendar(ctx.from.id, y, m);
    if (!data) return;
    const calendar = buildCalendar(y, m, data.checkedDays, data.todayDay, data.todayMonth, data.todayYear);
    const count    = data.checkedDays.size;

    const prevMonth = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const nextMonth = m === 12 ? { y: y + 1, m: 1  } : { y, m: m + 1 };
    const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    await ctx.editMessageText(
      `${calendar}\n\n` +
      `✅ Checked in *${count}* day${count !== 1 ? 's' : ''} this month\n\n` +
      `✅ Checked in  📍 Today  🔲 Missed`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('◀', `ci_cal:${prevMonth.y}:${prevMonth.m}`),
            Markup.button.callback(`${MONTHS[m]} ${y}`, 'ci_noop'),
            Markup.button.callback('▶', `ci_cal:${nextMonth.y}:${nextMonth.m}`),
          ],
          [Markup.button.callback('📊 My Streak', 'ci_streak')],
        ]),
      }
    ).catch(() => {});
  });

  bot.action('ci_noop', async (ctx) => ctx.answerCbQuery());
};
