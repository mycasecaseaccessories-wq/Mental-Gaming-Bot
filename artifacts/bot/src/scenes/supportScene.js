/**
 * SupportScene — customer support wizard (AI or no-AI mode via AI_ENABLED)
 *
 * Step 0 → Topic selection
 * Step 1 → User types question →
 *   AI mode:    AI generates instant answer (with "thinking" animation)
 *   no-AI mode: direct game-news lookup answers if matched; else straight to ticket
 * Step 2 → Show answer → [✅ Solved!] [❌ Need human help]
 *   ✅ → Thank user + mark resolved
 *   ❌ → Ask for optional screenshot → Create SupportTicket → Notify admin → Ticket ID to user
 *
 * Auto-escalation:
 *   - AI signals [ESCALATE] → skip to human automatically
 *   - High frustration detected → priority = Urgent
 *
 * Screenshot upload:
 *   - After "Need human help" → ask user to optionally attach screenshot
 *   - Session flag `awaitingTicketScreenshot` handled via photo interceptor in support.js
 */

const { Scenes, Markup } = require('telegraf');
const { AI_ENABLED, answerSupportQuery, analyzeSentiment } = require('../services/aiService');
const { findPosts, sendPostsAsAnswers } = require('../services/GameNewsService');
const { config } = require('../../config/settings');
const { price, formatDate } = require('../utils/ui');
const SupportTicket = require('../models/SupportTicket');
const User  = require('../models/User');
const Order = require('../models/Order');

const TOPIC_META = {
  order:   { label: '📦 Order Issue',      emoji: '📦', priority: 'High'   },
  payment: { label: '💳 Payment / Wallet', emoji: '💳', priority: 'High'   },
  game:    { label: '🎮 Game Help',        emoji: '🎮', priority: 'Normal' },
  bug:     { label: '🐛 Bug Report',       emoji: '🐛', priority: 'Urgent' },
  general: { label: '❓ General Query',    emoji: '❓', priority: 'Normal' },
};

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Admin direct-contact button (t.me link) ──────────────────────────────────
// Priority: SystemStatus.supportContactUsername (set via /setsupportcontact)
// → fallback: owner account's own username (auto via getChat, cached 10 min)
let adminContactCache = null; // { username: string|null, at: number }

async function getAdminContactRow(ctx) {
  let username = null;

  try {
    const SystemStatus = require('../models/SystemStatus');
    const st = await SystemStatus.get();
    if (st.supportContactUsername) username = st.supportContactUsername;
  } catch (e) {
    console.error('[SupportScene] SystemStatus read failed:', e.message);
  }

  if (!username) {
    const TTL = 10 * 60 * 1000;
    if (!adminContactCache || Date.now() - adminContactCache.at > TTL) {
      let auto = null;
      try {
        const chat = await ctx.telegram.getChat(config.bot.adminId);
        auto = chat.username || null;
      } catch (e) {
        console.error('[SupportScene] getChat(admin) failed:', e.message);
      }
      adminContactCache = { username: auto, at: Date.now() };
    }
    username = adminContactCache.username;
  }

  if (!username) return [];
  return [
    [Markup.button.url('📨 Admin ကို တိုက်ရိုက် စာပို့ရန်', `https://t.me/${username}`)],
  ];
}

// ── Typing animation ──────────────────────────────────────────────────────────
async function showThinking(ctx) {
  const msg = await ctx.reply('🤖 _AI is thinking..._', { parse_mode: 'Markdown' });
  const frames = ['🤖 .  ', '🤖 .. ', '🤖 ...'];
  for (let i = 0; i < 3; i++) {
    await sleep(600);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, frames[i]).catch(() => {});
  }
  return { chatId: ctx.chat.id, messageId: msg.message_id };
}

