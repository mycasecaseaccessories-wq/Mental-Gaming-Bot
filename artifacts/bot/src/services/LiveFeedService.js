/**
 * LiveFeedService
 * Sends "social proof" activity notifications to a configured Telegram channel.
 *
 * Events:
 *   postPurchase  — "User L***** just bought 1× Product Name 🎮"
 *   postTopup     — "User L***** just topped up X,XXX KS 💰"
 *   postGiveaway  — "User L***** just claimed Product Name (FREE 🎁)"
 */

const SystemStatus = require('../models/SystemStatus');

/** Masks a name: first char + '*****' regardless of length (privacy). */
function maskName(user) {
  const raw = user?.username || user?.firstName || user?.first_name || '?';
  const first = String(raw)[0] || '?';
  return `${first}*****`;
}

/**
 * Low-level send — fetches liveFeedChannelId from SystemStatus, sends message.
 * Silent on error (never crash callers).
 */
async function post(telegram, text, button = null) {
  try {
    const st = await SystemStatus.get();
    if (!st.liveFeedEnabled || !st.liveFeedChannelId) return;
    const extra = { parse_mode: 'Markdown' };
    if (button) {
      const { Markup } = require('telegraf');
      Object.assign(extra, Markup.inlineKeyboard([[
        Markup.button.url(button.label, button.url),
      ]]));
    }
    await telegram.sendMessage(st.liveFeedChannelId, text, extra);
  } catch (e) {
    // Non-critical — swallow silently
    console.error('[LiveFeed] send error:', e.message);
  }
}

/**
 * Order completed — "User X just bought 1× Product".
 * @param {object} telegram  — ctx.telegram or the Telegraf bot instance
 * @param {object} opts
 * @param {object} opts.user         — Mongoose User doc (has .username / .firstName)
 * @param {string} opts.productName
 * @param {number} [opts.qty=1]
 * @param {string} [opts.productEmoji='📦']
 */
async function postPurchase(telegram, { user, productName, qty = 1, productEmoji = '📦' }) {
  const name = maskName(user);
  const esc  = (s) => String(s).replace(/([_*`\[])/g, '\\$1');
  await post(
    telegram,
    `👤 *${esc(name)}* just bought *${qty}×* ${productEmoji} *${esc(productName)}*! 🎉`,
  );
}

/**
 * Top-up approved — "User X just topped up X KS".
 */
async function postTopup(telegram, { user, amount }) {
  const name = maskName(user);
  const esc  = (s) => String(s).replace(/([_*`\[])/g, '\\$1');
  await post(
    telegram,
    `💰 *${esc(name)}* just topped up *${Number(amount).toLocaleString()} KS*!`,
  );
}

/**
 * Giveaway claimed — "User X just claimed Product (FREE)".
 */
async function postGiveaway(telegram, { user, productName, productEmoji = '🎁' }) {
  const name = maskName(user);
  const esc  = (s) => String(s).replace(/([_*`\[])/g, '\\$1');
  await post(
    telegram,
    `🎁 *${esc(name)}* just claimed ${productEmoji} *${esc(productName)}* for FREE!`,
  );
}

module.exports = { postPurchase, postTopup, postGiveaway };
