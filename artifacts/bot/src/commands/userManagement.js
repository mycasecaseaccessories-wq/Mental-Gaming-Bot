/**
 * User Management Commands (Admin only)
 *
 * /ban /unban /warn /unwarn /restrict /unrestrict /userinfo /users /adjustbal
 *
 * Target resolution:
 *   • Reply to a message → use that sender's ID
 *   • Argument → @username or numeric Telegram ID
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const {
  warnUser, unwarnUser, banUser, unbanUser, bulkUnbanUsers,
  restrictUser, unrestrictUser,
  getUserInfo, listUsers, listBannedUsers, searchUsers,
  adjustBalance, resolveUser, ALL_RIGHTS,
} = require('../services/UserManagementService');
const { issueWarning, getUserLog } = require('../services/PenaltyService');
const { auditLog } = require('../services/logger');
const { price, formatDate } = require('../utils/ui');
const { getTheme } = require('../services/ThemeService');
const { checklist } = require('../utils/animations');

const esc = (s) => String(s || '').replace(/([_*`\[\]()~>#+=|{}.!\\-])/g, '\\$1');

// ── Per-user tappable buttons for list pages ─────────────────────────────────
function userListButtons(users) {
  return users.map((u) => {
    const name = u.first_name || (u.username ? `@${u.username}` : `ID:${u.telegramId}`);
    const label = `${u.isBlocked ? '🚫' : '👤'} ${name}`.slice(0, 40) + ` — ${(u.balanceKS || 0).toLocaleString()} KS`;
    return [Markup.button.callback(label, `um_view:${u.telegramId}`)];
  });
}

// ── Resolve target from ctx (reply or args) ───────────────────────────────────
function parseTarget(ctx) {
  if (ctx.message?.reply_to_message?.from) {
    const from = ctx.message.reply_to_message.from;
    return { identifier: from.id, display: from.username ? `@${from.username}` : `ID:${from.id}` };
  }
  const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
  if (!args.length) return null;
  return { identifier: args[0].replace(/^@/, ''), display: args[0], args: args.slice(1) };
}

// ── Compact activity snapshot lines ──────────────────────────────────────────
function recentOrderLines(orders) {
  if (!orders || !orders.length) return '_ဝယ်ထားသည့် ရာဇဝင် မရှိသေးပါ_';
  return orders.map((o) => {
    const icon = o.status === 'Success' ? '✅' : o.status === 'Pending' ? '🟡'
      : o.status === 'Processing' ? '🔵' : o.status === 'Cancelled' ? '❌' : '↩️';
    const prod = (o.productId?.name || 'Product').slice(0, 20);
    return `${icon} \`#${o.orderId || '?'}\` ${esc(prod)} — *${price(o.amount || 0)}*`;
  }).join('\n');
}

function recentTopupLines(txs) {
  if (!txs || !txs.length) return '_Topup ရာဇဝင် မရှိသေးပါ_';
  return txs.map((t) => {
    const icon = t.status === 'Completed' ? '✅' : t.status === 'Pending' ? '⏳' : '❌';
    const by = t.processedBy ? ` _(by ${esc(String(t.processedBy))})_` : '';
    return `${icon} *+${price(t.amount || 0)}* ${esc(t.paymentMethod || '')}${by} — ${formatDate(t.timestamp || t.createdAt)}`;
  }).join('\n');
}

// ── Build user info card ──────────────────────────────────────────────────────
async function buildUserCard(ctx, identifier) {
  const info = await getUserInfo(identifier);
  if (!info) return null;

  const { user, orderCount, pendingOrders, totalSpent, hasPendingTopup, recentOrders, recentTopups } = info;
  const statusIcon = user.isBlocked ? '🚫 Banned' : '🟢 Active';
  const tag = user.username ? `@${user.username}` : `_(no username)_`;

  const text =
    `👤 *User Info*\n` +
    `──────────────────\n` +
    `🆔 ID: \`${user.telegramId}\`\n` +
    `${tag}\n` +
    `──────────────────\n` +
    `⭐ Tier: *${user.membershipTier || 'Standard'}*\n` +
    `💰 KS Balance: *${price(user.balanceKS || 0)}*\n` +
    `🪙 Coins: *${(user.balanceCoin || 0).toLocaleString()} MC*\n` +
    `💼 Total Deposited: *${price(user.totalDeposited || 0)}*\n` +
    `──────────────────\n` +
    `📦 Orders: ${orderCount}  |  🟡 Pending: ${pendingOrders}\n` +
    `💸 Total Spent: *${price(totalSpent)}*\n` +
    `💳 Pending Topup: ${hasPendingTopup ? '⏳ Yes' : 'None'}\n` +
    `──────────────────\n` +
    `⚠️ Warnings: *${user.warningsCount || 0}/3*\n` +
    `🔒 Restrictions: ${user.restrictedRights?.length ? user.restrictedRights.join(', ') : 'None'}\n` +
    `📊 Status: ${statusIcon}\n` +
    `📅 Joined: ${formatDate(user.joinDate || user.createdAt)}\n` +
    `🕐 Last Active: ${formatDate(user.lastActive)}\n` +
    `──────────────────\n` +
    `📦 *Recent Orders*\n${recentOrderLines(recentOrders)}\n` +
    `──────────────────\n` +
    `💳 *Recent Topups*\n${recentTopupLines(recentTopups)}`;

  const uid = user.telegramId;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('⚠️ Warn',   `um_warn:${uid}`),
      Markup.button.callback('✅ Unwarn',  `um_unwarn:${uid}`),
    ],
    [
      Markup.button.callback(user.isBlocked ? '✅ Unban' : '🚫 Ban', user.isBlocked ? `um_unban:${uid}` : `um_ban:${uid}`),
    ],
    [
      Markup.button.callback('🔒 Restrict Order',  `um_restrict:${uid}:order`),
      Markup.button.callback('🔒 Restrict Topup',  `um_restrict:${uid}:topup`),
    ],
    [
      Markup.button.callback('🔓 Remove All Restrictions', `um_unrestrict:${uid}:all`),
    ],
    [
      Markup.button.callback('💳 Adjust Balance', `um_adjust:${uid}`),
    ],
    [
      Markup.button.callback('📦 All Orders',      `um_orders:${uid}:1`),
      Markup.button.callback('💰 All Topups',      `um_txs:${uid}:1`),
    ],
    ...(hasPendingTopup
      ? [[Markup.button.callback('⏳ Pending Topup စစ်ရန်', `um_ptopup:${uid}`)]]
      : []),
  ]);

  return { text, keyboard, user };
}

const PAGE_SIZE_ORDERS = 8;
const PAGE_SIZE_TXS    = 8;

module.exports = function registerUserManagement(bot) {

  // ── 👥 Manage Users button — hub menu ─────────────────────────────────────
  bot.hears('👥 Manage Users', adminOnly(), async (ctx) => {
    await ctx.reply(
      `👥 *User Management*\n\n` +
      `🔍 ID/Username နဲ့ ရှာ သို့မဟုတ် စာရင်းကြည့်ပါ 👇`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔍 Search User',  'um_search_prompt'),
            Markup.button.callback('📋 All Users',     'um_list:1'),
          ],
          [
            Markup.button.callback('🚫 Banned Users', 'um_banned:1'),
            Markup.button.callback('🆕 Recently Joined', 'um_recent:1'),
          ],
        ]),
      }
    );
  });

  // ── Hub paginators ─────────────────────────────────────────────────────────
  bot.action(/^um_list:(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const page = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    let { users, total, totalPages } = await listUsers({ page, limit: 10 });
    if (!total) return ctx.reply('👥 User မရှိသေးပါ။');
    if (page > totalPages) ({ users, total, totalPages } = await listUsers({ page: totalPages, limit: 10 }));

    const navBtns = [];
    if (page > 1) navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `um_list:${page - 1}`));
    navBtns.push(Markup.button.callback(`${page}/${totalPages}`, 'um_noop'));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `um_list:${page + 1}`));

    const fn = ctx.callbackQuery?.message ? 'editMessageText' : 'reply';
    await ctx[fn](
      `👥 *Users (${total} total)* — Page ${page}/${totalPages}\n\n_User တစ်ယောက်ချင်း ကြည့်ရန် နှိပ်ပါ_ 👇`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...userListButtons(users), navBtns]) }
    ).catch(() => {});
  });

  bot.action(/^um_banned:(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const page = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    await sendBannedList(ctx, page, !!ctx.callbackQuery?.message);
  });

  bot.action(/^um_recent:(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const page = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    const { users, total, totalPages } = await listUsers({ page, limit: 10, filter: {} });
    if (!total) return ctx.reply('👥 User မရှိသေးပါ။');

    const navBtns = [];
    if (page > 1) navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `um_recent:${page - 1}`));
    navBtns.push(Markup.button.callback(`${page}/${totalPages}`, 'um_noop'));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `um_recent:${page + 1}`));

    const fn = ctx.callbackQuery?.message ? 'editMessageText' : 'reply';
    await ctx[fn](
      `🆕 *Recently Joined (${total} total)* — Page ${page}/${totalPages}\n\n_User တစ်ယောက်ချင်း ကြည့်ရန် နှိပ်ပါ_ 👇`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...userListButtons(users), navBtns]) }
    ).catch(() => {});
  });

  bot.action('um_noop', adminOnly(), async (ctx) => ctx.answerCbQuery());

  // ── Search prompt ──────────────────────────────────────────────────────────
  bot.action('um_search_prompt', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.umSearchPending = true;
    await ctx.reply(
      `🔍 *User ရှာပါ*\n\nTelegram ID (နံပါတ်) သို့မဟုတ် @username ရိုက်ပေးပါ:`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── /userinfo ─────────────────────────────────────────────────────────────
  bot.command('userinfo', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /userinfo @username or reply to a message\nOr: /userinfo 123456789');

    const result = await buildUserCard(ctx, target.identifier);
    if (!result) return ctx.reply(`❌ User not found: ${target.display}`);

    await ctx.reply(result.text, { parse_mode: 'Markdown', ...result.keyboard });
  });

  // ── /users (paginated list) ────────────────────────────────────────────────
  bot.command('users', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const query = args[0];

    if (query) {
      const found = await searchUsers(query);
      if (!found.length) return ctx.reply(`❌ No users found matching: ${esc(query)}`);
      return ctx.reply(
        `🔍 *Search: "${esc(query)}"* (${found.length} found)\n\n_User တစ်ယောက်ချင်း အသေးစိတ်ကြည့်ရန် နှိပ်ပါ_ 👇`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(userListButtons(found)) }
      ).catch(() => ctx.reply(
        `Search: ${query} (${found.length} found) — user ကို နှိပ်ပါ 👇`,
        Markup.inlineKeyboard(userListButtons(found))
      ));
    }

    const { users, total, totalPages } = await listUsers({ page: 1, limit: 10 });
    if (!total) return ctx.reply('👥 User မရှိသေးပါ။');
    const navBtns = [];
    if (totalPages > 1) navBtns.push(Markup.button.callback(`Page 1/${totalPages} ›`, 'users_page:2'));

    await ctx.reply(
      `👥 *Users (${total} total)* — Page 1/${totalPages}\n\n_User တစ်ယောက်ချင်း အသေးစိတ်ကြည့်ရန် နှိပ်ပါ_ 👇`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([...userListButtons(users), ...(navBtns.length ? [navBtns] : [])]),
      }
    ).catch(() => ctx.reply(
      `Users (${total} total) — user ကို နှိပ်ပါ 👇`,
      Markup.inlineKeyboard([...userListButtons(users), ...(navBtns.length ? [navBtns] : [])])
    ));
  });

  bot.action(/^users_page:(\d+)$/, adminOnly(), async (ctx) => {
    let page = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    await ctx.answerCbQuery();
    let { users, total, totalPages } = await listUsers({ page, limit: 10 });
    if (!total) return ctx.reply('👥 User မရှိသေးပါ။');
    if (page > totalPages) {
      page = totalPages;
      ({ users, total, totalPages } = await listUsers({ page, limit: 10 }));
    }
    const navBtns = [];
    if (page > 1) navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `users_page:${page - 1}`));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `users_page:${page + 1}`));

    await ctx.editMessageText(
      `👥 *Users (${total} total)* — Page ${page}/${totalPages}\n\n_User တစ်ယောက်ချင်း အသေးစိတ်ကြည့်ရန် နှိပ်ပါ_ 👇`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...userListButtons(users), ...(navBtns.length ? [navBtns] : [])]) }
    ).catch(() => {});
  });

  // ── um_view — open full user card from list button ─────────────────────────
  bot.action(/^um_view:(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const result = await buildUserCard(ctx, ctx.match[1]);
    if (!result) return ctx.reply('❌ User not found.');
    await ctx.reply(result.text, { parse_mode: 'Markdown', ...result.keyboard })
      .catch(() => ctx.reply(result.text.replace(/[*_`]/g, ''), result.keyboard));
  });

  // ── um_orders — user's purchase history (paginated) ────────────────────────
  bot.action(/^um_orders:(\d+)(?::(\d+))?$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const uid  = ctx.match[1];
    const page = Math.max(1, parseInt(ctx.match[2] || '1', 10));
    const user = await resolveUser(uid);
    if (!user) return ctx.reply('❌ User not found.');

    const Order = require('../models/Order');
    const skip  = (page - 1) * PAGE_SIZE_ORDERS;
    const total = await Order.countDocuments({ userId: user._id });
    const totalPages = Math.ceil(total / PAGE_SIZE_ORDERS) || 1;
    const orders = await Order.find({ userId: user._id })
      .sort({ timestamp: -1, createdAt: -1 })
      .skip(skip)
      .limit(PAGE_SIZE_ORDERS)
      .populate('productId', 'name')
      .lean();

    const tag = user.username ? `@${esc(user.username)}` : `\`${user.telegramId}\``;
    const lines = orders.length
      ? orders.map((o) => {
          const icon = o.status === 'Success' ? '✅' : o.status === 'Pending' ? '🟡'
            : o.status === 'Processing' ? '🔵' : o.status === 'Cancelled' ? '❌' : '↩️';
          // who processed this order (last statusHistory entry with an actor)
          const lastChange = (o.statusHistory || []).slice().reverse()
            .find((h) => h.changedBy || h.by);
          const byLine = lastChange
            ? ` _(${esc(String(lastChange.changedBy || lastChange.by))})_`
            : '';
          return (
            `${icon} \`#${o.orderId || '?'}\` ${esc((o.productId?.name || 'Product').slice(0, 18))}\n` +
            `     💸 ${price(o.amount || 0)} — *${o.status}*${byLine}\n` +
            `     🕐 ${formatDate(o.timestamp || o.createdAt)}`
          );
        }).join('\n')
      : '_ဝယ်ထားသည့် ရာဇဝင် မရှိသေးပါ_';

    const navBtns = [];
    if (page > 1)         navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `um_orders:${uid}:${page - 1}`));
    navBtns.push(Markup.button.callback(`${page}/${totalPages}`, 'um_noop'));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `um_orders:${uid}:${page + 1}`));

    const kb = Markup.inlineKeyboard([
      navBtns,
      [Markup.button.callback('🔙 User Card', `um_view:${uid}`)],
    ]);
    const header = `📦 *Orders — ${tag}* (${total} ခု) — Page ${page}/${totalPages}\n──────────────────\n${lines}`;

    const fn = ctx.callbackQuery?.message ? 'editMessageText' : 'reply';
    await ctx[fn](header, { parse_mode: 'Markdown', ...kb })
      .catch(() => ctx.reply(header.replace(/[*_`\\]/g, ''), kb));
  });

  // ── um_txs — user's wallet/topup history (paginated) ──────────────────────
  bot.action(/^um_txs:(\d+)(?::(\d+))?$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const uid  = ctx.match[1];
    const page = Math.max(1, parseInt(ctx.match[2] || '1', 10));
    const user = await resolveUser(uid);
    if (!user) return ctx.reply('❌ User not found.');

    const Transaction = require('../models/Transaction');
    const skip         = (page - 1) * PAGE_SIZE_TXS;
    const total        = await Transaction.countDocuments({ userId: user._id });
    const totalPages   = Math.ceil(total / PAGE_SIZE_TXS) || 1;
    const pendingCount = await Transaction.countDocuments({ userId: user._id, type: 'Topup', status: 'Pending' });
    const txs = await Transaction.find({ userId: user._id })
      .sort({ timestamp: -1, createdAt: -1 })
      .skip(skip)
      .limit(PAGE_SIZE_TXS)
      .lean();

    const tag = user.username ? `@${esc(user.username)}` : `\`${user.telegramId}\``;
    const lines = txs.length
      ? txs.map((t) => {
          const icon   = t.status === 'Completed' ? '✅' : t.status === 'Pending' ? '⏳' : '❌';
          const sign   = (t.amount || 0) >= 0 ? '+' : '';
          const method = t.paymentMethod ? ` (${esc(t.paymentMethod)})` : '';
          const byLine = t.processedBy ? ` _(by ${esc(String(t.processedBy))})_` : '';
          return (
            `${icon} *${esc(t.type)}*${method} ${sign}${(t.amount || 0).toLocaleString()} ${t.wallet || 'KS'}\n` +
            `     *${t.status}*${byLine} — ${formatDate(t.timestamp || t.createdAt)}`
          );
        }).join('\n')
      : '_Transaction မရှိသေးပါ_';

    const pendingNote = pendingCount
      ? `\n\n⚠️ *Pending topup ${pendingCount} ခု ရှိနေသည်*`
      : '';

    const navBtns = [];
    if (page > 1)         navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `um_txs:${uid}:${page - 1}`));
    navBtns.push(Markup.button.callback(`${page}/${totalPages}`, 'um_noop'));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `um_txs:${uid}:${page + 1}`));

    const kbRows = [navBtns];
    if (pendingCount) kbRows.push([Markup.button.callback('⏳ Pending Topup စစ်ရန်', `um_ptopup:${uid}`)]);
    kbRows.push([Markup.button.callback('🔙 User Card', `um_view:${uid}`)]);

    const header =
      `💰 *Wallet History — ${tag}* (${total} ခု) — Page ${page}/${totalPages}\n` +
      `💵 လက်ကျန်: *${price(user.balanceKS || 0)}* | 🪙 ${(user.balanceCoin || 0).toLocaleString()} MC\n` +
      `💼 စုစုပေါင်း ငွေဖြည့်ပြီး: *${price(user.totalDeposited || 0)}*\n` +
      `──────────────────\n${lines}${pendingNote}`;

    const fn = ctx.callbackQuery?.message ? 'editMessageText' : 'reply';
    await ctx[fn](header, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kbRows) })
      .catch(() => ctx.reply(header.replace(/[*_`\\]/g, ''), Markup.inlineKeyboard(kbRows)));
  });

  // ── um_ptopup — this user's pending topups w/ approve buttons ──────────────
  bot.action(/^um_ptopup:(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const uid = ctx.match[1];
    const user = await resolveUser(uid);
    if (!user) return ctx.reply('❌ User not found.');

    const Transaction = require('../models/Transaction');
    const pending = await Transaction.find({ userId: user._id, type: 'Topup', status: 'Pending' })
      .sort({ createdAt: 1 }).limit(5);

    if (!pending.length) {
      return ctx.reply('✅ ဒီ user မှာ pending topup မရှိပါ — အားလုံး စစ်ပြီးသားပါ။',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 User Card', `um_view:${uid}`)]]));
    }

    const tag = user.username ? `@${esc(user.username)}` : `\`${user.telegramId}\``;
    for (const tx of pending) {
      const caption =
        `⏳ *Pending Topup*\n` +
        `──────────────────\n` +
        `👤 ${tag}\n` +
        `💵 ${price(tx.amount || 0)}\n` +
        `🏦 ${esc(tx.paymentMethod || '—')}\n` +
        `🧾 \`${tx.txId}\`\n` +
        `🕐 ${formatDate(tx.createdAt || tx.timestamp)}`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', `topup_approve:${tx.txId}`)],
        [Markup.button.callback('❌ Reject', `topup_reject:${tx.txId}`)],
        [Markup.button.callback('💬 Ask for Info', `topup_askinfo:${tx.txId}`)],
      ]);
      const { sendScreenshot } = require('../services/ScreenshotService');
      const sent = await sendScreenshot(ctx.telegram, ctx.chat.id, tx, {
        caption, parse_mode: 'Markdown', ...kb,
      });
      if (!sent) {
        await ctx.reply(`${caption}\n\n_(screenshot ပြလို့ မရပါ)_`, { parse_mode: 'Markdown', ...kb })
          .catch(() => ctx.reply(caption.replace(/[*_`\\]/g, ''), kb));
      }
    }
  });

  // ── /ban ──────────────────────────────────────────────────────────────────
  bot.command('ban', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /ban @username reason\nOr reply to a user\'s message + /ban reason');

    const reason = target.args?.join(' ') || 'No reason given';
    try {
      const user = await banUser(target.identifier, ctx.from.id, reason);
      await ctx.reply(
        `🚫 *User Banned*\n\n🆔 \`${user.telegramId}\`\n📝 Reason: ${reason}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.telegram.sendMessage(user.telegramId,
        `🚫 *You have been banned from Mental Gaming Store.*\n\n📝 Reason: ${reason}\n_Contact support to appeal._`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /unban ────────────────────────────────────────────────────────────────
  bot.command('unban', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /unban @username or /unban 123456789');
    try {
      const user = await unbanUser(target.identifier, ctx.from.id);
      await ctx.reply(`✅ *User Unbanned*\n\n🆔 \`${user.telegramId}\``, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(user.telegramId,
        `✅ *Your ban has been lifted.*\nYou can now use Mental Gaming Store again. Welcome back! 🎮`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /warn ─────────────────────────────────────────────────────────────────
  bot.command('warn', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /warn @username reason\nOr reply to a message + /warn reason');

    const reason = target.args?.join(' ') || 'No reason given';
    try {
      const { user, autoBanned } = await warnUser(target.identifier, ctx.from.id, reason);
      const statusLine = autoBanned ? '\n🚫 *Auto-banned* (3 warnings reached)' : '';

      await ctx.reply(
        `⚠️ *Warning Issued*\n\n🆔 \`${user.telegramId}\`\n⚠️ Warnings: *${user.warningsCount}/3*\n📝 Reason: ${reason}${statusLine}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.telegram.sendMessage(user.telegramId,
        `⚠️ *You have received a warning.*\n\n📝 Reason: ${reason}\n⚠️ Total Warnings: *${user.warningsCount}/3*\n${autoBanned ? '\n🚫 You have been *banned* due to 3 warnings.' : `_${3 - user.warningsCount} more warning(s) will result in a ban._`}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /unwarn ───────────────────────────────────────────────────────────────
  bot.command('unwarn', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /unwarn @username');
    try {
      const user = await unwarnUser(target.identifier, ctx.from.id);
      await ctx.reply(
        `✅ *Warning Removed*\n\n🆔 \`${user.telegramId}\`\n⚠️ Warnings now: *${user.warningsCount}/3*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /restrict ─────────────────────────────────────────────────────────────
  bot.command('restrict', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      return ctx.reply(
        `Usage: /restrict @username <rights>\nRights: ${ALL_RIGHTS.join(', ')}\nExample: /restrict @user order topup`
      );
    }
    const identifier = args[0].replace(/^@/, '');
    const rights = args.slice(1);
    try {
      const { user, restricted } = await restrictUser(identifier, ctx.from.id, rights);
      await ctx.reply(
        `🔒 *User Restricted*\n\n🆔 \`${user.telegramId}\`\n🔒 Restricted: ${restricted.join(', ')}\n📋 All restrictions: ${user.restrictedRights.join(', ') || 'None'}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.telegram.sendMessage(user.telegramId,
        `🔒 *Your account has been restricted.*\n\nRestricted actions: ${restricted.join(', ')}\n_Contact /support if you have questions._`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /unrestrict ───────────────────────────────────────────────────────────
  bot.command('unrestrict', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) return ctx.reply('Usage: /unrestrict @username [right1 right2...]\nNo rights = remove all restrictions');
    const identifier = args[0].replace(/^@/, '');
    const rights = args.slice(1);
    try {
      const user = await unrestrictUser(identifier, ctx.from.id, rights);
      await ctx.reply(
        `🔓 *Restrictions Removed*\n\n🆔 \`${user.telegramId}\`\n📋 Remaining: ${user.restrictedRights.join(', ') || 'None'}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /adjustbal ────────────────────────────────────────────────────────────
  bot.command('adjustbal', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      return ctx.reply('Usage: /adjustbal @username +5000\nOr: /adjustbal @username -2000 note here');
    }
    const identifier = args[0].replace(/^@/, '');
    const amount = parseInt(args[1].replace(/[^-\d]/g, ''), 10);
    const note = args.slice(2).join(' ') || 'Admin adjustment';

    if (isNaN(amount) || amount === 0) return ctx.reply('❌ Invalid amount. Use +5000 or -2000.');

    try {
      const { user } = await adjustBalance(identifier, ctx.from.id, amount, note);
      const sign = amount > 0 ? '+' : '';
      await ctx.reply(
        `💳 *Balance Adjusted*\n\n🆔 \`${user.telegramId}\`\n${sign}${amount.toLocaleString()} KS\n💰 New Balance: *${price(user.balanceKS)}*\n📝 Note: ${note}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.telegram.sendMessage(user.telegramId,
        `💳 *Wallet Update*\n\n${sign}${amount.toLocaleString()} KS has been ${amount > 0 ? 'added to' : 'deducted from'} your wallet.\n💰 New Balance: *${price(user.balanceKS)}*`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Inline action handlers ─────────────────────────────────────────────────
  bot.action(/^um_warn:(\d+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.umPendingAction = { type: 'warn', uid };
    await ctx.reply(`⚠️ Warn user \`${uid}\` — send the reason:`, { parse_mode: 'Markdown', ...Markup.forceReply() });
  });

  bot.action(/^um_unwarn:(\d+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    await ctx.answerCbQuery('Removing warning...');
    try {
      const user = await unwarnUser(uid, ctx.from.id);
      await ctx.reply(`✅ Warning removed. Now: ${user.warningsCount}/3`);
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.action(/^um_ban:(\d+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.umPendingAction = { type: 'ban', uid };
    await ctx.reply(`🚫 Ban user \`${uid}\` — send the reason:`, { parse_mode: 'Markdown', ...Markup.forceReply() });
  });

  bot.action(/^um_unban:(\d+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    await ctx.answerCbQuery('Unbanning...');
    try {
      const user = await unbanUser(uid, ctx.from.id);
      await ctx.reply(`✅ User \`${user.telegramId}\` unbanned.`, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(user.telegramId, '✅ Your ban has been lifted. Welcome back! 🎮').catch(() => {});
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.action(/^um_restrict:(\d+):(.+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    const right = ctx.match[2];
    await ctx.answerCbQuery(`Restricting: ${right}`);
    try {
      const { user } = await restrictUser(uid, ctx.from.id, [right]);
      await ctx.reply(`🔒 \`${uid}\` restricted from: *${right}*`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.action(/^um_unrestrict:(\d+):(.+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    const rights = ctx.match[2] === 'all' ? [] : [ctx.match[2]];
    await ctx.answerCbQuery('Removing restrictions...');
    try {
      const user = await unrestrictUser(uid, ctx.from.id, rights);
      await ctx.reply(`🔓 \`${uid}\` — restrictions cleared.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.action(/^um_adjust:(\d+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.umPendingAction = { type: 'adjust', uid };
    await ctx.reply(
      `💳 Adjust balance for \`${uid}\`\nSend amount with sign (e.g. \`+5000\` or \`-2000\`):`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── /penalize — smart warning with auto time-restriction + coin penalty ───
  bot.command('penalize', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply(
      'Usage: /penalize @username reason\nOr reply to a user\'s message + /penalize reason\n\n' +
      'Effects:\n  1st: 3-day Spin+CheckIn ban\n  2nd: 7-day all-rewards ban + 10% coin penalty\n  3rd: Permanent ban'
    );

    const reason = target.args?.join(' ') || 'Admin penalty';
    try {
      const result = await issueWarning(target.identifier, ctx.from.id, reason, ctx.telegram);
      const { user, autoBanned, level, coinPenalty, expiresAt } = result;

      const durationText = expiresAt
        ? `until *${expiresAt.toLocaleDateString('en-GB')}*`
        : autoBanned ? '🚫 *Permanently Banned*' : '';

      const penaltyLine = coinPenalty > 0 ? `\n🪙 Coin Penalty: *-${coinPenalty.toLocaleString()} MC*` : '';

      await ctx.reply(
        `⚠️ *Penalty Issued (Warning ${level}/3)*\n\n` +
        `🆔 \`${user.telegramId}\`\n` +
        `📝 Reason: ${reason}${penaltyLine}\n` +
        `⏳ Restricted: ${durationText}\n` +
        `🔒 Rights removed: ${user.restrictedRights.join(', ') || 'none'}\n` +
        (autoBanned ? '\n🚫 *Auto-banned after 3 warnings.*' : ''),
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /userlog — full activity log for a user ────────────────────────────────
  bot.command('userlog', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /userlog @username\nOr reply to a user\'s message');

    const info = await getUserInfo(target.identifier);
    if (!info) return ctx.reply(`❌ User not found: ${target.display}`);

    const log = await getUserLog(info.user.telegramId);
    if (!log) return ctx.reply('❌ Could not load log.');

    const { user, orders, transactions, tickets } = log;
    const tag = user.username ? `@${user.username}` : `ID:${user.telegramId}`;

    const orderLines = orders.length
      ? orders.map((o) => `  • #${o.orderId} — ${o.productId?.name || 'Product'} — ${o.status}`).join('\n')
      : '  None';

    const txLines = transactions.length
      ? transactions.map((t) =>
          `  • ${t.type} ${t.amount > 0 ? '+' : ''}${t.amount.toLocaleString()} ${t.wallet} — ${t.status}`
        ).join('\n')
      : '  None';

    const ticketLines = tickets.length
      ? tickets.map((t) => `  • [${t.status}] ${t.issue?.slice(0, 40)}...`).join('\n')
      : '  None';

    await ctx.reply(
      `📋 *Activity Log — ${tag}*\n` +
      `──────────────────\n` +
      `⚠️ Warnings: *${user.warningsCount}/3*\n` +
      `🔒 Restricted: ${user.restrictedRights.length ? user.restrictedRights.join(', ') : 'None'}\n` +
      `⏳ Until: ${user.restrictedUntil ? formatDate(user.restrictedUntil) : 'N/A'}\n` +
      `📝 Reason: ${user.restrictionReason || '—'}\n` +
      `🚫 Blocked: ${user.isBlocked ? 'YES' : 'No'}\n` +
      `──────────────────\n` +
      `*Recent Orders (last 5):*\n${orderLines}\n` +
      `──────────────────\n` +
      `*Recent Transactions (last 5):*\n${txLines}\n` +
      `──────────────────\n` +
      `*Support Tickets (last 3):*\n${ticketLines}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /block and /unblock — explicit aliases for ban/unban ──────────────────
  // ── /bannedusers — paginated list of all banned users ────────────────────
  async function sendBannedList(ctx, page, edit = false) {
    const { users, total, totalPages } = await listBannedUsers({ page, limit: 8 });

    if (!total) {
      const msg = '✅ Banned user မရှိပါ။ အားလုံး active ဖြစ်နေပါသည်။';
      return edit ? ctx.editMessageText(msg).catch(() => ctx.reply(msg)) : ctx.reply(msg);
    }

    const selectedIds = new Set((ctx.session?.bulkUnbanIds || []).map(String));
    const rows = users.map((u) => {
      const name = u.username ? `@${u.username}` : (u.first_name || `ID:${u.telegramId}`);
      const selected = selectedIds.has(String(u.telegramId));
      const label = `${selected ? '✅' : '🚫'} ${name.slice(0, 22)} — ⚠️${u.warningsCount || 0}`;
      return [
        Markup.button.callback(label, `um_view:${u.telegramId}`),
        Markup.button.callback(selected ? '☑️ Selected' : '☐ Select', `bans_select:${u.telegramId}:${page}`),
        Markup.button.callback('🔓 Unban', `bans_unban:${u.telegramId}`),
      ];
    });

    const navBtns = [];
    if (page > 1) navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `bans_page:${page - 1}`));
    navBtns.push(Markup.button.callback(`${page}/${totalPages}`, 'bans_noop'));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `bans_page:${page + 1}`));

    const bulkRows = [];
    if (selectedIds.size) {
      bulkRows.push([Markup.button.callback(`🔓 Unban Selected (${selectedIds.size})`, 'bans_unban_selected_confirm')]);
    }
    bulkRows.push([Markup.button.callback(`⚠️ Unban All (${total})`, 'bans_unban_all_confirm')]);
    const keyboard = Markup.inlineKeyboard([...rows, ...bulkRows, navBtns]);
    const header = `🚫 *Banned Users (${total} ဦး)* — Page ${page}/${totalPages}\n\n_နာမည်နှိပ် = အသေးစိတ်၊ Select = အများဖြုတ်ရန်၊ 🔓 = တစ်ယောက်ချင်းဖြုတ်ရန်_`;

    if (edit) {
      return ctx.editMessageText(header, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
    }
    return ctx.reply(header, { parse_mode: 'Markdown', ...keyboard })
      .catch(() => ctx.reply(`Banned Users (${total}) — page ${page}/${totalPages}`, keyboard));
  }

  bot.command('bannedusers', adminOnly(), async (ctx) => {
    await sendBannedList(ctx, 1, false);
  });

  bot.action(/^bans_page:(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const page = Math.max(1, parseInt(ctx.match[1], 10) || 1);
    await sendBannedList(ctx, page, true);
  });

  bot.action('bans_noop', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
  });

  bot.action(/^bans_select:(\d+):(\d+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const uid = String(ctx.match[1]);
    const page = Math.max(1, parseInt(ctx.match[2], 10) || 1);
    const selected = new Set((ctx.session.bulkUnbanIds || []).map(String));
    if (selected.has(uid)) selected.delete(uid);
    else selected.add(uid);
    ctx.session.bulkUnbanIds = [...selected];
    await sendBannedList(ctx, page, true);
  });

  bot.action('bans_unban_selected_confirm', adminOnly(), async (ctx) => {
    const count = (ctx.session.bulkUnbanIds || []).length;
    if (!count) return ctx.answerCbQuery('ရွေးထားတဲ့ user မရှိပါ', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.reply(`⚠️ ရွေးထားတဲ့ user ${count} ယောက်ကို Unban လုပ်မလား?`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Unban', 'bans_unban_selected')],
        [Markup.button.callback('❌ Cancel', 'bans_bulk_cancel')],
      ]),
    });
  });

  bot.action('bans_unban_all_confirm', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { total } = await listBannedUsers({ page: 1, limit: 1 });
    if (!total) return ctx.reply('✅ Banned user မရှိပါ။');
    await ctx.reply(`⚠️ Banned user အားလုံး (${total} ယောက်) ကို Unban လုပ်မလား?`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Unban All', 'bans_unban_all')],
        [Markup.button.callback('❌ Cancel', 'bans_bulk_cancel')],
      ]),
    });
  });

  bot.action('bans_unban_selected', adminOnly(), async (ctx) => {
    const ids = [...new Set((ctx.session.bulkUnbanIds || []).map(Number).filter(Number.isSafeInteger))];
    await ctx.answerCbQuery('လုပ်နေပါပြီ...');
    const result = await bulkUnbanUsers({ telegramIds: ids, adminId: ctx.from.id });
    ctx.session.bulkUnbanIds = [];
    await ctx.reply(`✅ ရွေးထားတဲ့ user ${result.count} ယောက်ကို Unban လုပ်ပြီးပါပြီ။`);
    await sendBannedList(ctx, 1, false);
  });

  bot.action('bans_unban_all', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('လုပ်နေပါပြီ...');
    const result = await bulkUnbanUsers({ adminId: ctx.from.id });
    ctx.session.bulkUnbanIds = [];
    await ctx.reply(`✅ Banned user အားလုံးကို Unban လုပ်ပြီးပါပြီ။ (${result.count} ယောက်)`);
    await sendBannedList(ctx, 1, false);
  });

  bot.action('bans_bulk_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('ပယ်ဖျက်ပြီးပါပြီ');
  });

  bot.action(/^bans_unban:(\d+)$/, adminOnly(), async (ctx) => {
    const uid = ctx.match[1];
    await ctx.answerCbQuery('Unbanning...');
    try {
      const user = await unbanUser(uid, ctx.from.id);
      const tag = user.username ? `@${user.username}` : `\`${user.telegramId}\``;
      await ctx.reply(`✅ *${tag} ကို unban လုပ်ပြီးပါပြီ။*`, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(user.telegramId,
        `✅ *Your ban has been lifted.*\nYou can now use Mental Gaming Store again. Welcome back! 🎮`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      // Refresh the banned list (edit original message)
      await sendBannedList(ctx, 1, true);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.command('block', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /block @username reason');
    const reason = target.args?.join(' ') || 'Manual block by admin';
    try {
      const user = await banUser(target.identifier, ctx.from.id, reason);
      await ctx.reply(`🚫 *Blocked*\n\n\`${user.telegramId}\`\n📝 ${reason}`, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(user.telegramId,
        `🚫 *Your account has been blocked.*\n\n📝 Reason: ${reason}\n_Contact /support to appeal._`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('unblock', adminOnly(), async (ctx) => {
    const target = parseTarget(ctx);
    if (!target) return ctx.reply('Usage: /unblock @username');
    try {
      const user = await unbanUser(target.identifier, ctx.from.id);
      await ctx.reply(`✅ *Unblocked*\n\n\`${user.telegramId}\``, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(user.telegramId,
        `✅ *Your account has been restored.*\nWelcome back to Mental Gaming Store! 🎮`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  // ── Session text handler for inline actions ────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const adminId = require('../../config/settings').config.bot.adminId;
    if (ctx.from.id !== adminId) return next();

    // ── Search flow ─────────────────────────────────────────────────────────
    if (ctx.session?.umSearchPending) {
      ctx.session.umSearchPending = false;
      const query = ctx.message.text.trim();
      if (!query) return next();

      const found = await searchUsers(query);
      if (!found.length) {
        return ctx.reply(
          `❌ *"${esc(query)}"* — user မတွေ့ပါ\n\nID (နံပါတ်) သို့မဟုတ် @username စစ်ကြည့်ပါ`,
          { parse_mode: 'Markdown' }
        );
      }
      return ctx.reply(
        `🔍 *"${esc(query)}"* — ${found.length} ယောက် တွေ့သည်\n\n_User တစ်ယောက်ချင်း ကြည့်ရန် နှိပ်ပါ_ 👇`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(userListButtons(found)) }
      ).catch(() =>
        ctx.reply(`Search: ${query} (${found.length} found)`, Markup.inlineKeyboard(userListButtons(found)))
      );
    }

    const action = ctx.session?.umPendingAction;
    if (!action) return next();

    const { type, uid } = action;
    const input = ctx.message.text.trim();
    ctx.session.umPendingAction = null;

    try {
      if (type === 'warn') {
        const { user, autoBanned } = await warnUser(uid, ctx.from.id, input);
        await ctx.reply(
          `⚠️ Warning issued to \`${uid}\` — ${user.warningsCount}/3${autoBanned ? '\n🚫 Auto-banned.' : ''}`,
          { parse_mode: 'Markdown' }
        );
        await ctx.telegram.sendMessage(user.telegramId,
          `⚠️ *Warning (${user.warningsCount}/3):* ${input}`, { parse_mode: 'Markdown' }
        ).catch(() => {});
      } else if (type === 'ban') {
        const user = await banUser(uid, ctx.from.id, input);
        await ctx.reply(`🚫 \`${uid}\` banned. Reason: ${input}`, { parse_mode: 'Markdown' });
        await ctx.telegram.sendMessage(user.telegramId, `🚫 *You have been banned.* Reason: ${input}`, { parse_mode: 'Markdown' }).catch(() => {});
      } else if (type === 'adjust') {
        const amount = parseInt(input.replace(/[^-\d]/g, ''), 10);
        if (isNaN(amount) || amount === 0) return ctx.reply('❌ Invalid amount. Use +5000 or -2000.');
        const { user } = await adjustBalance(uid, ctx.from.id, amount, 'Admin inline adjustment');
        await ctx.reply(`💳 \`${uid}\` balance ${amount > 0 ? '+' : ''}${amount.toLocaleString()} KS. New: ${price(user.balanceKS)}`, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });
};
