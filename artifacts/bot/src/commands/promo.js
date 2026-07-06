/**
 * Promo Code Commands
 *
 * User: /promo <code> — validate and preview discount
 * Admin: /createpromo — create new promo code (guided)
 *        /listpromos — show all active promos
 *        /deletepromo <code> — deactivate a promo
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { validatePromo, createPromo, listPromos, deactivatePromo } = require('../services/PromoService');
const { price } = require('../utils/ui');
const { config } = require('../../config/settings');

module.exports = function registerPromo(bot) {

  bot.hears(['🎟 Promo', '🎟 ပရိုမို'], async (ctx) => {
    const { t } = require('../utils/i18n');
    await ctx.reply(
      `${t(ctx, 'promo.title')}\n\n${t(ctx, 'promo.instructions')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎟 Enter Promo Code', 'promo_enter')],
          [Markup.button.callback('🛒 Go to Shop',       'nav:go:shop')],
        ]),
      }
    );
  });

  // Inline entry — ask user to type the code
  bot.action('promo_enter', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingPromoCode = true;
    await ctx.reply('🎟 Type your promo code:', { ...Markup.forceReply() });
  });

  // Capture typed promo code from inline entry
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.awaitingPromoCode) return next();
    if (ctx.message?.text?.startsWith('/')) return next();
    ctx.session.awaitingPromoCode = false;
    const code = ctx.message.text.trim().toUpperCase();
    const result = await validatePromo(code, ctx.from.id, Infinity);
    if (!result.valid) return ctx.reply(`❌ *${code}*: ${result.error}`, { parse_mode: 'Markdown' });
    const p = result.promo;
    const disc = p.discountType === 'Flat' ? `${price(p.value)} off` : `${p.value}% off`;
    return ctx.reply(
      `✅ *${p.code}* — *${disc}*` +
      (p.minOrderAmount > 0 ? `\nMin order: ${price(p.minOrderAmount)}` : '') +
      `\n\nApply this code at checkout.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🛒 Go to Shop', 'nav:go:shop')]]),
      }
    );
  });

  // ── User: check a promo code ───────────────────────────────────────────────
  bot.command('promo', async (ctx) => {
    const { t } = require('../utils/i18n');
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      return ctx.reply(
        `${t(ctx, 'promo.title')}\n\n${t(ctx, 'promo.usage_short')}`,
        { parse_mode: 'Markdown' }
      );
    }

    const code = args[0].toUpperCase().trim();
    const result = await validatePromo(code, ctx.from.id, Infinity);

    if (!result.valid) {
      return ctx.reply(`❌ *${code}*: ${result.error}`, { parse_mode: 'Markdown' });
    }

    const p = result.promo;
    const off = t(ctx, 'promo.off');
    const discountDesc = p.discountType === 'Flat'
      ? `${price(p.value)} ${off}`
      : `${p.value}% ${off}`;

    await ctx.reply(
      `${t(ctx, 'promo.code_valid')}\n\n` +
      `🎟 ${t(ctx, 'promo.code')}: \`${p.code}\`\n` +
      `🏷 ${t(ctx, 'promo.discount')}: *${discountDesc}*\n` +
      (p.minOrderAmount > 0 ? `📋 ${t(ctx, 'promo.min_order')}: *${price(p.minOrderAmount)}*\n` : '') +
      (p.expiryDate ? `📅 ${t(ctx, 'promo.expires')}: ${new Date(p.expiryDate).toLocaleDateString('en-GB')}\n` : '') +
      `\n${t(ctx, 'promo.apply_hint')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /createpromo ────────────────────────────────────────────────────
  bot.command('createpromo', adminOnly(), async (ctx) => {
    ctx.session.adminCreatePromo = { step: 'code' };
    await ctx.reply(
      `🎟 *Create Promo Code*\n\nStep 1/5: Enter the promo code:\n_(e.g. SAVE500, NEWUSER, FLASH10)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── Admin: /listpromos ─────────────────────────────────────────────────────
  bot.command('listpromos', adminOnly(), async (ctx) => {
    const promos = await listPromos({ activeOnly: false });
    if (!promos.length) return ctx.reply('No promo codes created yet. Use /createpromo.');

    const lines = promos.map((p) => {
      const disc = p.discountType === 'Flat' ? `${price(p.value)} off` : `${p.value}% off`;
      const uses  = p.maxUses ? `${p.currentUses}/${p.maxUses}` : `${p.currentUses}/∞`;
      const status = p.isActive ? '🟢' : '🔴';
      return `${status} \`${p.code}\` — ${disc} — Uses: ${uses}`;
    });

    await ctx.reply(`🎟 *All Promo Codes (${promos.length})*\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Create New', 'promo_create_start')]]),
    });
  });

  bot.action('promo_create_start', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminCreatePromo = { step: 'code' };
    await ctx.reply(`Step 1/5: Enter the promo code:`, { ...Markup.forceReply() });
  });

  // ── Admin: /deletepromo ────────────────────────────────────────────────────
  bot.command('deletepromo', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) return ctx.reply('Usage: /deletepromo CODENAME');

    try {
      const promo = await deactivatePromo(args[0], ctx.from.id);
      await ctx.reply(`✅ Promo \`${promo.code}\` deactivated.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Multi-step promo creation interceptor ─────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminCreatePromo;
    if (!state || ctx.from.id !== config.bot.adminId) return next();

    const input = ctx.message.text.trim();

    if (state.step === 'code') {
      if (!/^[A-Z0-9_]{2,20}$/i.test(input)) {
        return ctx.reply('❌ Code must be 2–20 alphanumeric characters. Try again:');
      }
      state.code = input.toUpperCase();
      state.step = 'type';
      await ctx.reply(
        `Step 2/5: Discount type?\n\nType \`flat\` (fixed KS) or \`pct\` (percentage):`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );

    } else if (state.step === 'type') {
      const t = input.toLowerCase();
      if (!['flat', 'pct', 'percentage'].includes(t)) {
        return ctx.reply('Type `flat` or `pct`:');
      }
      state.discountType = t === 'flat' ? 'Flat' : 'Percentage';
      state.step = 'value';
      await ctx.reply(
        `Step 3/5: Enter the discount value:\n${state.discountType === 'Flat' ? '_(e.g. 500 for 500 KS off)_' : '_(e.g. 10 for 10% off)_'}`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );

    } else if (state.step === 'value') {
      const val = parseFloat(input);
      if (isNaN(val) || val <= 0) return ctx.reply('❌ Enter a positive number.');
      state.value = val;
      state.step = 'uses';
      await ctx.reply(`Step 4/5: Max uses? (enter number or \`unlimited\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'uses') {
      state.maxUses = input.toLowerCase() === 'unlimited' ? null : parseInt(input, 10);
      state.step = 'expiry';
      await ctx.reply(`Step 5/5: Expiry date? (DD/MM/YYYY or \`never\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'expiry') {
      let expiryDate = null;
      if (input.toLowerCase() !== 'never') {
        const [d, m, y] = input.split('/');
        expiryDate = new Date(y, m - 1, d, 23, 59, 59);
        if (isNaN(expiryDate.getTime())) return ctx.reply('❌ Invalid date. Use DD/MM/YYYY or `never`.');
      }

      ctx.session.adminCreatePromo = null;

      try {
        const promo = await createPromo(ctx.from.id, {
          code: state.code,
          discountType: state.discountType,
          value: state.value,
          maxUses: state.maxUses,
          expiryDate,
        });

        const discDisplay = promo.discountType === 'Flat'
          ? `${price(promo.value)} off`
          : `${promo.value}% off`;

        await ctx.reply(
          `✅ *Promo Created!*\n\n` +
          `🎟 Code: \`${promo.code}\`\n` +
          `🏷 Discount: *${discDisplay}*\n` +
          `🔢 Max Uses: ${promo.maxUses || '∞'}\n` +
          `📅 Expires: ${expiryDate ? expiryDate.toLocaleDateString('en-GB') : 'Never'}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    }
  });
};