// ── Admin ticket notification ─────────────────────────────────────────────────
async function notifyAdminNewTicket(ctx, ticket, user) {
  const topicMeta     = TOPIC_META[ticket.topic] || TOPIC_META.general;
  const userTag       = user.username ? `@${user.username}` : `ID: ${ticket.telegramId}`;
  const priorityBadge = { Normal: '🟡', High: '🟠', Urgent: '🔴' }[ticket.priority] || '🟡';
  const hasScreenshot = ticket.screenshots?.length > 0;

  const text =
    `📩 *New Support Ticket*\n\n` +
    `🎫 Ticket: \`${ticket.ticketId}\`\n` +
    `${priorityBadge} Priority: *${ticket.priority}*\n` +
    `${topicMeta.emoji} Topic: *${topicMeta.label}*\n` +
    `👤 User: ${userTag}\n` +
    `⭐ Tier: ${user.membershipTier}\n` +
    `${hasScreenshot ? '📎 Screenshot: Attached\n' : ''}` +
    `🕐 Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT\n\n` +
    `*User Message:*\n${ticket.userMessage}\n\n` +
    (ticket.aiResponse
      ? `*AI Attempted Response:*\n_${ticket.aiResponse.slice(0, 200)}${ticket.aiResponse.length > 200 ? '...' : ''}_\n\n` +
        `_User said AI answer was not helpful — needs human support._`
      : `_Needs human support._`);

  try {
    await ctx.telegram.sendMessage(config.bot.adminId, text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`💬 Reply`,          `ticket_reply:${ticket.ticketId}`),
          Markup.button.callback(`📜 Template`,       `tpl_pick:ticket:${ticket.ticketId}`),
        ],
        [
          Markup.button.callback('✅ Mark Resolved',  `ticket_resolve:${ticket.ticketId}`),
          Markup.button.callback('🔵 Assign to Me',   `ticket_assign:${ticket.ticketId}`),
        ],
        [Markup.button.callback('🔴 Mark Urgent',     `ticket_urgent:${ticket.ticketId}`)],
      ]),
    });

    // If there's a screenshot — forward it too
    if (hasScreenshot) {
      for (const fileId of ticket.screenshots) {
        await ctx.telegram.sendPhoto(config.bot.adminId, fileId, {
          caption: `📎 Screenshot for ticket \`${ticket.ticketId}\``,
          parse_mode: 'Markdown',
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SupportScene] Admin notify failed:', err.message);
  }
}

const supportScene = new Scenes.WizardScene(
  'support_scene',

  // ── Step 0: Topic selection ──────────────────────────────────────────────
  async (ctx) => {
    const adminRow = await getAdminContactRow(ctx);
    await ctx.reply(
      `💬 *Customer Support*\n\n` +
      (AI_ENABLED
        ? `🤖 Our AI assistant will try to help you instantly.\nIf it can't solve your issue, we'll connect you with a human.\n\n`
        : `📩 Describe your issue and our team will help you.\nGame update questions get answered instantly from our news channel.\n\n`) +
      `*What do you need help with?*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📦 Order Issue',      'sup_topic:order'),
            Markup.button.callback('💳 Payment / Wallet', 'sup_topic:payment'),
          ],
          [
            Markup.button.callback('🎮 Game Help',        'sup_topic:game'),
            Markup.button.callback('🐛 Bug Report',       'sup_topic:bug'),
          ],
          [
            Markup.button.callback('❓ General Query',    'sup_topic:general'),
            Markup.button.callback('❌ Cancel',           'sup_cancel'),
          ],
          ...adminRow,
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Step 1: Await question text ──────────────────────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;

    const topic   = ctx.session.supportTopic || 'general';
    const message = ctx.message.text.trim();
    ctx.session.supportUserMessage = message;

    // ── No-AI path ──────────────────────────────────────────────────────────
    if (!AI_ENABLED) {
      // 1) Try a direct game-news lookup (zero cost, no AI)
      try {
        const posts = await findPosts(message, 3);
        if (posts.length) {
          ctx.session.supportAiResponse = null;
          ctx.session.supportSentiment  = 'neutral';

          await ctx.reply(`📰 မေးခွန်းနဲ့ ကိုက်ညီတဲ့ အချက်အလက် တွေ့ပါတယ် —`);
          const delivered = await sendPostsAsAnswers(ctx, posts);
          if (delivered) {
            await ctx.reply(
              `Was this helpful?`,
              Markup.inlineKeyboard([
                [Markup.button.callback('✅ Yes, solved!',        'sup_solved')],
                [Markup.button.callback('❌ No, need human help', 'sup_escalate')],
              ])
            );
            return ctx.wizard.next();
          }
        }
      } catch (e) {
        console.error('[SupportScene] game news lookup failed:', e.message);
      }

      // 2) No match — go straight to the team (no fake AI animation)
      ctx.session.supportAiResponse = null;
      ctx.session.supportSentiment  = 'neutral';
      await ctx.reply(`📩 _Connecting you with our support team..._`, { parse_mode: 'Markdown' });
      return askForScreenshot(ctx);
    }

    const thinkRef = await showThinking(ctx);

    // Run AI + sentiment in parallel
    const [aiResult, sentiment] = await Promise.all([
      answerSupportQuery(message, { telegramId: ctx.from.id, topic }),
      analyzeSentiment(message),
    ]);

    ctx.session.supportAiResponse    = aiResult.answer;
    ctx.session.supportShouldEscalate = aiResult.shouldEscalate;
    ctx.session.supportSentiment     = sentiment;

    const topicMeta = TOPIC_META[topic] || TOPIC_META.general;

    // If AI signals escalation → skip straight to human
    if (aiResult.shouldEscalate || !aiResult.answer) {
      await ctx.telegram.editMessageText(
        thinkRef.chatId, thinkRef.messageId, undefined,
        `🤖 _Let me connect you with our support team..._`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

      await sleep(800);
      return askForScreenshot(ctx);
    }

    // Show AI answer
    const sentimentNote = ['frustrated', 'angry'].includes(sentiment)
      ? `\n\n_I can see you're frustrated — if this doesn't help, I'll connect you with a human right away._`
      : '';

    await ctx.telegram.editMessageText(
      thinkRef.chatId, thinkRef.messageId, undefined,
      `🤖 *AI Assistant*\n\n${aiResult.answer}${sentimentNote}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    await ctx.reply(
      `Was this helpful?`,
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, solved!',        'sup_solved')],
          [Markup.button.callback('❌ No, need human help', 'sup_escalate')],
        ]),
      }
    );

    return ctx.wizard.next();
  },

  // ── Step 2: Placeholder — handled by actions ──────────────────────────────
  async (ctx) => ctx.scene.leave()
);

// ── Action: topic selected ────────────────────────────────────────────────────
supportScene.action(/^sup_topic:(.+)$/, async (ctx) => {
  const topic = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  ctx.session.supportTopic = topic;
  const topicMeta = TOPIC_META[topic] || TOPIC_META.general;

  const hint = {
    order:   'Include your Order ID if you have one (from /orders).',
    payment: 'Include the amount, payment method, and date.',
    game:    'Tell us which game and what you need help with.',
    bug:     'Describe what happened step by step.',
    general: 'Ask anything about our store or services.',
  }[topic] || '';

  await ctx.reply(
    `${topicMeta.emoji} *${topicMeta.label}*\n\n` +
    `Please describe your issue:\n_${hint}_`,
    { parse_mode: 'Markdown' }
  );

  ctx.wizard.selectStep(1);
});

// ── Action: user says solved ──────────────────────────────────────────────────
supportScene.action('sup_solved', async (ctx) => {
  await ctx.answerCbQuery('Great!');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  await ctx.reply(
    `✅ *Glad we could help!*\n\n` +
    `If you have more questions, use /support anytime.\n\n` +
    `_Thank you for choosing Mental Gaming Store! 🎮_`,
    { parse_mode: 'Markdown' }
  );

  clearSupportSession(ctx);
  return ctx.scene.leave();
});

// ── Action: escalate to human → ask for screenshot first ─────────────────────
supportScene.action('sup_escalate', async (ctx) => {
  await ctx.answerCbQuery('Connecting you with our team...');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  return askForScreenshot(ctx);
});

// ── Ask for screenshot before creating ticket ─────────────────────────────────
async function askForScreenshot(ctx) {
  // Store pending ticket data
  ctx.session.pendingTicketData = {
    topic:      ctx.session.supportTopic || 'general',
    userMessage: ctx.session.supportUserMessage || '(not provided)',
    aiResponse:  ctx.session.supportAiResponse || null,
    sentiment:   ctx.session.supportSentiment  || 'neutral',
  };
  clearSupportSession(ctx);

  await ctx.reply(
    `📎 *Optional: Attach a Screenshot*\n\n` +
    `Would you like to send a screenshot to help our team understand your issue faster?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📎 Yes, I\'ll attach one', 'sup_attach_screenshot')],
        [Markup.button.callback('⏭️ Skip — Create Ticket Now', 'sup_skip_screenshot')],
      ]),
    }
  );

  return ctx.scene.leave();
}

