/**
 * Rate Manager Wizard Scene
 *
 * Flow:
 *   Step 0 → Show all current rates, admin picks a currency
 *   Step 1 → Admin enters the new rate value
 *   Step 2 → Show impact summary + Approve All / Manual Edit buttons
 *   (Actions) → Approve All | Edit item by item | Set single manual price
 */

const { Scenes, Markup } = require('telegraf');
const { config } = require('../../config/settings');
const { updateRate, getAllRates } = require('../services/currencyService');
const { approveAllSuggestions, approveSingleProduct, setManualPrice } = require('../services/PriceCalculator');
const { auditLog } = require('../services/logger');

const CURRENCIES = ['BRL', 'PHP', 'USD'];
const PAGE_SIZE = 5;

function isAdmin(ctx) {
  return ctx.from?.id === config.bot.adminId;
}

function formatRate(doc) {
  return `• *${doc.currencyCode}*: \`${parseFloat(doc.rateToMMK.toFixed(4))}\` MMK  _(${doc.source}, ${new Date(doc.lastUpdated).toLocaleDateString()})_`;
}

function formatDiff(diff) {
  if (diff > 0) return `📈 +${diff.toLocaleString()} KS`;
  if (diff < 0) return `📉 ${diff.toLocaleString()} KS`;
  return `➡️ no change`;
}

function summaryText(currency, previews) {
  const increases = previews.filter((p) => p.diff > 0).length;
  const decreases = previews.filter((p) => p.diff < 0).length;
  const unchanged = previews.filter((p) => p.diff === 0).length;

  return (
    `💱 *Rate Updated — Impact Summary*\n\n` +
    `Currency: *${currency}*\n` +
    `Affected products: *${previews.length}*\n` +
    `📈 Price increases: ${increases}\n` +
    `📉 Price decreases: ${decreases}\n` +
    `➡️ Unchanged: ${unchanged}\n\n` +
    `_Suggested prices have been calculated but NOT applied yet._\n` +
    `Approve to commit changes to the live store.`
  );
}

function summaryKeyboard(currency, hasItems) {
  const buttons = [];
  if (hasItems) {
    buttons.push([Markup.button.callback('✅ Approve All', `rm_approve_all:${currency}`)]);
    buttons.push([Markup.button.callback('🔍 Manual Edit (item by item)', `rm_manual_edit:${currency}:0`)]);
  }
  buttons.push([Markup.button.callback('❌ Cancel — Keep Old Prices', 'rm_cancel')]);
  return Markup.inlineKeyboard(buttons);
}

function itemKeyboard(productId, currency, page) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Approve This', `rm_approve_one:${productId}`)],
    [Markup.button.callback('✏️ Set Manual Price', `rm_set_manual:${productId}`)],
    [
      Markup.button.callback('◀️ Prev', `rm_manual_edit:${currency}:${page - 1}`),
      Markup.button.callback('Next ▶️', `rm_manual_edit:${currency}:${page + 1}`),
    ],
    [Markup.button.callback('✅ Approve All Remaining', `rm_approve_all:${currency}`)],
    [Markup.button.callback('🔙 Back to Summary', `rm_summary:${currency}`)],
  ]);
}

