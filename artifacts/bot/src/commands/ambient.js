/**
 * Ambient AI Handler
 *
 * Catches non-command text messages sent outside any wizard scene.
 * Passes them through Gemini with conversation history (3-turn memory).
 *
 * Flow:
 *   User sends text → AI answers in ≤3 sentences
 *   If AI signals [OPEN_TICKET] → show [🎫 Open Support Ticket] button
 *   After each answer → show [🎫 Need more help?] button
 *
 * Skip conditions:
 *   - Message starts with / (command)
 *   - User is inside a Wizard scene (ctx.session.__scenes?.current)
 *   - Known admin session states active (ticket reply, topup reject, etc.)
 *   - User is blocked
 */

const { Markup }           = require('telegraf');
const { AI_ENABLED, answerAmbientQuery } = require('../services/aiService');

// How long a conversation history stays valid (30 minutes)
const HISTORY_TTL_MS = 30 * 60_000;
// Max turns to keep (each turn = 1 user + 1 model message)
const MAX_HISTORY_TURNS = 3;

// ── Admin session keys that should block ambient handler ─────────────────────
const ADMIN_SESSION_KEYS = [
  'adminTicketReply',
  'adminReplyToUser',
  'adminPendingTopupReject',
  'adminTopupAskInfo',
  'adminAddPayment',
  'exportAwaitingCustomRange',
  'addFaq',
  'faqAwaitingSearch',
  'awaitingReviewComment',
  'awaitingTicketScreenshot',
  // Product & game config wizards
  'adminAddProduct',
  'gcEdit',
  'catalogAction',
  'editProductField',
  'rm_manual_product',
];

// ── Typing simulation ─────────────────────────────────────────────────────────
async function showTyping(ctx) {
  const msg = await ctx.reply('🤖 _Thinking..._', { parse_mode: 'Markdown' });
  return { chatId: ctx.chat.id, messageId: msg.message_id };
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerAmbient(bot) {

  bot.on('text', async (ctx, next) => {
    // ── No-AI game update lookup (works even while AI is disabled) ─────────
    try {
      const q = ctx.message?.text;
      const inScene = ctx.session?.__scenes?.current;
      const adminBusy = ADMIN_SESSION_KEYS.some((k) => ctx.session?.[k]);
      if (q && !q.startsWith('/') && !inScene && !adminBusy && !ctx.from?.is_bot) {
        const { findPosts, sendPostsAsAnswers } = require('../services/GameNewsService');
        const posts = await findPosts(q, 3);
        if (posts.length) {
          await ctx.reply('📰 မေးခွန်းနဲ့ ကိုက်ညီတဲ့ အချက်အလက် တွေ့ပါတယ် —');
          const delivered = await sendPostsAsAnswers(ctx, posts);
          if (delivered) {
            await ctx.reply(
              'မူရင်း post ကို ကြည့်ချင်ရင် အပေါ်က 🔗 ခလုတ်လေး နှိပ်လို့ရပါတယ် ⬆️',
              Markup.inlineKeyboard([
                [Markup.button.callback('🎫 အကူအညီ ထပ်လိုရင်', 'support_ai_start')],
              ])
            );
            return;
          }
        }
      }
    } catch (e) {
      console.error('[Ambient] game news lookup failed:', e.message);
    }

    // ── AI ambient chat — only when a working key is configured ────────────
    if (!AI_ENABLED) return next();
    // ───────────────────────────────────────────────────────────────────────

    const text = ctx.message?.text;
    if (!text) return next();

    // Skip commands
    if (text.startsWith('/')) return next();

    // Skip if inside a wizard scene
    if (ctx.session?.__scenes?.current) return next();

    // Skip if any admin state is active
    for (const key of ADMIN_SESSION_KEYS) {
      if (ctx.session?.[key]) return next();
    }

    // Skip bots
    if (ctx.from?.is_bot) return next();

    // ── Build/restore conversation history ──────────────────────────────────
    const now  = Date.now();
    const hist = ctx.session?.chatHistory || [];
    const lastTs = ctx.session?.chatHistoryTs || 0;

    // Expire history after TTL
    const validHistory = (now - lastTs < HISTORY_TTL_MS) ? hist : [];

    // ── Ask AI ────────────────────────────────────────────────────────────────
    const thinkRef = await showTyping(ctx);

    const { answer, shouldOpenTicket } = await answerAmbientQuery(text, {
      telegramId: ctx.from?.id,
      history:    validHistory,
    });

    // Clean up typing indicator
    await ctx.telegram.deleteMessage(thinkRef.chatId, thinkRef.messageId).catch(() => {});

    if (!answer) {
      // AI unavailable — graceful fallback
      return ctx.reply(
        `🤖 I'm having trouble connecting right now.\n\nFor help, please use /faq or /support.`,
        {
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📚 Browse FAQ',          'faq_back_home')],
            [Markup.button.callback('🎫 Open Support Ticket', 'support_ai_start')],
          ]),
        }
      );
    }

    // ── Update conversation history ────────────────────────────────────────
    const newHistory = [
      ...validHistory,
      { role: 'user',  parts: [{ text }] },
      { role: 'model', parts: [{ text: answer }] },
    ].slice(-MAX_HISTORY_TURNS * 2); // keep last N turns

    ctx.session.chatHistory   = newHistory;
    ctx.session.chatHistoryTs = now;

    // ── Send response ──────────────────────────────────────────────────────
    const keyboard = shouldOpenTicket
      ? Markup.inlineKeyboard([
          [Markup.button.callback('🎫 Open Support Ticket', 'support_ai_start')],
          [Markup.button.callback('📚 Browse FAQ',           'faq_back_home')],
        ])
      : Markup.inlineKeyboard([
          [
            Markup.button.callback('🎫 Need more help?', 'support_ai_start'),
            Markup.button.callback('📚 FAQ',             'faq_back_home'),
          ],
        ]);

    await ctx.reply(`🤖 ${answer}`, { parse_mode: 'Markdown', ...keyboard });
  });
};
