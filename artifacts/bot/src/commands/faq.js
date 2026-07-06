/**
 * FAQ Commands
 *
 * User:
 *   /faq              — browse by category
 *   /faq <query>      — search FAQs (e.g. /faq how to topup)
 *
 * Admin (MANAGER+):
 *   /addfaq           — multi-step add wizard
 *   /deletefaq <id>   — deactivate a FAQ
 *   /listfaqs         — list all FAQs with IDs
 */

const { Markup } = require('telegraf');
const { requireRole } = require('../middlewares/adminCheck');
const {
  search,
  getByCategory,
  getById,
  incrementView,
  create,
  remove,
  listAll,
} = require('../services/FAQService');
const { auditLog } = require('../services/logger');
const FAQ = require('../models/FAQ');

const CATEGORY_META = {
  general: { label: '❓ General',         emoji: '❓' },
  order:   { label: '📦 Orders',          emoji: '📦' },
  payment: { label: '💳 Payment & Wallet', emoji: '💳' },
  game:    { label: '🎮 Game Help',        emoji: '🎮' },
  account: { label: '👤 Account & Tier',   emoji: '👤' },
  promo:   { label: '🎟 Promo & Discounts',emoji: '🎟' },
};

// ── Result renderer ────────────────────────────────────────────────────────────

function buildResultCard(faq, index) {
  return (
    `${index + 1}. *${faq.question}*\n` +
    `\`${faq.faqId}\` — ${CATEGORY_META[faq.category]?.emoji || '❓'} ${faq.category}`
  );
}

function faqDetailKeyboard(faq) {
  const buttons = [];
  if (faq.videoId) {
    if (faq.videoType === 'url') {
      buttons.push([Markup.button.url('🎬 Watch Video', faq.videoId)]);
    } else {
      buttons.push([Markup.button.callback('🎬 Watch Video', `faq_video:${faq.faqId}`)]);
    }
  }
  buttons.push([Markup.button.callback('🔙 Back to Search', 'faq_back_search')]);
  return Markup.inlineKeyboard(buttons);
}

// ── Module ─────────────────────────────────────────────────────────────────────