// ── Action: will attach screenshot ────────────────────────────────────────────
supportScene.action('sup_attach_screenshot', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  ctx.session.awaitingTicketScreenshot = true;

  await ctx.reply(
    `📸 *Send your screenshot now.*\n\n` +
    `Send it as a *photo* (not a file).\n` +
    `You can also type /skip to create the ticket without a screenshot.`,
    { parse_mode: 'Markdown' }
  );
});

// ── Action: skip screenshot ───────────────────────────────────────────────────
supportScene.action('sup_skip_screenshot', async (ctx) => {
  await ctx.answerCbQuery('Creating your ticket...');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  ctx.session.awaitingTicketScreenshot = false;
  return createTicketFromSession(ctx, []);
});

// ── Action: cancel ────────────────────────────────────────────────────────────
supportScene.action('sup_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Support session cancelled. Use /support anytime.');
  clearSupportSession(ctx);
  return ctx.scene.leave();
});

// ── Create ticket from pending session data ───────────────────────────────────
async function createTicketFromSession(ctx, screenshots = []) {
  const data = ctx.session.pendingTicketData;
  if (!data) {
    await ctx.reply('❌ Session expired. Please use /support again.');
    return;
  }
  ctx.session.pendingTicketData = null;
  ctx.session.awaitingTicketScreenshot = false;

  return escalateToHuman(ctx, data.topic, data.userMessage, data.aiResponse, data.sentiment, screenshots);
}

