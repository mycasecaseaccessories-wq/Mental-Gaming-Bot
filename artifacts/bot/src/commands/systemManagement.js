/**
 * System Management Suite — Multi-level Admin RBAC + Maintenance/Holiday + Templates + Pulse
 *
 * OWNER only:   /addadmin /removeadmin /listadmins /setrole /pulse /auditlog
 * MANAGER+:     /maintenance /holiday /systemstatus /addtemplate /deletetemplate /templates
 * STAFF+:       /myrole
 */

const { Markup } = require('telegraf');
const { adminOnly, requireRole } = require('../middlewares/adminCheck');
const AdminService   = require('../services/AdminService');
const TemplateService = require('../services/TemplateService');
const SystemStatus   = require('../models/SystemStatus');
const AuditLog       = require('../models/AuditLog');
const { invalidateCache } = require('../middlewares/maintenanceCheck');
const { auditLog }   = require('../services/logger');
const { config }     = require('../../config/settings');

// ── Formatters ─────────────────────────────────────────────────────────────────

const ROLE_BADGE = { OWNER: '👑', MANAGER: '🛠', STAFF: '🔹' };

function fmtAdmin(a) {
  const badge = ROLE_BADGE[a.role] || '•';
  const tag   = a.username ? `@${a.username}` : `ID: ${a.telegramId}`;
  const owner = a._envOwner ? ' _(env)_' : '';
  return `${badge} ${tag} — *${a.role}*${owner}`;
}

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerSystemManagement(bot) {

  // ════════════════════════════════════════════════════════════════════════════
  // RBAC — Admin management (OWNER only)
  // ════════════════════════════════════════════════════════════════════════════

  // /addadmin <telegramId> <ROLE>
  bot.command('addadmin', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      return ctx.reply(
        `👑 *Add Admin*\n\nUsage: \`/addadmin <telegramId> <ROLE>\`\n\n` +
        `Roles: \`OWNER\` | \`MANAGER\` | \`STAFF\`\n\n` +
        `Examples:\n` +
        `• \`/addadmin 123456789 MANAGER\`\n` +
        `• \`/addadmin 987654321 STAFF\``,
        { parse_mode: 'Markdown' }
      );
    }

    const [tidStr, roleRaw] = args;
    const telegramId = parseInt(tidStr, 10);
    const role       = roleRaw.toUpperCase();

    if (isNaN(telegramId)) return ctx.reply('❌ Invalid Telegram ID — must be a number.');

    try {
      const admin = await AdminService.addAdmin(telegramId, role, ctx.from.id);
      await ctx.reply(
        `✅ *Admin Added*\n\n` +
        `${ROLE_BADGE[role] || '•'} \`${telegramId}\` — *${admin.role}*\n\n` +
        `_They can now use admin commands based on their role._`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // /removeadmin <telegramId>
  bot.command('removeadmin', adminOnly(), async (ctx) => {
    const tidStr = ctx.message.text.split(/\s+/)[1];
    if (!tidStr) return ctx.reply('Usage: `/removeadmin <telegramId>`', { parse_mode: 'Markdown' });

    const telegramId = parseInt(tidStr, 10);
    if (isNaN(telegramId)) return ctx.reply('❌ Invalid Telegram ID.');

    try {
      const admin = await AdminService.removeAdmin(telegramId, ctx.from.id);
      await ctx.reply(
        `✅ *Admin Removed*\n\n\`${telegramId}\` (was *${admin.role}*) has been deactivated.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // /listadmins
  bot.command('listadmins', adminOnly(), async (ctx) => {
    const admins = await AdminService.listAdmins();
    const ownerEntry = { telegramId: config.bot.adminId, role: 'OWNER', _envOwner: true };

    const lines = [
      fmtAdmin(ownerEntry),
      ...admins.map(fmtAdmin),
    ];

    await ctx.reply(
      `👥 *Admin Roster (${lines.length})*\n\n${lines.join('\n')}\n\n` +
      `_Use /addadmin or /removeadmin to manage._`,
      { parse_mode: 'Markdown' }
    );
  });

  // /setrole <telegramId> <ROLE>
  bot.command('setrole', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) return ctx.reply('Usage: `/setrole <telegramId> <ROLE>`', { parse_mode: 'Markdown' });

    const [tidStr, roleRaw] = args;
    const telegramId = parseInt(tidStr, 10);
    const role       = roleRaw.toUpperCase();

    if (isNaN(telegramId)) return ctx.reply('❌ Invalid Telegram ID.');

    try {
      const admin = await AdminService.updateAdminRole(telegramId, role, ctx.from.id);
      await ctx.reply(
        `✅ Role updated: \`${telegramId}\` → *${admin.role}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // /myrole — any admin
  bot.command('myrole', async (ctx) => {
    const role = await AdminService.getAdminRole(ctx.from.id);
    if (!role) return ctx.reply('ℹ️ You do not have an admin role.');
    await ctx.reply(
      `${ROLE_BADGE[role]} Your admin role: *${role}*\n\n` +
      `_Permissions: ${
        role === 'OWNER'   ? 'Full access — all commands + exports + admin management.' :
        role === 'MANAGER' ? 'Edit prices/products, manage tickets, approve orders. No financial exports.' :
        'Approve/reject orders & top-ups, reply to support tickets.'
      }_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // System Status — Maintenance & Holiday Mode (MANAGER+)
  // ════════════════════════════════════════════════════════════════════════════

  // /systemstatus
  bot.command('systemstatus', requireRole('MANAGER'), async (ctx) => {
    const s = await SystemStatus.get();
    const mode =
      s.maintenanceMode ? `🔧 *Maintenance ON*${s.maintenanceUntil ? `\n⏳ Until: ${new Date(s.maintenanceUntil).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT` : ''}` :
      s.holidayMode     ? `🎉 *Holiday ON*${s.holidayUntil ? `\n📅 Until: ${new Date(s.holidayUntil).toLocaleDateString('en-GB')}` : ''}` :
      `🟢 *Normal — All systems operational*`;

    await ctx.reply(
      `📊 *System Status*\n\n${mode}\n\n` +
      (s.maintenanceMode ? `📝 Message: _${s.maintenanceMessage}_\n\n` : '') +
      (s.holidayMode     ? `📝 Message: _${s.holidayMessage}_\n\n` : '') +
      `_Updated by: \`${s.updatedBy || 'N/A'}\`_`,
      { parse_mode: 'Markdown' }
    );
  });

  // /maintenance on [message] [hours]  OR  /maintenance off
  bot.command('maintenance', requireRole('MANAGER'), async (ctx) => {
    const args   = ctx.message.text.split(/\s+/).slice(1);
    const toggle = (args[0] || '').toLowerCase();

    if (!['on', 'off'].includes(toggle)) {
      return ctx.reply(
        `🔧 *Maintenance Mode*\n\n` +
        `Turn ON:  \`/maintenance on [message] [hours]\`\n` +
        `Turn OFF: \`/maintenance off\`\n\n` +
        `Examples:\n` +
        `• \`/maintenance on "Server update" 2\`\n` +
        `• \`/maintenance on\`\n` +
        `• \`/maintenance off\``,
        { parse_mode: 'Markdown' }
      );
    }

    if (toggle === 'off') {
      await SystemStatus.set({ maintenanceMode: false, maintenanceSince: null, maintenanceUntil: null }, ctx.from.id);
      invalidateCache();
      await auditLog(ctx.from.id, 'MAINTENANCE_OFF', null, 'System');
      return ctx.reply('✅ *Maintenance mode disabled.* Bot is back to normal.', { parse_mode: 'Markdown' });
    }

    // Parse: /maintenance on "Optional message" [hours]
    const rest   = ctx.message.text.replace(/^\/maintenance\s+on\s*/i, '').trim();
    const quoted = rest.match(/^"([^"]+)"\s*(\d+(?:\.\d+)?)?$/);
    const plain  = rest.match(/^([^0-9].*?)?\s*(\d+(?:\.\d+)?)?$/);

    let message  = null;
    let hours    = null;

    if (quoted) {
      message = quoted[1] || null;
      hours   = quoted[2] ? parseFloat(quoted[2]) : null;
    } else if (plain) {
      message = plain[1]?.trim() || null;
      hours   = plain[2] ? parseFloat(plain[2]) : null;
    }

    const fields = {
      maintenanceMode:  true,
      maintenanceSince: new Date(),
      maintenanceUntil: hours ? new Date(Date.now() + hours * 3600000) : null,
    };
    if (message) fields.maintenanceMessage = message;

    await SystemStatus.set(fields, ctx.from.id);
    invalidateCache();
    await auditLog(ctx.from.id, 'MAINTENANCE_ON', null, 'System', { message, hours });

    const untilStr = fields.maintenanceUntil
      ? `\n⏳ Auto-lifts in *${hours}h* at ${fields.maintenanceUntil.toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT`
      : '';

    await ctx.reply(
      `🔧 *Maintenance Mode ENABLED*\n\n` +
      `📝 Message: _${fields.maintenanceMessage || 'Scheduled Maintenance'}_${untilStr}\n\n` +
      `⚠️ All user commands are now blocked. Use \`/maintenance off\` to restore.`,
      { parse_mode: 'Markdown' }
    );
  });

  // /holiday on [dd/mm/yyyy] [message]  OR  /holiday off
  bot.command('holiday', requireRole('MANAGER'), async (ctx) => {
    const args   = ctx.message.text.split(/\s+/).slice(1);
    const toggle = (args[0] || '').toLowerCase();

    if (!['on', 'off'].includes(toggle)) {
      return ctx.reply(
        `🎉 *Holiday Mode*\n\n` +
        `Turn ON:  \`/holiday on [dd/mm/yyyy] [message]\`\n` +
        `Turn OFF: \`/holiday off\`\n\n` +
        `Examples:\n` +
        `• \`/holiday on 25/12/2025 "Merry Christmas! Back on 26 Dec."\`\n` +
        `• \`/holiday on\`\n` +
        `• \`/holiday off\``,
        { parse_mode: 'Markdown' }
      );
    }

    if (toggle === 'off') {
      await SystemStatus.set({ holidayMode: false, holidayUntil: null }, ctx.from.id);
      invalidateCache();
      await auditLog(ctx.from.id, 'HOLIDAY_OFF', null, 'System');
      return ctx.reply('✅ *Holiday mode disabled.* Orders and top-ups are back online.', { parse_mode: 'Markdown' });
    }

    const rest    = ctx.message.text.replace(/^\/holiday\s+on\s*/i, '').trim();
    const dateRx  = /^(\d{2}\/\d{2}\/\d{4})/;
    const dateMatch = rest.match(dateRx);

    let until   = null;
    let message = null;

    if (dateMatch) {
      const [d, m, y] = dateMatch[1].split('/');
      until   = new Date(`${y}-${m}-${d}T23:59:59Z`);
      message = rest.slice(dateMatch[0].length).trim().replace(/^"|"$/g, '') || null;
    } else if (rest) {
      message = rest.replace(/^"|"$/g, '');
    }

    const fields = {
      holidayMode:  true,
      holidayUntil: until,
    };
    if (message) fields.holidayMessage = message;

    await SystemStatus.set(fields, ctx.from.id);
    invalidateCache();
    await auditLog(ctx.from.id, 'HOLIDAY_ON', null, 'System', { until, message });

    const untilStr = until ? `\n📅 Returns: *${until.toLocaleDateString('en-GB')}*` : '';
    await ctx.reply(
      `🎉 *Holiday Mode ENABLED*${untilStr}\n\n` +
      `📝 Message: _${fields.holidayMessage || 'Holiday mode active.'}_\n\n` +
      `⚠️ Users can browse but cannot place orders or top up. Use \`/holiday off\` to restore.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Quick-Reply Templates (STAFF+)
  // ════════════════════════════════════════════════════════════════════════════

  // /templates — list all templates
  bot.command('templates', requireRole('STAFF'), async (ctx) => {
    const templates = await TemplateService.listTemplates();
    if (!templates.length) {
      return ctx.reply('📜 No templates yet. Use `/addtemplate` to create one.', { parse_mode: 'Markdown' });
    }

    const EMOJI = TemplateService.CATEGORY_EMOJI;
    const grouped = {};
    for (const t of templates) {
      (grouped[t.category] = grouped[t.category] || []).push(t);
    }

    const lines = [];
    for (const [cat, list] of Object.entries(grouped)) {
      lines.push(`*${EMOJI[cat] || '📝'} ${cat.charAt(0).toUpperCase() + cat.slice(1)}*`);
      for (const t of list) {
        lines.push(`  • \`${t._id.toString().slice(-6)}\` *${t.name}* _(used ${t.usageCount}×)_`);
      }
    }

    await ctx.reply(
      `📜 *Quick-Reply Templates (${templates.length})*\n\n${lines.join('\n')}\n\n` +
      `_Use the [📜 Use Template] button in orders/tickets to apply._`,
      { parse_mode: 'Markdown' }
    );
  });

  // /addtemplate  (multi-line: first line = name, rest = content)
  bot.command('addtemplate', requireRole('MANAGER'), async (ctx) => {
    const full = ctx.message.text.replace(/^\/addtemplate\s*/i, '').trim();
    if (!full) {
      return ctx.reply(
        `📝 *Add Template*\n\n` +
        `Format (first line = name, rest = message, optional last line = category):\n\n` +
        `\`/addtemplate\`\n` +
        `\`Template Name\`\n` +
        `\`Your message content here…\`\n` +
        `\`[category: order|payment|warning|general]\`\n\n` +
        `Example:\n` +
        `\`/addtemplate\nDelivery Delayed\nSorry, your order is slightly delayed. ETA: 30 min.\norder\``,
        { parse_mode: 'Markdown' }
      );
    }

    const lines    = full.split('\n').map((l) => l.trim()).filter(Boolean);
    const validCats = ['order', 'payment', 'warning', 'general'];
    const lastLine  = lines[lines.length - 1]?.toLowerCase();
    const hasCat    = validCats.includes(lastLine);
    const category  = hasCat ? lastLine : 'general';
    const body      = hasCat ? lines.slice(0, -1) : lines;

    const name    = body[0];
    const content = body.slice(1).join('\n').trim();

    if (!name || !content) {
      return ctx.reply('❌ Please provide both a name and message content. See `/addtemplate` for usage.', { parse_mode: 'Markdown' });
    }

    try {
      const t = await TemplateService.createTemplate(name, content, category, ctx.from.id);
      await ctx.reply(
        `✅ *Template Created*\n\n` +
        `📝 *${t.name}*\n` +
        `🏷 Category: ${category}\n\n` +
        `_Content preview:_\n${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // /deletetemplate <shortId>
  bot.command('deletetemplate', requireRole('MANAGER'), async (ctx) => {
    const shortId = ctx.message.text.split(/\s+/)[1];
    if (!shortId) return ctx.reply('Usage: `/deletetemplate <6-char-id>`\n\nGet IDs from /templates.', { parse_mode: 'Markdown' });

    const Template = require('../models/Template');
    const t = await Template.findOne({ _id: { $regex: shortId + '$' } }).catch(() => null);
    if (!t) return ctx.reply('❌ Template not found. Use `/templates` to see IDs.', { parse_mode: 'Markdown' });

    try {
      await TemplateService.deleteTemplate(t._id.toString(), ctx.from.id);
      await ctx.reply(`🗑 Template *"${t.name}"* deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Template picker inline handlers (used by adminOrders + support)
  // ════════════════════════════════════════════════════════════════════════════

  // tpl_pick:order:<orderId>  OR  tpl_pick:ticket:<ticketId>
  bot.action(/^tpl_pick:(\w+):(.+)$/, requireRole('STAFF'), async (ctx) => {
    await ctx.answerCbQuery();
    const contextType = ctx.match[1];
    const contextId   = ctx.match[2];
    const keyboard    = await TemplateService.buildTemplatePicker(contextType, contextId);
    await ctx.reply('📜 *Choose a Quick-Reply Template:*', {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  });

  // tpl_use:order:<orderId>:<templateId>  OR  tpl_use:ticket:<ticketId>:<templateId>
  bot.action(/^tpl_use:(\w+):([^:]+):([^:]+)$/, requireRole('STAFF'), async (ctx) => {
    await ctx.answerCbQuery('Sending…');
    const contextType = ctx.match[1];
    const contextId   = ctx.match[2];
    const templateId  = ctx.match[3];

    const template = await TemplateService.getTemplate(templateId);
    if (!template) return ctx.reply('❌ Template not found.');
    await TemplateService.incrementUsage(templateId);

    try {
      if (contextType === 'order') {
        const Order = require('../models/Order');
        const order = await Order.findById(contextId).populate('userId');
        if (!order) return ctx.reply('❌ Order not found.');

        const customerTid = order.userId?.telegramId;
        if (!customerTid) return ctx.reply('❌ Could not find customer Telegram ID.');

        await ctx.telegram.sendMessage(
          customerTid,
          `💬 *Message from Mental Gaming Store*\n\n${template.content}\n\n` +
          `_Re: Order \`${contextId.slice(-8).toUpperCase()}\`_`,
          { parse_mode: 'Markdown' }
        );

        await auditLog(ctx.from.id, 'TEMPLATE_USED', templateId, 'System', {
          contextType, contextId, name: template.name,
        });
        await ctx.reply(
          `✅ Template *"${template.name}"* sent to customer.`,
          { parse_mode: 'Markdown' }
        );

      } else if (contextType === 'ticket') {
        const SupportTicket = require('../models/SupportTicket');
        const ticket = await SupportTicket.findOne({ ticketId: contextId });
        if (!ticket) return ctx.reply('❌ Ticket not found.');

        await SupportTicket.findOneAndUpdate(
          { ticketId: contextId },
          {
            $push: { replies: { from: 'admin', message: template.content } },
            status: 'InProgress',
          }
        );

        await ctx.telegram.sendMessage(
          ticket.telegramId,
          `💬 *Support Reply* — Ticket \`${contextId}\`\n\n${template.content}\n\n` +
          `_To reply, create a new message via /support._`,
          { parse_mode: 'Markdown' }
        );

        await auditLog(ctx.from.id, 'TEMPLATE_USED', templateId, 'System', {
          contextType, contextId, name: template.name,
        });
        await ctx.reply(
          `✅ Template *"${template.name}"* sent to user.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await ctx.reply(`❌ Failed to send template: ${err.message}`);
    }
  });

  // tpl_cancel:<contextType>:<contextId>
  bot.action(/^tpl_cancel:(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.deleteMessage().catch(() => {});
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Real-time Pulse (OWNER only)
  // ════════════════════════════════════════════════════════════════════════════

  bot.command('pulse', adminOnly(), async (ctx) => {
    const msg = await ctx.reply('📡 Gathering system data…');

    try {
      const pingStart = Date.now();
      await ctx.telegram.getMe();
      const latency = Date.now() - pingStart;

      const User         = require('../models/User');
      const Order        = require('../models/Order');
      const SupportTicket = require('../models/SupportTicket');

      const oneHourAgo = new Date(Date.now() - 3_600_000);

      const [activeUsers, pendingOrders, openTickets, totalUsers, status] = await Promise.all([
        User.countDocuments({ updatedAt: { $gte: oneHourAgo } }),
        Order.countDocuments({ status: 'Pending' }),
        SupportTicket.countDocuments({ status: { $in: ['Open', 'InProgress'] } }),
        User.countDocuments({}),
        SystemStatus.get(),
      ]);

      const uptimeSec = Math.floor(process.uptime());
      const modeText  =
        status.maintenanceMode ? '🔧 Maintenance' :
        status.holidayMode     ? '🎉 Holiday' : '🟢 Normal';

      const latencyIcon =
        latency < 150 ? '🟢' : latency < 400 ? '🟡' : '🔴';

      const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });

      const text =
        `📡 *System Pulse*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `⏰ Uptime: *${fmtUptime(uptimeSec)}*\n` +
        `${latencyIcon} Telegram API: *${latency}ms*\n` +
        `\`──────────────────────\`\n` +
        `👥 Active Users (1h): *${activeUsers}*\n` +
        `📊 Total Users: *${totalUsers}*\n` +
        `📦 Pending Orders: *${pendingOrders}*\n` +
        `🎫 Open Tickets: *${openTickets}*\n` +
        `\`──────────────────────\`\n` +
        `🗃 MongoDB: *Connected*\n` +
        `🔧 Bot Mode: *${modeText}*\n` +
        `📅 *${now} MMT*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\``;

      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'pulse_refresh')]]),
      });

    } catch (err) {
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, `❌ Pulse error: ${err.message}`);
    }
  });

  bot.action('pulse_refresh', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Refreshing…');

    try {
      const pingStart = Date.now();
      await ctx.telegram.getMe();
      const latency = Date.now() - pingStart;

      const User          = require('../models/User');
      const Order         = require('../models/Order');
      const SupportTicket = require('../models/SupportTicket');
      const oneHourAgo    = new Date(Date.now() - 3_600_000);

      const [activeUsers, pendingOrders, openTickets, totalUsers, status] = await Promise.all([
        User.countDocuments({ updatedAt: { $gte: oneHourAgo } }),
        Order.countDocuments({ status: 'Pending' }),
        SupportTicket.countDocuments({ status: { $in: ['Open', 'InProgress'] } }),
        User.countDocuments({}),
        SystemStatus.get(),
      ]);

      const uptimeSec = Math.floor(process.uptime());
      const modeText  =
        status.maintenanceMode ? '🔧 Maintenance' :
        status.holidayMode     ? '🎉 Holiday' : '🟢 Normal';
      const latencyIcon =
        latency < 150 ? '🟢' : latency < 400 ? '🟡' : '🔴';
      const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });

      const text =
        `📡 *System Pulse*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `⏰ Uptime: *${fmtUptime(uptimeSec)}*\n` +
        `${latencyIcon} Telegram API: *${latency}ms*\n` +
        `\`──────────────────────\`\n` +
        `👥 Active Users (1h): *${activeUsers}*\n` +
        `📊 Total Users: *${totalUsers}*\n` +
        `📦 Pending Orders: *${pendingOrders}*\n` +
        `🎫 Open Tickets: *${openTickets}*\n` +
        `\`──────────────────────\`\n` +
        `🗃 MongoDB: *Connected*\n` +
        `🔧 Bot Mode: *${modeText}*\n` +
        `📅 *${now} MMT*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\``;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'pulse_refresh')]]),
      });
    } catch (err) {
      await ctx.answerCbQuery(`Error: ${err.message}`, { show_alert: true });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Audit Log viewer (OWNER only)
  // ════════════════════════════════════════════════════════════════════════════

  // /auditlog [limit=15]
  bot.command('auditlog', adminOnly(), async (ctx) => {
    const n       = parseInt(ctx.message.text.split(/\s+/)[1], 10) || 15;
    const limit   = Math.min(n, 50);
    const entries = await AuditLog.find({}).sort({ timestamp: -1 }).limit(limit);

    if (!entries.length) return ctx.reply('📋 No audit log entries yet.');

    const lines = entries.map((e) => {
      const ts  = new Date(e.timestamp).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });
      const det = Object.keys(e.details || {}).length
        ? ` — ${JSON.stringify(e.details).slice(0, 60)}`
        : '';
      return `\`${ts}\` *${e.action}*\n  by \`${e.adminId}\` on ${e.targetType}${e.targetId ? ` \`${e.targetId.slice(-8)}\`` : ''}${det}`;
    });

    await ctx.reply(
      `📋 *Audit Log (last ${entries.length})*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' }
    );
  });
};
