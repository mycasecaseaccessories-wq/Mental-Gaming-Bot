/**
 * Support Command
 *
 * User: /support → enters supportScene (AI assistant → escalate)
 * Admin: ticket management — reply, resolve, archive, assign, list open tickets
 *        [📜 Use Template] on every ticket card
 *
 * Photo interceptor: handles screenshot upload before ticket creation
 * (session.awaitingTicketScreenshot)
 */

const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const { buildMessage, formatDate } = require('../utils/ui');
const { adminOnly, requireRole, isAnyAdmin } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { mainMenuKeyboard } = require('../utils/keyboard');
const { t } = require('../utils/i18n');
const SupportTicket = require('../models/SupportTicket');

const TOPIC_META = {
  order:   { label: '📦 Order Issue',      emoji: '📦' },
  payment: { label: '💳 Payment / Wallet', emoji: '💳' },
  game:    { label: '🎮 Game Help',        emoji: '🎮' },
  bug:     { label: '🐛 Bug Report',       emoji: '🐛' },
  general: { label: '❓ General Query',    emoji: '❓' },
};

Nav.register({
  id: 'support_view',
  title: '💬 Support',
  build: async (ctx, theme) => {
    const text = buildMessage(theme, [
      {
        title: t(ctx, 'support.title').replace(/\*/g, ''),
        lines: [
          t(ctx, 'support.ai_24_7'),
          t(ctx, 'support.human_hours'),
          t(ctx, 'support.instant'),
          ``,
          t(ctx, 'support.start_chat'),
          t(ctx, 'support.start_desc'),
        ],
      },
    ]);

    return { text, keyboard: mainMenuKeyboard(ctx) };
  },
});