// ── Escalation handler ────────────────────────────────────────────────────────
async function escalateToHuman(ctx, topic, userMessage, aiResponse, sentiment, screenshots = []) {
  const user = await User.findByTelegramId(ctx.from.id);
  if (!user) {
    await ctx.reply('❌ Session error. Please try /support again.');
    return;
  }

  const topicMeta = TOPIC_META[topic] || TOPIC_META.general;
  let priority = topicMeta.priority;
  if (['angry', 'frustrated'].includes(sentiment) && priority !== 'Urgent') priority = 'High';
  if (topic === 'bug') priority = 'Urgent';

  // Auto-extract subject from first sentence of userMessage
  const subject = userMessage.split(/[.!?\n]/)[0].slice(0, 80) || null;

  const ticketId = await SupportTicket.generateId();

  const ticket = await SupportTicket.create({
    ticketId,
    userId:      user._id,
    telegramId:  ctx.from.id,
    username:    ctx.from.username || null,
    subject,
    topic,
    userMessage,
    aiResponse,
    screenshots,
    status:      'Open',
    priority,
    replies:     [],
  });

  await notifyAdminNewTicket(ctx, ticket, user);

  const priorityBadge = { Normal: '🟡', High: '🟠', Urgent: '🔴' }[priority] || '🟡';

  await ctx.reply(
    `✅ *Support Ticket Created!*\n\n` +
    `🎫 Ticket ID: \`${ticketId}\`\n` +
    `${topicMeta.emoji} Topic: *${topicMeta.label}*\n` +
    `${priorityBadge} Priority: *${priority}*\n` +
    (screenshots.length ? `📎 Screenshot: *Attached*\n` : '') +
    `\n⏰ *Support hours: 9AM – 11PM MMT*\n\n` +
    `Our team will get back to you shortly.\n` +
    `_Save your Ticket ID to follow up with /mytickets_`,
    { parse_mode: 'Markdown' }
  );
}

// ── Session cleanup ───────────────────────────────────────────────────────────
function clearSupportSession(ctx) {
  ctx.session.supportTopic         = null;
  ctx.session.supportUserMessage   = null;
  ctx.session.supportAiResponse    = null;
  ctx.session.supportSentiment     = null;
  ctx.session.supportShouldEscalate = null;
}

// Export the createTicketFromSession helper for use in support.js photo handler
supportScene.createTicketFromSession = createTicketFromSession;

module.exports = supportScene;
