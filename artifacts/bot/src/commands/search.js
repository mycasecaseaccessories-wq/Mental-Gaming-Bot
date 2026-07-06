/**
 * Product search — /search <keyword> plus the 🔍 Search button in /shop.
 * Mirrors the mini-app search bar: case-insensitive match on product name,
 * excluding hidden/inactive products. Results reuse the `product:<id>` action
 * registered in shop.js so tapping a result opens the normal product card.
 */

const { Markup } = require('telegraf');
const Product = require('../models/Product');
const ThemeService = require('../services/ThemeService');
const { buildMessage, price, truncate } = require('../utils/ui');
const { t } = require('../utils/i18n');

const MAX_RESULTS = 20;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runSearch(ctx, rawQuery) {
  const theme = ThemeService.getTheme(ctx.user);
  const q = (rawQuery || '').trim();

  if (q.length < 2) {
    return ctx.reply(
      buildMessage(theme, [{
        title: t(ctx, 'shop.search_title'),
        lines: [`${theme.emoji.warning} ${t(ctx, 'shop.search_too_short')}`],
      }]),
      { parse_mode: 'Markdown' },
    );
  }

  const products = await Product.find({
    name: { $regex: escapeRegex(q), $options: 'i' },
    isActive: true,
    status: { $nin: ['hidden'] },
  })
    .sort({ finalPrice: 1 })
    .limit(MAX_RESULTS)
    .lean();

  if (!products.length) {
    return ctx.reply(
      buildMessage(theme, [{
        title: t(ctx, 'shop.search_title'),
        lines: [`${theme.emoji.warning} ${t(ctx, 'shop.search_none')} "${q}"`],
      }]),
      { parse_mode: 'Markdown' },
    );
  }

  const rows = products.map((p) => [
    Markup.button.callback(
      `${theme.emoji.item} ${truncate(p.name, 28)} — ${price(p.finalPrice)}`,
      `product:${p._id}`,
    ),
  ]);

  const text = buildMessage(theme, [{
    title: t(ctx, 'shop.search_title'),
    lines: [
      `${theme.emoji.bullet} ${products.length} ${t(ctx, 'shop.search_results_for')} "${q}"`,
      `${theme.emoji.bullet} ${t(ctx, 'shop.tap_to_order')}`,
    ],
  }]);

  return ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

function promptSearch(ctx) {
  if (ctx.session) ctx.session.awaitingSearch = true;
  const theme = ThemeService.getTheme(ctx.user);
  return ctx.reply(
    buildMessage(theme, [{
      title: t(ctx, 'shop.search_title'),
      lines: [t(ctx, 'shop.search_prompt')],
    }]),
    { parse_mode: 'Markdown' },
  );
}

module.exports = function registerSearch(bot) {
  bot.command('search', async (ctx) => {
    const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!query) return promptSearch(ctx);
    return runSearch(ctx, query);
  });

  bot.action('shop_search', async (ctx) => {
    await ctx.answerCbQuery();
    return promptSearch(ctx);
  });

  // Capture the next free-text message after the user taps 🔍 Search. Scenes are
  // handled earlier in the middleware chain, so this only fires for plain text
  // outside a scene. When not awaiting a search we pass control to the next
  // handler (the ambient AI catch-all).
  bot.on('text', async (ctx, next) => {
    if (ctx.session && ctx.session.awaitingSearch) {
      ctx.session.awaitingSearch = false;
      const txt = (ctx.message.text || '').trim();
      if (txt.startsWith('/')) return next();
      return runSearch(ctx, txt);
    }
    return next();
  });
};
