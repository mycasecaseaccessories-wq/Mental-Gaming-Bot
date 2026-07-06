/**
 * MC Config Admin — Manage Mental Coin Exchange & Review Reward settings.
 *
 * Commands (Owner only):
 *   /mcconfig                  — show dashboard with current settings
 *   /setmcrate <n>             — 1 MC = N KS (exchange rate)
 *   /setmcmin <n>              — minimum MC needed to redeem
 *   /setmcmaxpct <n>           — max order discount % from MC (1–100)
 *   /setreviewreward <n>       — MC coins awarded per qualifying review
 *
 * Callback actions (Owner):
 *   mc_toggle_redeem           — toggle mcRedeemEnabled on/off
 *   mc_toggle_review           — toggle reviewRewardEnabled on/off
 *   mc_refresh                 — refresh dashboard
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const SystemStatus = require('../models/SystemStatus');

// ── Dashboard helpers ─────────────────────────────────────────────────────────

async function getConfig() {
  const s = await SystemStatus.getStatus();
  return {
    mcRedeemEnabled:    s.mcRedeemEnabled    ?? false,
    mcExchangeRate:     s.mcExchangeRate     ?? 1,
    mcMinRedeem:        s.mcMinRedeem        ?? 500,
    mcMaxDiscountPct:   s.mcMaxDiscountPct   ?? 20,
    reviewRewardEnabled: s.reviewRewardEnabled ?? false,
    reviewRewardAmount:  s.reviewRewardAmount  ?? 50,
  };
}

function dashboardText(cfg) {
  const redeemIcon = cfg.mcRedeemEnabled    ? '🟢 ON' : '🔴 OFF';
  const reviewIcon = cfg.reviewRewardEnabled ? '🟢 ON' : '🔴 OFF';

  return (
    `💱 *Mental Coin Config*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*MC Exchange (Checkout Discount)*\n` +
    `  Status  : ${redeemIcon}\n` +
    `  Rate    : 1 MC = *${cfg.mcExchangeRate} KS* discount\n` +
    `  Min MC  : *${cfg.mcMinRedeem.toLocaleString()} MC* minimum to redeem\n` +
    `  Max Off : up to *${cfg.mcMaxDiscountPct}%* of order total\n\n` +
    `*Review Reward*\n` +
    `  Status  : ${reviewIcon}\n` +
    `  Reward  : *${cfg.reviewRewardAmount} MC* per qualifying review\n` +
    `  _(4★+ review with comment)_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Commands:\n` +
    `• \`/setmcrate <n>\` — exchange rate (1 MC = N KS)\n` +
    `• \`/setmcmin <n>\` — min MC to redeem\n` +
    `• \`/setmcmaxpct <n>\` — max discount % (1–100)\n` +
    `• \`/setreviewreward <n>\` — review reward amount`
  );
}

function dashboardKeyboard(cfg) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        cfg.mcRedeemEnabled ? '🔴 Disable MC Exchange' : '🟢 Enable MC Exchange',
        'mc_toggle_redeem'
      ),
    ],
    [
      Markup.button.callback(
        cfg.reviewRewardEnabled ? '🔴 Disable Review Reward' : '🟢 Enable Review Reward',
        'mc_toggle_review'
      ),
    ],
    [Markup.button.callback('🔄 Refresh', 'mc_refresh')],
  ]);
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerMcConfig(bot) {

  // ── /mcconfig ─────────────────────────────────────────────────────────────

  bot.command('mcconfig', adminOnly(), async (ctx) => {
    const cfg = await getConfig();
    await ctx.reply(dashboardText(cfg), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(cfg),
    });
  });

  // ── /setmcrate <n> ────────────────────────────────────────────────────────

  bot.command('setmcrate', adminOnly(), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1];
    const n = parseFloat(arg);
    if (!arg || isNaN(n) || n <= 0) {
      return ctx.reply(
        '❌ Usage: `/setmcrate <number>`\nExample: `/setmcrate 1` (1 MC = 1 KS)\nExample: `/setmcrate 0.5` (1 MC = 0.5 KS)',
        { parse_mode: 'Markdown' }
      );
    }
    await SystemStatus.findOneAndUpdate({}, { $set: { mcExchangeRate: n } }, { upsert: true });
    await ctx.reply(`✅ Exchange rate set: *1 MC = ${n} KS* discount.`, { parse_mode: 'Markdown' });
  });

  // ── /setmcmin <n> ─────────────────────────────────────────────────────────

  bot.command('setmcmin', adminOnly(), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1];
    const n = parseInt(arg, 10);
    if (!arg || isNaN(n) || n < 1) {
      return ctx.reply(
        '❌ Usage: `/setmcmin <amount>`\nExample: `/setmcmin 500` (need 500 MC minimum)',
        { parse_mode: 'Markdown' }
      );
    }
    await SystemStatus.findOneAndUpdate({}, { $set: { mcMinRedeem: n } }, { upsert: true });
    await ctx.reply(
      `✅ Minimum redeem set to *${n.toLocaleString()} MC*.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setmcmaxpct <n> ──────────────────────────────────────────────────────

  bot.command('setmcmaxpct', adminOnly(), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1];
    const n = parseInt(arg, 10);
    if (!arg || isNaN(n) || n < 1 || n > 100) {
      return ctx.reply(
        '❌ Usage: `/setmcmaxpct <1–100>`\nExample: `/setmcmaxpct 20` (max 20% of order can be discounted)',
        { parse_mode: 'Markdown' }
      );
    }
    await SystemStatus.findOneAndUpdate({}, { $set: { mcMaxDiscountPct: n } }, { upsert: true });
    await ctx.reply(
      `✅ Max MC discount per order set to *${n}%*.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setreviewreward <n> ──────────────────────────────────────────────────

  bot.command('setreviewreward', adminOnly(), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1];
    const n = parseInt(arg, 10);
    if (!arg || isNaN(n) || n < 0) {
      return ctx.reply(
        '❌ Usage: `/setreviewreward <amount>`\nExample: `/setreviewreward 50` (award 50 MC per review)',
        { parse_mode: 'Markdown' }
      );
    }
    await SystemStatus.findOneAndUpdate({}, { $set: { reviewRewardAmount: n } }, { upsert: true });
    await ctx.reply(
      `✅ Review reward set to *${n} MC* per qualifying review.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Callback: mc_toggle_redeem ────────────────────────────────────────────

  bot.action('mc_toggle_redeem', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const s = await SystemStatus.getStatus();
    const newVal = !(s.mcRedeemEnabled ?? false);
    await SystemStatus.findOneAndUpdate({}, { $set: { mcRedeemEnabled: newVal } }, { upsert: true });
    const cfg = await getConfig();
    await ctx.editMessageText(dashboardText(cfg), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(cfg),
    });
  });

  // ── Callback: mc_toggle_review ────────────────────────────────────────────

  bot.action('mc_toggle_review', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const s = await SystemStatus.getStatus();
    const newVal = !(s.reviewRewardEnabled ?? false);
    await SystemStatus.findOneAndUpdate({}, { $set: { reviewRewardEnabled: newVal } }, { upsert: true });
    const cfg = await getConfig();
    await ctx.editMessageText(dashboardText(cfg), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(cfg),
    });
  });

  // ── Callback: mc_refresh ──────────────────────────────────────────────────

  bot.action('mc_refresh', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Refreshed');
    const cfg = await getConfig();
    await ctx.editMessageText(dashboardText(cfg), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(cfg),
    });
  });
};
