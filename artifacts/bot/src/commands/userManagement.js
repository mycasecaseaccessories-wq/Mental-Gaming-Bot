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
  warnUser, unwarnUser, banUser, unbanUser,
  restrictUser, unrestrictUser,
  getUserInfo, listUsers, searchUsers,
  adjustBalance, resolveUser, ALL_RIGHTS,
} = require('../services/UserManagementService');
const { issueWarning, getUserLog } = require('../services/PenaltyService');
const { auditLog } = require('../services/logger');
const { price, formatDate } = require('../utils/ui');
const { getTheme } = require('../services/ThemeService');
const { checklist } = require('../utils/animations');

const esc = (s) => String(s || '').replace(/([_*`\[\]()~>#+=|{}.!\\-])/g, '\\$1');

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

// ── Build user info card ──────────────────────────────────────────────────────
async function buildUserCard(ctx, identifier) {
  const info = await getUserInfo(identifier);
  if (!info) return null;

  const { user, orderCount, pendingOrders, totalSpent, hasPendingTopup } = info;
  const statusIcon = user.isBlocked ? '🚫 Banned' : '🟢 Active';
  const tag = user.username ? `@${user.username}` : `_(no username)_`;

  const text =
    `👤 *User Info*\n` +
    `──────────────────\n` +
    `🆔 ID: \`${user.telegramId}\`\n` +
    `${tag}\n` +
    `──────────────────\n` +
    `⭐ Tier: *${user.membershipTier}*\n` +
    `💰 KS Balance: *${price(user.balanceKS || 0)}*\n` +
    `🪙 Coins: *${(user.balanceCoin || 0).toLocaleString()} MC*\n` +
    `💼 Total Deposited: *${price(user.totalDeposited || 0)}*\n` +
    `──────────────────\n` +
    `📦 Orders: ${orderCount}  |  🟡 Pending: ${pendingOrders}\n` +
    `💸 Total Spent: *${price(totalSpent)}*\n` +
    `💳 Pending Topup: ${hasPendingTopup ? '⏳ Yes' : 'None'}\n` +
    `──────────────────\n` +
    `⚠️ Warnings: *${user.warningsCount}/3*\n` +
    `🔒 Restrictions: ${user.restrictedRights.length ? user.restrictedRights.join(', ') : 'None'}\n` +
    `📊 Status: ${statusIcon}\n` +
    `📅 Joined: ${formatDate(user.joinDate)}\n` +
    `🕐 Last Active: ${formatDate(user.lastActive)}`;

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
  ]);

  return { text, keyboard, user };
}

module.exports = function registerUserManagement(bot) {

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
      const lines = found.map((u) =>
        `• \`${u.telegramId}\` ${u.username ? `@${esc(u.username)}` : '_(no username)_'} — ${esc(u.membershipTier)} — ${u.isBlocked ? '🚫' : '🟢'}`
      );
      return ctx.reply(`🔍 *Search: "${esc(query)}"* (${found.length} found)\n\n${lines.join('\n')}`, {
        parse_mode: 'Markdown',
      }).catch(() => ctx.reply(`Search: ${query} (${found.length} found)\n\n${lines.join('\n').replace(/[*_`]/g,'')}`));
    }

    const { users, total, totalPages } = await listUsers({ page: 1, limit: 10 });
    const lines = users.map((u, i) =>
      `${i + 1}. \`${u.telegramId}\` ${u.username ? `@${esc(u.username)}` : '—'} — ${esc(u.membershipTier)} ${u.isBlocked ? '🚫' : '🟢'}`
    );

    await ctx.reply(
      `👥 *Users (${total} total)*\n\n${lines.join('\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`Page 1/${totalPages} ›`, 'users_page:2')],
        ]),
      }
    ).catch(() => ctx.reply(`Users (${total} total)\n\n${lines.join('\n').replace(/[*_`]/g,'')}`));
  });

  bot.action(/^users_page:(\d+)$/, adminOnly(), async (ctx) => {
    const page = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const { users, total, totalPages } = await listUsers({ page, limit: 10 });
    const lines = users.map((u, i) =>
      `${(page - 1) * 10 + i + 1}. \`${u.telegramId}\` ${u.username ? `@${esc(u.username)}` : '—'} — ${esc(u.membershipTier)} ${u.isBlocked ? '🚫' : '🟢'}`
    );
    const navBtns = [];
    if (page > 1) navBtns.push(Markup.button.callback(`‹ ${page - 1}`, `users_page:${page - 1}`));
    if (page < totalPages) navBtns.push(Markup.button.callback(`${page + 1} ›`, `users_page:${page + 1}`));

    await ctx.editMessageText(
      `👥 *Users (${total} total) — Page ${page}/${totalPages}*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navBtns]) }
    );
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
    const action = ctx.session?.umPendingAction;
    if (!action || ctx.from.id !== require('../../config/settings').config.bot.adminId) return next();

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
