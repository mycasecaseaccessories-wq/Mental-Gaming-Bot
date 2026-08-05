/**
 * Global History — Admin
 *
 * /globalhistory  — top-level menu
 *
 * Actions:
 *   gh_orders:page:status   — paginated all-orders list
 *   gh_topups:page:type     — paginated all-topups list
 *
 * status values : all | Pending | Processing | Success | Cancelled | Refunded
 * type values   : all | Topup | Purchase | Refund
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { price, formatDate } = require('../utils/ui');

const esc = (s) => String(s || '').replace(/([_*`\[\]()~>#+=|{}.!\\-])/g, '\\$1');

const ORDER_STATUSES = ['all', 'Pending', 'Processing', 'Success', 'Cancelled', 'Refunded'];
const TX_TYPES       = ['all', 'Topup', 'Purchase', 'Refund'];
const PAGE_SIZE      = 8;

// ── Status / type filter keyboard row ─────────────────────────────────────────
function orderFilterRow(currentStatus, page) {
  const labels = {
    all: '📋 All', Pending: '🟡 Pending', Processing: '🔵 In Progress',
    Success: '✅ Success', Cancelled: '❌ Cancelled', Refunded: '↩️ Refunded',
  };
  return ORDER_STATUSES.map((s) =>
    Markup.button.callback(
      (s === currentStatus ? '› ' : '') + (labels[s] || s),
      `gh_orders:1:${s}`
    )
  );
}

function topupFilterRow(currentType, page) {
  const labels = { all: '📋 All', Topup: '💰 Topup', Purchase: '📦 Purchase', Refund: '↩️ Refund' };
  return TX_TYPES.map((t) =>
    Markup.button.callback(
      (t === currentType ? '› ' : '') + (labels[t] || t),
      `gh_topups:1:${t}`
    )
  );
}

// ── Nav row helper ─────────────────────────────────────────────────────────────
function navRow(page, totalPages, prefix, extra) {
  const btns = [];
  if (page > 1)          btns.push(Markup.button.callback(`‹ ${page - 1}`, `${prefix}:${page - 1}:${extra}`));
  btns.push(Markup.button.callback(`${page}/${totalPages}`, 'gh_noop'));
  if (page < totalPages) btns.push(Markup.button.callback(`${page + 1} ›`, `${prefix}:${page + 1}:${extra}`));
  return btns;
}

// ── Orders list ────────────────────────────────────────────────────────────────
async function renderOrders(ctx, page, status, edit = false) {
  const Order   = require('../models/Order');
  const filter  = status === 'all' ? {} : { status };
  const skip    = (page - 1) * PAGE_SIZE;

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .populate('userId', 'username telegramId')
      .populate('productId', 'name'),
    Order.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const statusIcon = { Pending: '🟡', Processing: '🔵', Success: '✅', Cancelled: '❌', Refunded: '↩️' };

  const lines = orders.length
    ? orders.map((o) => {
        const icon    = statusIcon[o.status] || '❓';
        const user    = o.userId?.username
          ? `@${esc(o.userId.username)}`
          : o.userId?.telegramId ? `\`${o.userId.telegramId}\`` : `_unknown_`;
        const product = esc(o.productId?.name || 'Product');
        const date    = formatDate(o.timestamp || o.createdAt);
        return `${icon} \`#${o.orderId}\` ${product}\n     👤 ${user} — ${price(o.amount || 0)} — ${date}`;
      }).join('\n')
    : `_ဤ filter တွင် order မရှိပါ_`;

  const filterLabel = status === 'all' ? 'All' : status;
  const header =
    `📦 *Global Orders* — ${filterLabel} (${total})\n` +
    `Page ${page}/${totalPages}\n` +
    `──────────────────\n${lines}`;

  const keyboard = Markup.inlineKeyboard([
    orderFilterRow(status, page),
    navRow(page, totalPages, 'gh_orders', status),
    [Markup.button.callback('🔙 History Menu', 'gh_menu')],
  ]);

  if (edit) {
    return ctx.editMessageText(header, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
  }
  return ctx.reply(header, { parse_mode: 'Markdown', ...keyboard })
    .catch(() => ctx.reply(`Global Orders (${total}) p${page}/${totalPages}`, keyboard));
}

// ── Topups / wallet transactions list ─────────────────────────────────────────
async function renderTopups(ctx, page, type, edit = false) {
  const Transaction = require('../models/Transaction');
  const User        = require('../models/User');
  const filter      = type === 'all' ? {} : { type };
  const skip        = (page - 1) * PAGE_SIZE;

  const [txs, total] = await Promise.all([
    Transaction.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(PAGE_SIZE),
    Transaction.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  // Bulk-resolve users for display
  const userIds = [...new Set(txs.map((t) => t.userId?.toString()).filter(Boolean))];
  const users   = await User.find({ _id: { $in: userIds } }).select('telegramId username');
  const userMap = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

  const statusIcon = { Completed: '✅', Pending: '⏳', Rejected: '❌' };

  const lines = txs.length
    ? txs.map((t) => {
        const icon   = statusIcon[t.status] || '❓';
        const u      = userMap[t.userId?.toString()];
        const tag    = u?.username ? `@${esc(u.username)}` : u ? `\`${u.telegramId}\`` : `_unknown_`;
        const sign   = t.amount > 0 ? '+' : '';
        const method = t.paymentMethod ? ` _(${esc(t.paymentMethod)})_` : '';
        const date   = formatDate(t.timestamp);
        return `${icon} *${esc(t.type)}*${method} ${sign}${(t.amount || 0).toLocaleString()} ${t.wallet}\n     👤 ${tag} — ${t.status} — ${date}`;
      }).join('\n')
    : `_ဤ filter တွင် transaction မရှိပါ_`;

  const filterLabel = type === 'all' ? 'All' : type;
  const header =
    `💰 *Global Wallet History* — ${filterLabel} (${total})\n` +
    `Page ${page}/${totalPages}\n` +
    `──────────────────\n${lines}`;

  const keyboard = Markup.inlineKeyboard([
    topupFilterRow(type, page),
    navRow(page, totalPages, 'gh_topups', type),
    [Markup.button.callback('🔙 History Menu', 'gh_menu')],
  ]);

  if (edit) {
    return ctx.editMessageText(header, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
  }
  return ctx.reply(header, { parse_mode: 'Markdown', ...keyboard })
    .catch(() => ctx.reply(`Global Wallet History (${total}) p${page}/${totalPages}`, keyboard));
}

// ── Menu ───────────────────────────────────────────────────────────────────────
function sendMenu(ctx, edit = false) {
  const text =
    `📋 *Global History*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `ကြည့်ချင်တာ ရွေးပါ 👇`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 All Orders',        'gh_orders:1:all')],
    [Markup.button.callback('💰 All Topups / Wallet', 'gh_topups:1:all')],
  ]);

  if (edit) {
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
  }
  return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

module.exports = function registerGlobalHistory(bot) {

  bot.command('globalhistory', adminOnly(), async (ctx) => {
    await sendMenu(ctx, false);
  });

  bot.hears('📜 Global History', adminOnly(), async (ctx) => {
    await sendMenu(ctx, false);
  });

  bot.action('gh_menu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendMenu(ctx, true);
  });

  bot.action('gh_noop', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
  });

  // gh_orders:page:status
  bot.action(/^gh_orders:(\d+):(\w+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const page   = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    const status = ORDER_STATUSES.includes(ctx.match[2]) ? ctx.match[2] : 'all';
    await renderOrders(ctx, page, status, true);
  });

  // gh_topups:page:type
  bot.action(/^gh_topups:(\d+):(\w+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const page = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    const type = TX_TYPES.includes(ctx.match[2]) ? ctx.match[2] : 'all';
    await renderTopups(ctx, page, type, true);
  });

  // Dashboard shortcut actions
  bot.action('global_history_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendMenu(ctx, false);
  });

  bot.action('banned_users_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    // Delegate to the /bannedusers flow — re-use by replying the same message
    await ctx.reply('_Redirecting…_', { parse_mode: 'Markdown' }).catch(() => {});
    ctx.message = { text: '/bannedusers', chat: ctx.chat };
    // Trigger command directly
    const { listBannedUsers } = require('../services/UserManagementService');
    const { users, total, totalPages } = await listBannedUsers({ page: 1, limit: 8 });
    if (!total) {
      return ctx.reply('✅ Banned user မရှိပါ။ အားလုံး active ဖြစ်နေပါသည်။');
    }
    const rows = users.map((u) => {
      const name  = u.username ? `@${u.username}` : (u.first_name || `ID:${u.telegramId}`);
      const label = `🚫 ${name.slice(0, 22)} — ⚠️${u.warningsCount || 0}`;
      return [
        Markup.button.callback(label, `um_view:${u.telegramId}`),
        Markup.button.callback('🔓 Unban', `bans_unban:${u.telegramId}`),
      ];
    });
    const navBtns = [];
    if (totalPages > 1) navBtns.push(Markup.button.callback('2 ›', 'bans_page:2'));
    const keyboard = Markup.inlineKeyboard([...rows, ...(navBtns.length ? [navBtns] : [])]);
    return ctx.reply(
      `🚫 *Banned Users (${total} ဦး)* — Page 1/${totalPages}\n\n_ကြည့်ရန် နာမည်နှိပ်၊ ဖြုတ်ရန် 🔓 နှိပ်ပါ_`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
};