module.exports = function registerSupport(bot) {

  // ── User: /support ─────────────────────────────────────────────────────────
  bot.command('support', async (ctx) => {
    await ctx.scene.enter('support_scene');
  });

  bot.hears(['💬 Support', '💬 အကူအညီ'], async (ctx) => {
    await ctx.scene.enter('support_scene');
  });

  bot.action('support_ai_start', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('support_scene');
  });

  // ── Owner: Support direct-contact account (panel + /setsupportcontact) ────

  async function buildSupportContactPanel() {
    const SystemStatus = require('../models/SystemStatus');
    const st = await SystemStatus.get();
    const current = st.supportContactUsername
      ? `\`@${st.supportContactUsername}\``
      : '_auto (owner account ရဲ့ username ကို သုံးနေတယ်)_';
    const text =
      `📨 *Support Direct-Contact Account*\n\n` +
      `လက်ရှိ: ${current}\n\n` +
      `/support ထဲက "📨 Admin ကို တိုက်ရိုက် စာပို့ရန်" ခလုတ်နှိပ်ရင် ရောက်သွားမယ့် account ပါ။`;
    const rows = [
      [Markup.button.callback('✏️ Username ပြောင်းမယ်', 'sup_contact_set')],
    ];
    if (st.supportContactUsername) {
      rows.push([Markup.button.callback('🔄 Auto (owner account) ပြန်သုံးမယ်', 'sup_contact_off')]);
    }
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  async function saveSupportContact(ctx, username) {
    const SystemStatus = require('../models/SystemStatus');
    await SystemStatus.set({ supportContactUsername: username }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_SUPPORT_CONTACT', null, 'System', { username });
    if (username) {
      await ctx.reply(
        `✅ *Support contact သတ်မှတ်ပြီးပါပြီ!*\n\n` +
          `/support ထဲက 📨 ခလုတ်နှိပ်ရင် အခုကစပြီး \`@${username}\` ဆီ ရောက်သွားပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `✅ ဖျက်လိုက်ပါပြီ — owner account ရဲ့ username ကို အလိုအလျောက် ပြန်သုံးပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  bot.command('setsupportcontact', adminOnly(), async (ctx) => {
    const arg = (ctx.message.text.split(/\s+/)[1] || '').trim();

    if (!arg) {
      const { text, keyboard } = await buildSupportContactPanel();
      return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }

    if (['off', 'auto', 'clear'].includes(arg.toLowerCase())) {
      return saveSupportContact(ctx, null);
    }

    const username = arg.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      return ctx.reply(
        `❌ Username ပုံစံ မမှန်ပါဘူး။\n\n` +
          `Telegram username က အက္ခရာ/ဂဏန်း/underscore ၅–၃၂ လုံး ဖြစ်ရပါမယ်။ ဥပမာ: \`/setsupportcontact @mgs_admin\``,
        { parse_mode: 'Markdown' }
      );
    }

    return saveSupportContact(ctx, username);
  });

  bot.action('sup_contact_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildSupportContactPanel();
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  });

  bot.action('sup_contact_set', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const prompt = await ctx.reply(
      `✏️ *Support contact username ရိုက်ထည့်ပါ:*\n\n` +
        `ဥပမာ: \`@mgs_admin\` (သို့) \`mgs_admin\`\n` +
        `ဖျက်ချင်ရင် \`off\` လို့ ရိုက်ပါ။`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
    ctx.session.awaitingSupportContact = prompt.message_id;
  });

  bot.action('sup_contact_off', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('🔄 Auto ပြန်သုံးပါပြီ');
    await saveSupportContact(ctx, null);
  });

  // Text wizard step for ✏️ Username ပြောင်းမယ် button
  bot.on('text', async (ctx, next) => {
    const promptMsgId = ctx.session?.awaitingSupportContact;
    if (!promptMsgId) return next();
    if (!(await isAnyAdmin(ctx.from.id))) return next();

    // Only consume replies to the wizard prompt — anything else (menu button
    // taps, commands, other wizard inputs) clears the flag and passes through
    if (ctx.message.reply_to_message?.message_id !== promptMsgId) {
      ctx.session.awaitingSupportContact = null;
      return next();
    }

    const input = ctx.message.text.trim();

    if (['off', 'auto', 'clear', '/off'].includes(input.toLowerCase())) {
      ctx.session.awaitingSupportContact = null;
      return saveSupportContact(ctx, null);
    }

    const username = input.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      const prompt = await ctx.reply(
        `❌ Username ပုံစံ မမှန်ပါဘူး — အက္ခရာ/ဂဏန်း/underscore ၅–၃၂ လုံး ဖြစ်ရပါမယ်။\n\nထပ်ရိုက်ပါ (ဖျက်ချင်ရင် \`off\`):`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
      ctx.session.awaitingSupportContact = prompt.message_id;
      return;
    }

    ctx.session.awaitingSupportContact = null;
    return saveSupportContact(ctx, username);
  });

  // ── Photo interceptor: screenshot for pending ticket ──────────────────────
  bot.on('photo', async (ctx, next) => {
    if (!ctx.session?.awaitingTicketScreenshot) return next();

    ctx.session.awaitingTicketScreenshot = false;

    // Get the highest-resolution photo version
    const photos  = ctx.message.photo;
    const fileId  = photos[photos.length - 1].file_id;

    await ctx.reply('📎 Screenshot received! Creating your ticket...');

    // Import here to avoid circular require
    const supportScene = require('../scenes/supportScene');
    await supportScene.createTicketFromSession(ctx, [fileId]);
  });

  // ── /skip command — skip screenshot upload ────────────────────────────────
  bot.command('skip', async (ctx) => {
    if (!ctx.session?.awaitingTicketScreenshot) return;
    ctx.session.awaitingTicketScreenshot = false;

    const supportScene = require('../scenes/supportScene');
    await supportScene.createTicketFromSession(ctx, []);
  });

  // ── User: /mytickets ───────────────────────────────────────────────────────
  bot.command('mytickets', async (ctx) => {
    const tickets = await SupportTicket.find({ telegramId: ctx.from.id })
      .sort({ createdAt: -1 })
      .limit(5);

    if (!tickets.length) {
      return ctx.reply(
        `🎫 *My Support Tickets*\n\nNo tickets yet.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('💬 Open Support', 'support_ai_start')]]),
        }
      );
    }

    const statusIcon = { Open: '🟡', InProgress: '🔵', Resolved: '✅', Closed: '⚫' };
    const lines = tickets.map((t) => {
      const meta = TOPIC_META[t.topic] || { emoji: '❓' };
      const assigned = t.assignedAdmin ? ' 👤' : '';
      const screenshot = t.screenshots?.length ? ' 📎' : '';
      return (
        `${statusIcon[t.status] || '⚪'} \`${t.ticketId}\` — ${meta.emoji} ${t.topic} — *${t.status}*${assigned}${screenshot}\n` +
        (t.subject ? `  _${t.subject}_\n` : '') +
        `  _${formatDate(t.createdAt)}_`
      );
    });

    await ctx.reply(
      `🎫 *My Support Tickets (${tickets.length})*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /tickets ────────────────────────────────────────────────────────
  bot.command('tickets', requireRole('STAFF'), async (ctx) => {
    const args   = ctx.message.text.split(/\s+/).slice(1);
    const filter = args[0] === 'all'
      ? { isArchived: { $ne: true } }
      : { status: { $in: ['Open', 'InProgress'] }, isArchived: { $ne: true } };

    const tickets = await SupportTicket.find(filter).sort({ createdAt: -1 }).limit(10);
    if (!tickets.length) return ctx.reply('✅ No open tickets.');

    const priorityBadge = { Normal: '🟡', High: '🟠', Urgent: '🔴' };
    for (const t of tickets) {
      const meta     = TOPIC_META[t.topic] || { emoji: '❓', label: t.topic };
      const badge    = priorityBadge[t.priority] || '🟡';
      const userTag  = t.username ? `@${t.username}` : `ID: ${t.telegramId}`;
      const assigned = t.assignedAdmin ? `\n🔵 Assigned: \`${t.assignedAdmin}\`` : '';
      const hasShot  = t.screenshots?.length ? '\n📎 Has screenshot' : '';

      await ctx.reply(
        `🎫 \`${t.ticketId}\` — ${badge} ${t.priority}\n` +
        `${meta.emoji} *${meta.label}*\n` +
        `👤 ${userTag} | ${t.status}${assigned}${hasShot}\n` +
        `_${formatDate(t.createdAt)}_\n\n` +
        `*Message:* ${t.userMessage.slice(0, 200)}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(`💬 Reply`,      `ticket_reply:${t.ticketId}`),
              Markup.button.callback(`📜 Template`,   `tpl_pick:ticket:${t.ticketId}`),
            ],
            [
              Markup.button.callback('✅ Resolve',    `ticket_resolve:${t.ticketId}`),
              Markup.button.callback('🔵 Assign',     `ticket_assign:${t.ticketId}`),
            ],
            [
              Markup.button.callback('🔴 Urgent',     `ticket_urgent:${t.ticketId}`),
              Markup.button.callback('📁 Archive',    `ticket_archive:${t.ticketId}`),
            ],
          ]),
        }
      );

      // If ticket has screenshots, forward them inline
      if (t.screenshots?.length) {
        for (const fileId of t.screenshots) {
          await ctx.replyWithPhoto(fileId, {
            caption: `📎 Screenshot — Ticket \`${t.ticketId}\``,
            parse_mode: 'Markdown',
          }).catch(() => {});
        }
      }
    }
  });

  // ── Admin action: reply to ticket ──────────────────────────────────────────
  bot.action(/^ticket_reply:(.+)$/, requireRole('STAFF'), async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery();

    const ticket = await SupportTicket.findOne({ ticketId });
    if (!ticket) return ctx.reply('❌ Ticket not found.');

    ctx.session.adminTicketReply = { ticketId, userTelegramId: ticket.telegramId };
    await ctx.reply(
      `💬 *Reply to Ticket \`${ticketId}\`*\n\n` +
      (ticket.subject ? `Subject: _${ticket.subject}_\n` : '') +
      `Original: _${ticket.userMessage.slice(0, 120)}_\n\n` +
      `Type your reply:`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── Admin action: resolve ticket ───────────────────────────────────────────
  bot.action(/^ticket_resolve:(.+)$/, requireRole('STAFF'), async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery('Resolving...');

    const ticket = await SupportTicket.findOneAndUpdate(
      { ticketId },
      { status: 'Resolved', resolvedBy: ctx.from.id },
      { new: true }
    );
    if (!ticket) return ctx.reply('❌ Ticket not found.');

    await auditLog(ctx.from.id, 'TICKET_RESOLVED', ticketId, 'System');
    await ctx.reply(`✅ Ticket \`${ticketId}\` marked as *Resolved*.`, { parse_mode: 'Markdown' });

    try {
      await ctx.telegram.sendMessage(
        ticket.telegramId,
        `✅ *Your support ticket has been resolved!*\n\n` +
        `🎫 Ticket: \`${ticketId}\`\n` +
        (ticket.subject ? `📝 _${ticket.subject}_\n` : '') +
        `\n_If you need further help, use /support anytime._`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // ── Admin action: assign ticket to self ────────────────────────────────────
  bot.action(/^ticket_assign:(.+)$/, requireRole('STAFF'), async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery('Assigned to you!');

    const ticket = await SupportTicket.findOneAndUpdate(
      { ticketId },
      { assignedAdmin: ctx.from.id, assignedAt: new Date(), status: 'InProgress' },
      { new: true }
    );
    if (!ticket) return ctx.reply('❌ Ticket not found.');

    await auditLog(ctx.from.id, 'TICKET_ASSIGNED', ticketId, 'System', { adminId: ctx.from.id });
    await ctx.reply(
      `🔵 Ticket \`${ticketId}\` assigned to you and set to *InProgress*.`,
      { parse_mode: 'Markdown' }
    );

    try {
      await ctx.telegram.sendMessage(
        ticket.telegramId,
        `👨‍💼 *A support agent has picked up your ticket!*\n\n` +
        `🎫 Ticket: \`${ticketId}\`\n` +
        `_We're working on your issue and will reply shortly._`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // ── Admin action: archive ticket ───────────────────────────────────────────
  bot.action(/^ticket_archive:(.+)$/, requireRole('STAFF'), async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery('Archived.');

    const ticket = await SupportTicket.findOneAndUpdate(
      { ticketId },
      { isArchived: true, archivedAt: new Date(), archivedBy: ctx.from.id, status: 'Closed' },
      { new: true }
    );
    if (!ticket) return ctx.reply('❌ Ticket not found.');

    await auditLog(ctx.from.id, 'TICKET_ARCHIVED', ticketId, 'System');
    await ctx.reply(`📁 Ticket \`${ticketId}\` archived.`, { parse_mode: 'Markdown' });
  });

  // ── Admin action: mark urgent ──────────────────────────────────────────────
  bot.action(/^ticket_urgent:(.+)$/, requireRole('STAFF'), async (ctx) => {
    const ticketId = ctx.match[1];
    await ctx.answerCbQuery('Marked Urgent');

    await SupportTicket.findOneAndUpdate({ ticketId }, { priority: 'Urgent', status: 'InProgress' });
    await auditLog(ctx.from.id, 'TICKET_URGENT', ticketId, 'System');
    await ctx.reply(
      `🔴 Ticket \`${ticketId}\` marked *Urgent* and set to *InProgress*.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /closeticket ────────────────────────────────────────────────────
  bot.command('closeticket', requireRole('STAFF'), async (ctx) => {
    const ticketId = ctx.message.text.split(/\s+/)[1];
    if (!ticketId) return ctx.reply('Usage: /closeticket TKT-XXXX');

    const ticket = await SupportTicket.findOneAndUpdate(
      { ticketId: ticketId.toUpperCase() },
      { status: 'Closed', resolvedBy: ctx.from.id },
      { new: true }
    );
    if (!ticket) return ctx.reply('❌ Ticket not found.');

    await auditLog(ctx.from.id, 'TICKET_CLOSED', ticketId, 'System');
    await ctx.reply(`⚫ Ticket \`${ticket.ticketId}\` closed.`, { parse_mode: 'Markdown' });
  });

  // ── Text interceptor: admin ticket reply ──────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminTicketReply;
    if (!state) return next();

    const adminOk = await isAnyAdmin(ctx.from?.id);
    if (!adminOk) return next();

    const { ticketId, userTelegramId } = state;
    ctx.session.adminTicketReply = null;

    const replyText = ctx.message.text.trim();

    try {
      await SupportTicket.findOneAndUpdate(
        { ticketId },
        {
          $push: { replies: { from: 'admin', message: replyText, adminId: ctx.from.id } },
          status: 'InProgress',
        }
      );

      await ctx.telegram.sendMessage(
        userTelegramId,
        `💬 *Support Reply* — Ticket \`${ticketId}\`\n\n${replyText}\n\n` +
        `_To reply back, use /support and create a new ticket or check /mytickets_`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(`✅ Reply sent for ticket \`${ticketId}\`.`, { parse_mode: 'Markdown' });
      await auditLog(ctx.from.id, 'TICKET_REPLIED', ticketId, 'System');
    } catch (err) {
      await ctx.reply(`❌ Failed to send reply: ${err.message}`);
    }
  });

  // ── Text interceptor: legacy admin reply ──────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const replyTarget = ctx.session?.adminReplyToUser;
    if (!replyTarget) return next();

    const adminOk = await isAnyAdmin(ctx.from?.id);
    if (!adminOk) return next();

    ctx.session.adminReplyToUser = null;
    try {
      await ctx.telegram.sendMessage(
        replyTarget,
        `💬 *Reply from Mental Gaming Store Support:*\n\n${ctx.message.text}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.reply(`✅ Reply sent to user ${replyTarget}.`);
    } catch {
      await ctx.reply(`❌ Could not deliver reply. User may have blocked the bot.`);
    }
  });

  // ── Admin reply button from old ticket notifications ───────────────────────
  bot.action(/^reply_user:(\d+)$/, requireRole('STAFF'), async (ctx) => {
    const userId = parseInt(ctx.match[1], 10);
    ctx.session.adminReplyToUser = userId;
    await ctx.answerCbQuery();
    await ctx.reply(`✍️ Type your reply to user ${userId}:`, { ...Markup.forceReply() });
  });
};