const rateManagerScene = new Scenes.WizardScene(
  'rate_manager',

  // ── Step 0: Show current rates, pick currency ──────────────────────────
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();

    const rates = await getAllRates();
    const rateLines = rates.length
      ? rates.map(formatRate).join('\n')
      : '_No rates configured yet._';

    await ctx.reply(
      `💱 *Currency Rate Manager*\n\n*Current Rates:*\n${rateLines}\n\n` +
        `Which currency do you want to update?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          CURRENCIES.map((c) => Markup.button.callback(c, `rm_pick:${c}`)),
          [Markup.button.callback('❌ Cancel', 'rm_cancel')],
        ]),
      }
    );

    return ctx.wizard.next();
  },

  // ── Step 1: Waiting for currency pick (via action), then ask for rate ──
  async (ctx) => {
    if (!ctx.session.rm_currency) {
      return ctx.reply('Please pick a currency using the buttons above.');
    }
    const currency = ctx.session.rm_currency;
    await ctx.reply(
      `Enter the new rate for *${currency}*:\n_(How many MMK = 1 ${currency}? e.g. \`650\`)_`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // ── Step 2: Receive rate, compute impact, show summary ─────────────────
  async (ctx) => {
    if (!ctx.message?.text) return ctx.reply('Please send the rate as a number.');

    const raw = ctx.message.text.trim();
    const rate = parseFloat(raw);

    if (isNaN(rate) || rate <= 0) {
      return ctx.reply('❌ Invalid rate. Enter a positive number (e.g. 650).');
    }

    const currency = ctx.session.rm_currency;
    if (!currency) {
      await ctx.reply('Session expired. Start again with /managerates');
      return ctx.scene.leave();
    }

    const loadingMsg = await ctx.reply(`⏳ Calculating impact for ${currency} at ${rate} MMK...`);

    try {
      const { previews, affectedCount } = await updateRate(currency, rate);
      ctx.session.rm_previews = previews.map((p) => ({
        id: p.product._id.toString(),
        name: p.product.name,
        oldPrice: p.oldPrice,
        suggestedPrice: p.suggestedPrice,
        diff: p.diff,
      }));

      await auditLog(ctx.from.id, 'RATE_UPDATED', null, 'Currency', { currency, rate, affectedCount });

      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

      await ctx.reply(summaryText(currency, ctx.session.rm_previews), {
        parse_mode: 'Markdown',
        ...summaryKeyboard(currency, affectedCount > 0),
      });
    } catch (err) {
      console.error('[RateManager] Error:', err.message);
      await ctx.reply(`❌ Failed to update rate: ${err.message}`);
    }

    return ctx.scene.leave();
  }
);

// ── Action: currency picked from inline keyboard ───────────────────────────
rateManagerScene.action(/^rm_pick:(.+)$/, async (ctx) => {
  const currency = ctx.match[1];
  ctx.session.rm_currency = currency;
  await ctx.answerCbQuery(`${currency} selected`);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(
    `Enter the new rate for *${currency}*:\n_(How many MMK = 1 ${currency}? e.g. \`650\`)_`,
    { parse_mode: 'Markdown' }
  );
  ctx.wizard.next();
});

// ── Action: Approve All ────────────────────────────────────────────────────
rateManagerScene.action(/^rm_approve_all:(.+)$/, async (ctx) => {
  const currency = ctx.match[1];
  await ctx.answerCbQuery('Approving all suggested prices...');

  try {
    const count = await approveAllSuggestions(currency);
    await auditLog(ctx.from.id, 'APPROVE_ALL_PRICES', null, 'Product', { currency, count });
    await ctx.editMessageText(
      `✅ *${count} products updated!*\n\nFinal prices for *${currency}* products are now live.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Error approving: ${err.message}`);
  }

  ctx.session.rm_previews = null;
  ctx.session.rm_currency = null;
});

// ── Action: Manual Edit (paginated) ───────────────────────────────────────
rateManagerScene.action(/^rm_manual_edit:(.+):(\d+)$/, async (ctx) => {
  const currency = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  const previews = ctx.session.rm_previews || [];

  if (previews.length === 0) {
    await ctx.answerCbQuery('No pending suggestions');
    return;
  }

  const totalPages = Math.ceil(previews.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = previews.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const lines = slice
    .map(
      (p, i) =>
        `*${safePage * PAGE_SIZE + i + 1}.* ${p.name}\n` +
        `   Old: \`${p.oldPrice.toLocaleString()} KS\`  →  New: \`${p.suggestedPrice.toLocaleString()} KS\`  ${formatDiff(p.diff)}`
    )
    .join('\n\n');

  const firstItem = slice[0];

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🔍 *Manual Edit — Page ${safePage + 1}/${totalPages}*\n\n${lines}\n\n_Tap Approve or set a custom price for the first item shown:_`,
    {
      parse_mode: 'Markdown',
      ...itemKeyboard(firstItem.id, currency, safePage),
    }
  );
});

// ── Action: Approve single product ────────────────────────────────────────
rateManagerScene.action(/^rm_approve_one:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  try {
    const product = await approveSingleProduct(productId);
    await auditLog(ctx.from.id, 'APPROVE_SINGLE_PRICE', productId, 'Product', { finalPrice: product.finalPrice });
    await ctx.answerCbQuery(`✅ ${product.name} approved`);
    await ctx.reply(`✅ *${product.name}* — price set to \`${product.finalPrice.toLocaleString()} KS\``, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    await ctx.answerCbQuery('Error: ' + err.message, { show_alert: true });
  }
});

// ── Action: Set manual price (asks for input via force reply) ─────────────
rateManagerScene.action(/^rm_set_manual:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  ctx.session.rm_manual_product = productId;
  await ctx.answerCbQuery();
  await ctx.reply(
    `✏️ Enter the manual price in KS for this product:\n_(Type a number, e.g. \`3500\`)_`,
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
});

// ── Action: Cancel ────────────────────────────────────────────────────────
rateManagerScene.action('rm_cancel', async (ctx) => {
  ctx.session.rm_previews = null;
  ctx.session.rm_currency = null;
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Rate update cancelled. Old prices retained.');
  ctx.scene.leave();
});

// ── Action: Back to summary ───────────────────────────────────────────────
rateManagerScene.action(/^rm_summary:(.+)$/, async (ctx) => {
  const currency = ctx.match[1];
  const previews = ctx.session.rm_previews || [];
  await ctx.answerCbQuery();
  await ctx.editMessageText(summaryText(currency, previews), {
    parse_mode: 'Markdown',
    ...summaryKeyboard(currency, previews.length > 0),
  });
});

module.exports = rateManagerScene;
