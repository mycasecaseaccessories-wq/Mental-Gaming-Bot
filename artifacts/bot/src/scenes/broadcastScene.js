/**
 * Broadcast Scene — Admin-only
 *
 * Step 0 → Ask for message content (text, photo, or forward anything)
 * Step 1 → Show preview + recipient count + [✅ Send] [❌ Cancel]
 * (Action confirm) → Send to all users in batches, show live progress
 */

const { Scenes, Markup } = require('telegraf');
const User = require('../models/User');
const { auditLog } = require('../services/logger');
const { config } = require('../../config/settings');

const BATCH_SIZE  = 25;
const BATCH_DELAY = 1100;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendToUser(ctx, telegramId, broadcastData) {
  try {
    if (broadcastData.type === 'text') {
      await ctx.telegram.sendMessage(telegramId, broadcastData.text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } else if (broadcastData.type === 'photo') {
      await ctx.telegram.sendPhoto(telegramId, broadcastData.fileId, {
        caption: broadcastData.caption || '',
        parse_mode: 'Markdown',
      });
    } else if (broadcastData.type === 'forward') {
      await ctx.telegram.forwardMessage(telegramId, broadcastData.fromChatId, broadcastData.messageId);
    }
    return true;
  } catch {
    return false;
  }
}

const broadcastScene = new Scenes.WizardScene(
  'broadcast_scene',

  // ── Step 0: Ask for message ───────────────────────────────────────────────
  async (ctx) => {
    const userCount = await User.countDocuments({ isBlocked: false });

    await ctx.reply(
      `📢 *Broadcast Message*\n\n` +
      `👥 Recipients: *${userCount} active users*\n\n` +
      `Send the message you want to broadcast:\n` +
      `• Plain text\n` +
      `• Photo with caption\n` +
      `• Forward any message\n\n` +
      `_Tip: Use Markdown formatting — *bold*, _italic_, \`code\`_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'broadcast_cancel')]]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Step 1: Capture message + show preview ─────────────────────────────────
  async (ctx) => {
    let broadcastData = null;
    const msg = ctx.message;

    if (msg?.text && !msg.text.startsWith('/')) {
      broadcastData = { type: 'text', text: msg.text };
    } else if (msg?.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      broadcastData = { type: 'photo', fileId, caption: msg.caption || '' };
    } else if (msg?.forward_from || msg?.forward_from_chat) {
      broadcastData = {
        type: 'forward',
        fromChatId: msg.chat.id,
        messageId: msg.message_id,
      };
    } else {
      return ctx.reply('📝 Please send a text message, a photo, or forward a message.');
    }

    ctx.session.broadcastData = broadcastData;
    const userCount = await User.countDocuments({ isBlocked: false });
    ctx.session.broadcastUserCount = userCount;

    await ctx.reply(
      `📋 *Preview*\n\n` +
      `Type: *${broadcastData.type}*\n` +
      `Recipients: *${userCount} users*\n\n` +
      `_This message will be sent to all active users. Ready?_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Send to ${userCount} users`, 'broadcast_confirm')],
          [Markup.button.callback('❌ Cancel', 'broadcast_cancel')],
        ]),
      }
    );

    return ctx.wizard.next();
  },

  // ── Step 2: Placeholder — actual send happens via action ───────────────────
  async (ctx) => ctx.scene.leave()
);

// ── Action: Confirm send ───────────────────────────────────────────────────────
broadcastScene.action('broadcast_confirm', async (ctx) => {
  await ctx.answerCbQuery('Starting broadcast...');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const data      = ctx.session.broadcastData;
  const total     = ctx.session.broadcastUserCount || 0;

  if (!data) {
    await ctx.reply('❌ Session expired. Start again with /broadcast');
    return ctx.scene.leave();
  }

  // Progress message
  const progressMsg = await ctx.reply(
    `📡 *Broadcasting...*\n\n` +
    `📤 Sent: 0 / ${total}\n` +
    `❌ Failed: 0\n` +
    `⏳ Progress: 0%`
  );
  const progressRef = { chatId: progressMsg.chat.id, messageId: progressMsg.message_id };

  let sent = 0, failed = 0;

  // Stream users from DB to avoid memory issues
  const users = await User.find({ isBlocked: false }).select('telegramId').lean();

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (u) => {
        if (u.telegramId === config.bot.adminId) return;
        const ok = await sendToUser(ctx, u.telegramId, data);
        ok ? sent++ : failed++;
      })
    );

    // Update progress every batch
    const pct = Math.round(((sent + failed) / total) * 100);
    await ctx.telegram.editMessageText(
      progressRef.chatId,
      progressRef.messageId,
      undefined,
      `📡 *Broadcasting...*\n\n` +
      `📤 Sent: ${sent} / ${total}\n` +
      `❌ Failed: ${failed}\n` +
      `⏳ Progress: ${pct}%\n` +
      `${'█'.repeat(Math.floor(pct / 5))}${'░'.repeat(20 - Math.floor(pct / 5))} ${pct}%`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    if (i + BATCH_SIZE < users.length) await sleep(BATCH_DELAY);
  }

  await ctx.telegram.editMessageText(
    progressRef.chatId,
    progressRef.messageId,
    undefined,
    `✅ *Broadcast Complete!*\n\n` +
    `📤 Successfully sent: *${sent}*\n` +
    `❌ Failed (blocked/etc): *${failed}*\n` +
    `📊 Total: *${sent + failed}/${total}*`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  await auditLog(ctx.from.id, 'BROADCAST', null, 'System', { sent, failed, total, type: data.type });

  ctx.session.broadcastData = null;
  return ctx.scene.leave();
});

// ── Action: Cancel ─────────────────────────────────────────────────────────────
broadcastScene.action('broadcast_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Broadcast cancelled.');
  ctx.session.broadcastData = null;
  return ctx.scene.leave();
});

module.exports = broadcastScene;
