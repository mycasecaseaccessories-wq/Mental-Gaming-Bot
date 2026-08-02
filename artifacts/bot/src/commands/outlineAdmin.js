/**
 * outlineAdmin.js — Admin panel for setting the Outline VPN bot username.
 *
 * Admin keyboard မှ "🔑 Outline VPN" နှိပ်လျှင်:
 *   - Current @username ပြပေး
 *   - ✏️ Set Username  → text wizard → save to SystemStatus
 *   - 🗑 Clear         → username ဖျက် (user menu မှ VPN button ပျောက်သည်)
 *
 * Session key: ctx.session.outlineAdminWizard = { step: 'set_username' }
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const SystemStatus = require('../models/SystemStatus');
const { auditLog } = require('../services/logger');

// ── Helpers ──────────────────────────────────────────────────────────────────

function clearWizard(ctx) {
  if (ctx.session) ctx.session.outlineAdminWizard = null;
}

function setWizard(ctx, step) {
  if (!ctx.session) ctx.session = {};
  ctx.session.outlineAdminWizard = { step };
}

function getWizard(ctx) {
  return ctx.session?.outlineAdminWizard || null;
}

function sanitiseUsername(raw) {
  // Strip leading @ and whitespace
  return raw.trim().replace(/^@/, '');
}

// ── Panel keyboard ────────────────────────────────────────────────────────────

function panelKeyboard(hasUsername) {
  const rows = [
    [Markup.button.callback('✏️ Username သတ်မှတ်ရန်', 'oadm_vpn_set')],
  ];
  if (hasUsername) {
    rows.push([Markup.button.callback('🗑 Username ဖျက်ရန်', 'oadm_vpn_clear')]);
  }
  return Markup.inlineKeyboard(rows);
}

// ── Register ─────────────────────────────────────────────────────────────────

module.exports = function register(bot) {

  // ── Entry: admin keyboard button ─────────────────────────────────────────
  bot.hears('🔑 Outline VPN', adminOnly(), async (ctx) => {
    clearWizard(ctx);
    const status = await SystemStatus.get();
    const username = status.outlineBotUsername;
    await ctx.reply(
      `🔑 *Outline VPN Bot — ချိတ်ဆက်မှု*\n\n` +
      `${username ? `✅ ယခု Bot: *@${username}*` : '❌ Bot username မသတ်မှတ်ရသေး'}\n\n` +
      `Username သတ်မှတ်ထားလျှင် User menu တွင် 🌐 Outline VPN button ပေါ်လာမည်။\n` +
      `Button နှိပ်ပါက user မျာ VPN bot ဆီသို့ တိုက်ရိုက်ရောက်မည်။`,
      { parse_mode: 'Markdown', ...panelKeyboard(!!username) }
    );
  });

  // ── Set username ─────────────────────────────────────────────────────────
  bot.action('oadm_vpn_set', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    setWizard(ctx, 'set_username');
    await ctx.reply(
      '✏️ Outline VPN bot ရဲ့ @username ရိုက်ထည့်ပါ:\n_(ဥပမာ: `MyOutlineBot` သို့မဟုတ် `@MyOutlineBot`)_',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ ပယ်ဖျက်', 'oadm_vpn_cancel')]]) }
    );
  });

  // ── Clear username ───────────────────────────────────────────────────────
  bot.action('oadm_vpn_clear', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await SystemStatus.set({ outlineBotUsername: null }, ctx.from.id);
    auditLog(ctx, 'Outline VPN username cleared');
    clearWizard(ctx);
    await ctx.editMessageText(
      '🗑 *Outline VPN bot username ဖျက်ပြီးပါပြီ*\n\nUser menu မှ 🌐 Outline VPN button ပျောက်သွားမည်။',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Cancel wizard ────────────────────────────────────────────────────────
  bot.action('oadm_vpn_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    clearWizard(ctx);
    await ctx.deleteMessage().catch(() => {});
  });

  // ── Text wizard intercept ────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const wizard = getWizard(ctx);
    if (!wizard || wizard.step !== 'set_username') return next();
    // Only admin should reach here but double-check
    if (Number(ctx.from.id) !== Number(require('../../config/settings').config.bot.adminId)) return next();

    const text = ctx.message.text.trim();
    // Don't swallow admin keyboard button presses
    if (text.startsWith('/') || text.startsWith('📊') || text.startsWith('🔑') || text.startsWith('📖') || text.startsWith('🔙')) {
      clearWizard(ctx);
      return next();
    }

    const username = sanitiseUsername(text);
    if (!username) {
      return ctx.reply('⚠️ Valid username ရိုက်ပါ');
    }

    await SystemStatus.set({ outlineBotUsername: username }, ctx.from.id);
    auditLog(ctx, `Outline VPN username set: @${username}`);
    clearWizard(ctx);

    await ctx.reply(
      `✅ *Outline VPN Bot သတ်မှတ်ပြီးပါပြီ\\!*\n\n` +
      `Bot: *@${username.replace(/[_*`[\]()~>#+=|{}.!-]/g, '\\$1')}*\n\n` +
      `User မျာ /start ပြန်နှိပ်ပါက 🌐 Outline VPN button ပေါ်လာမည်။`,
      { parse_mode: 'MarkdownV2' }
    );
  });
};