module.exports = function registerFAQ(bot) {

  // ── /faq [query] ─────────────────────────────────────────────────────────────

  const faqMenuHandler = async (ctx) => {
    // Show category browser
    await ctx.reply(
      `📚 *FAQ & Help Center*\n\n` +
      `Choose a category or type your question:\n` +
      `_e.g. /faq how to topup_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📦 Orders',           'faq_cat:order'),
            Markup.button.callback('💳 Payments',          'faq_cat:payment'),
          ],
          [
            Markup.button.callback('🎮 Game Help',         'faq_cat:game'),
            Markup.button.callback('👤 Account & Tier',    'faq_cat:account'),
          ],
          [
            Markup.button.callback('🎟 Promos',            'faq_cat:promo'),
            Markup.button.callback('❓ General',            'faq_cat:general'),
          ],
          [Markup.button.callback('🔍 Search FAQ', 'faq_search_prompt')],
        ]),
      }
    );
  };

  bot.command('faq', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (args) return showSearchResults(ctx, args);
    return faqMenuHandler(ctx);
  });

  bot.hears(['❓ FAQ', '❓ မေးခွန်းများ'], faqMenuHandler);

  // ── Category browse ───────────────────────────────────────────────────────────

  bot.action(/^faq_cat:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const category = ctx.match[1];
    const meta = CATEGORY_META[category] || { label: category, emoji: '❓' };

    const faqs = await getByCategory(category);
    if (!faqs.length) {
      return ctx.editMessageText(
        `${meta.emoji} *${meta.label}*\n\nNo FAQs in this category yet.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'faq_back_home')]]),
        }
      );
    }

    const buttons = faqs.map((f) => [Markup.button.callback(
      `${f.videoId ? '🎬 ' : ''}${f.question.slice(0, 50)}`,
      `faq_view:${f.faqId}`
    )]);
    buttons.push([Markup.button.callback('🔙 Back', 'faq_back_home')]);

    await ctx.editMessageText(
      `${meta.emoji} *${meta.label}* (${faqs.length} FAQs)`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  // ── View a FAQ ────────────────────────────────────────────────────────────────

  bot.action(/^faq_view:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const faqId = ctx.match[1];

    const faq = await getById(faqId);
    if (!faq) return ctx.reply('❌ FAQ not found.');

    await incrementView(faqId);

    await ctx.reply(
      `❓ *${faq.question}*\n\n${faq.answer}\n\n` +
      (faq.tags.length ? `_Tags: ${faq.tags.join(', ')}_` : ''),
      { parse_mode: 'Markdown', ...faqDetailKeyboard(faq) }
    );
  });

  // ── Play video tutorial (Telegram video file_id) ──────────────────────────────

  bot.action(/^faq_video:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Loading video...');
    const faqId = ctx.match[1];

    const faq = await getById(faqId);
    if (!faq || !faq.videoId) return ctx.reply('❌ Video not available.');

    try {
      await ctx.replyWithVideo(faq.videoId, {
        caption: faq.videoCaption || faq.question,
      });
    } catch {
      // File may no longer be valid — send as URL fallback
      await ctx.reply(`🎬 Video: ${faq.videoId}`);
    }
  });

  // ── Search prompt ─────────────────────────────────────────────────────────────

  bot.action('faq_search_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.faqAwaitingSearch = true;
    await ctx.reply(
      `🔍 *FAQ Search*\n\nType your question or keyword:`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── Back buttons ──────────────────────────────────────────────────────────────

  bot.action('faq_back_home', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📚 *FAQ & Help Center*\n\nChoose a category or type your question:\n_e.g. /faq how to topup_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📦 Orders',        'faq_cat:order'),
            Markup.button.callback('💳 Payments',       'faq_cat:payment'),
          ],
          [
            Markup.button.callback('🎮 Game Help',      'faq_cat:game'),
            Markup.button.callback('👤 Account & Tier', 'faq_cat:account'),
          ],
          [
            Markup.button.callback('🎟 Promos',         'faq_cat:promo'),
            Markup.button.callback('❓ General',         'faq_cat:general'),
          ],
          [Markup.button.callback('🔍 Search FAQ', 'faq_search_prompt')],
        ]),
      }
    );
  });

  bot.action('faq_back_search', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.faqAwaitingSearch = true;
    await ctx.reply(
      `🔍 Type your search query:`,
      { ...Markup.forceReply() }
    );
  });

  // ── Text interceptor: FAQ search ─────────────────────────────────────────────

  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.faqAwaitingSearch) return next();
    if (ctx.message?.text?.startsWith('/')) return next();
    ctx.session.faqAwaitingSearch = false;
    return showSearchResults(ctx, ctx.message.text);
  });

  // ── Admin: /addfaq ────────────────────────────────────────────────────────────

  bot.command('addfaq', requireRole('MANAGER'), async (ctx) => {
    ctx.session.addFaq = { step: 'question' };
    await ctx.reply(
      `➕ *Add New FAQ*\n\nStep 1/4: Enter the *question*:`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.addFaq;
    if (!state) return next();

    const input = ctx.message.text.trim();

    if (state.step === 'question') {
      state.question = input;
      state.step     = 'answer';
      await ctx.reply(
        `✅ Question: _${input}_\n\nStep 2/4: Enter the *answer*:`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    } else if (state.step === 'answer') {
      state.answer = input;
      state.step   = 'tags';
      await ctx.reply(
        `Step 3/4: Enter *tags* (comma-separated) or type \`skip\`:\n_e.g. topup, wallet, kpay_`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    } else if (state.step === 'tags') {
      state.tags = input.toLowerCase() === 'skip' ? [] : input.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      state.step = 'category';
      await ctx.reply(
        `Step 4/4: Choose *category*:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📦 Order',   'addfaq_cat:order'),
              Markup.button.callback('💳 Payment',  'addfaq_cat:payment'),
            ],
            [
              Markup.button.callback('🎮 Game',    'addfaq_cat:game'),
              Markup.button.callback('👤 Account', 'addfaq_cat:account'),
            ],
            [
              Markup.button.callback('🎟 Promo',   'addfaq_cat:promo'),
              Markup.button.callback('❓ General', 'addfaq_cat:general'),
            ],
          ]),
        }
      );
    }
  });

  bot.action(/^addfaq_cat:(\w+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.session?.addFaq;
    if (!state) return;

    state.category = ctx.match[1];
    ctx.session.addFaq = null;

    const faq = await create({
      question: state.question,
      answer:   state.answer,
      tags:     state.tags || [],
      category: state.category,
      addedBy:  ctx.from.id,
    });

    await auditLog(ctx.from.id, 'FAQ_CREATED', faq.faqId, 'System', { question: faq.question });

    await ctx.reply(
      `✅ *FAQ Added!*\n\n` +
      `🆔 ID: \`${faq.faqId}\`\n` +
      `❓ Q: ${faq.question}\n` +
      `📂 Category: ${faq.category}\n\n` +
      `_To add a video tutorial, use /addfaqvideo ${faq.faqId} <file_id_or_url>_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /deletefaq <faqId> ─────────────────────────────────────────────────

  bot.command('deletefaq', requireRole('MANAGER'), async (ctx) => {
    const faqId = ctx.message.text.split(/\s+/)[1]?.toUpperCase();
    if (!faqId) return ctx.reply('Usage: /deletefaq FAQ-XXXX');

    const faq = await remove(faqId);
    if (!faq) return ctx.reply('❌ FAQ not found.');

    await auditLog(ctx.from.id, 'FAQ_DELETED', faqId, 'System', {});
    await ctx.reply(`✅ FAQ \`${faqId}\` deactivated.`, { parse_mode: 'Markdown' });
  });

  // ── Admin: /addfaqvideo <faqId> <videoId_or_url> ─────────────────────────────

  bot.command('addfaqvideo', requireRole('MANAGER'), async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    if (parts.length < 2) {
      return ctx.reply('Usage: /addfaqvideo FAQ-XXXX <telegram_file_id_or_url>');
    }

    const faqId   = parts[0].toUpperCase();
    const videoId = parts[1];
    const type    = videoId.startsWith('http') ? 'url' : 'telegram';

    const faq = await require('../services/FAQService').update(faqId, { videoId, videoType: type });
    if (!faq) return ctx.reply('❌ FAQ not found.');

    await ctx.reply(
      `✅ Video added to \`${faqId}\`\n` +
      `Type: *${type}* | ID/URL: \`${videoId}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /listfaqs ──────────────────────────────────────────────────────────

  bot.command('listfaqs', requireRole('MANAGER'), async (ctx) => {
    const faqs = await listAll();
    if (!faqs.length) return ctx.reply('No FAQs yet. Use /addfaq to add one.');

    const lines = faqs.map((f) =>
      `\`${f.faqId}\` ${f.videoId ? '🎬' : '📝'} [${f.category}] ${f.question.slice(0, 50)} — 👁 ${f.viewCount}`
    );

    // Send in chunks (Telegram 4096 char limit)
    const chunks = [];
    let cur = `📚 *All FAQs (${faqs.length})*\n\n`;
    for (const line of lines) {
      if ((cur + line + '\n').length > 3800) {
        chunks.push(cur);
        cur = '';
      }
      cur += line + '\n';
    }
    if (cur) chunks.push(cur);

    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' });
    }
  });
};

// ── Search results renderer (shared by command + text interceptor) ─────────────

async function showSearchResults(ctx, query) {
  const results = await search(query, 6);

  if (!results.length) {
    return ctx.reply(
      `🔍 No results for *"${query}"*\n\n` +
      `Try: /faq for categories, or /support for human help.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📚 Browse Categories', 'faq_back_home')],
          [Markup.button.callback('🎫 Open Support Ticket', 'support_ai_start')],
        ]),
      }
    );
  }

  const buttons = results.map((f) => [
    Markup.button.callback(
      `${f.videoId ? '🎬 ' : ''}${f.question.slice(0, 55)}`,
      `faq_view:${f.faqId}`
    ),
  ]);
  buttons.push([Markup.button.callback('🔙 Browse Categories', 'faq_back_home')]);

  await ctx.reply(
    `🔍 *Results for "${query}"* (${results.length} found)\n\nTap a question to read the answer:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}
