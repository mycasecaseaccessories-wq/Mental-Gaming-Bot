/**
 * Channel Auto-Post admin commands
 *
 * /addchannelpost — guided wizard to create a scheduled post
 * /listchannelposts — show all configured posts
 * /togglechannelpost <id> — flip isActive
 * /delchannelpost <id> — delete a post
 * /sendchannelpost <id> — send one post immediately
 *
 * Owner-only.
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const ChannelAutoPost = require('../models/ChannelAutoPost');
const { sendOneNow } = require('../services/ChannelAutoPostService');
const { auditLog } = require('../services/logger');

function fmtTime(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} MMT`;
}

// Escape Markdown (Telegram legacy mode) for admin-supplied strings shown in replies.
function mdEsc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}

module.exports = function registerChannelAutoPost(bot) {

  // ── /addchannelpost ────────────────────────────────────────────────────────
  bot.command('addchannelpost', adminOnly(), async (ctx) => {
    ctx.session.cap = { step: 'channel' };
    await ctx.reply(
      `📣 *Add Channel Auto-Post*\n\n` +
      `Step 1/5: Send the *channel ID* (e.g. \`-1001234567890\`) or \`@username\`.\n\n` +
      `_The bot must be an admin in that channel with permission to post._`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── /listchannelposts ──────────────────────────────────────────────────────
  bot.command('listchannelposts', adminOnly(), async (ctx) => {
    const posts = await ChannelAutoPost.find().sort({ scheduledHour: 1, scheduledMinute: 1 });
    if (!posts.length) {
      return ctx.reply('📣 No channel auto-posts configured.\n\nUse /addchannelpost to add one.');
    }
    const lines = posts.map((p, i) => {
      const status = p.isActive ? '🟢' : '🔴';
      const preview = (p.title || p.body).slice(0, 40).replace(/[*_`\[\]]/g, '');
      const label = mdEsc(p.channelLabel || p.channelId);
      return (
        `${i + 1}. ${status} *${label}* — ${fmtTime(p.scheduledHour, p.scheduledMinute)}\n` +
        `   _${mdEsc(preview)}…_\n` +
        `   id: \`${p._id}\` | sent ${p.sendCount}× ${p.lastSentAt ? `(last ${new Date(p.lastSentAt).toLocaleDateString('en-GB')})` : ''}`
      );
    });
    await ctx.reply(`📣 *Channel Auto-Posts (${posts.length})*\n\n${lines.join('\n\n')}`, {
      parse_mode: 'Markdown',
    });
  });

  // ── /togglechannelpost <id> ────────────────────────────────────────────────
  bot.command('togglechannelpost', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: `/togglechannelpost <id>`', { parse_mode: 'Markdown' });
    const p = await ChannelAutoPost.findById(id).catch(() => null);
    if (!p) return ctx.reply('❌ Post not found.');
    p.isActive = !p.isActive;
    await p.save();
    await auditLog(ctx.from.id, 'CHANNEL_POST_TOGGLE', id, 'ChannelAutoPost', { active: p.isActive });
    await ctx.reply(`${p.isActive ? '🟢 Activated' : '🔴 Deactivated'}: *${mdEsc(p.channelLabel || p.channelId)}*`, { parse_mode: 'Markdown' });
  });

  // ── /delchannelpost <id> ───────────────────────────────────────────────────
  bot.command('delchannelpost', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: `/delchannelpost <id>`', { parse_mode: 'Markdown' });
    const p = await ChannelAutoPost.findByIdAndDelete(id).catch(() => null);
    if (!p) return ctx.reply('❌ Post not found.');
    await auditLog(ctx.from.id, 'CHANNEL_POST_DELETE', id, 'ChannelAutoPost', { channelId: p.channelId });
    await ctx.reply(`🗑 Deleted post for *${mdEsc(p.channelLabel || p.channelId)}*.`, { parse_mode: 'Markdown' });
  });

  // ── /sendchannelpost <id> — fire immediately ───────────────────────────────
  bot.command('sendchannelpost', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: `/sendchannelpost <id>`', { parse_mode: 'Markdown' });
    try {
      const p = await sendOneNow(ctx.telegram, id);
      await auditLog(ctx.from.id, 'CHANNEL_POST_MANUAL_SEND', id, 'ChannelAutoPost', {});
      await ctx.reply(`✅ Sent to *${mdEsc(p.channelLabel || p.channelId)}*.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Send failed: ${err.message}`);
    }
  });

  // ── Wizard text handler ────────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const { config } = require('../../config/settings');
    if (Number(ctx.from?.id) !== Number(config.bot.adminId)) return next();
    if (ctx.message?.text?.startsWith('/')) return next();
    const st = ctx.session?.cap;
    if (!st) return next();

    const input = ctx.message.text.trim();

    if (st.step === 'channel') {
      ctx.session.cap = { ...st, step: 'label', channelId: input };
      return ctx.reply(`✅ Channel: \`${input}\`\n\nStep 2/5: Enter a *short label* for admin display (or \`skip\`):`, {
        parse_mode: 'Markdown', ...Markup.forceReply(),
      });
    }

    if (st.step === 'label') {
      ctx.session.cap = { ...st, step: 'title', channelLabel: input.toLowerCase() === 'skip' ? '' : input };
      return ctx.reply(`Step 3/5: Enter an optional *title* (bold header), or \`skip\`:`, {
        parse_mode: 'Markdown', ...Markup.forceReply(),
      });
    }

    if (st.step === 'title') {
      ctx.session.cap = { ...st, step: 'body', title: input.toLowerCase() === 'skip' ? '' : input };
      return ctx.reply(
        `Step 4/5: Send the *message body* (Markdown supported).\n\n` +
        `Tip: include a Shop link or call-to-action.`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    }

    if (st.step === 'body') {
      if (input.length < 5) return ctx.reply('❌ Body too short (min 5 chars).');
      ctx.session.cap = { ...st, step: 'time', body: input };
      return ctx.reply(
        `Step 5/5: Enter daily *send time* in MMT as \`HH:MM\` (24h).\n_Example: \`09:00\` or \`18:30\`._`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    }

    if (st.step === 'time') {
      const m = input.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return ctx.reply('❌ Format must be `HH:MM` (e.g. `09:00`).', { parse_mode: 'Markdown' });
      const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return ctx.reply('❌ Invalid time.');

      ctx.session.cap = null;
      let doc;
      try {
        doc = await ChannelAutoPost.create({
          channelId:       st.channelId,
          channelLabel:    st.channelLabel,
          title:           st.title,
          body:            st.body,
          scheduledHour:   hh,
          scheduledMinute: mm,
          isActive:        true,
          createdBy:       ctx.from.id,
        });
      } catch (err) {
        return ctx.reply(`❌ Create failed: ${err.message}`);
      }
      await auditLog(ctx.from.id, 'CHANNEL_POST_ADD', doc._id.toString(), 'ChannelAutoPost', {
        channelId: st.channelId, time: fmtTime(hh, mm),
      });
      // Confirmation reply — fall back to plain text if Markdown parsing fails so we
      // don't mislead the operator about a successful create.
      const confirmMd =
        `✅ *Channel Auto-Post Created!*\n\n` +
        `📣 Channel: \`${st.channelId}\`${st.channelLabel ? ` _(${mdEsc(st.channelLabel)})_` : ''}\n` +
        `🕒 Daily at: *${fmtTime(hh, mm)}*\n` +
        `🆔 \`${doc._id}\`\n\n` +
        `Use /sendchannelpost \`${doc._id}\` to send a test post immediately.`;
      try {
        return await ctx.reply(confirmMd, { parse_mode: 'Markdown' });
      } catch {
        return ctx.reply(
          `✅ Created channel auto-post.\nChannel: ${st.channelId}\nDaily at: ${fmtTime(hh, mm)}\nID: ${doc._id}`
        );
      }
    }

    return next();
  });
};
