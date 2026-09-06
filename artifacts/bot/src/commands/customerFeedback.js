const { Markup } = require('telegraf');
const CustomerFeedback = require('../models/CustomerFeedback');
const User = require('../models/User');
const AdminService = require('../services/AdminService');
const { requirePermission } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { config } = require('../../config/settings');

const TYPE_META = {
  suggestion: { label: '💡 အကြံပြုစာ', thanks: 'အကြံပြုချက်ပေးပို့ပေးတဲ့အတွက် ကျေးဇူးတင်ပါတယ် ခင်ဗျာ 💡❤️' },
  feedback: { label: '❤️ Feedback', thanks: 'Feedback ပေးပို့ပေးတဲ့အတွက် ကျေးဇူးတင်ပါတယ် ခင်ဗျာ ❤️' },
};
const STATUS_META = { new: '🆕 New', read: '👀 Read', replied: '💬 Replied', resolved: '✅ Resolved' };
const MAX_MESSAGE_LENGTH = 4000;

function safeText(value, fallback = '—') {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return text || fallback;
}

function preview(value, length = 70) {
  const text = safeText(value, '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

async function canManage(ctx) {
  return AdminService.hasPermission(ctx.from?.id, 'support');
}

async function notifyAdmins(telegram, doc) {
  const adminIds = new Set([Number(config.bot.adminId)]);
  try {
    const admins = await AdminService.listAdmins();
    admins.forEach((admin) => adminIds.add(Number(admin.telegramId)));
  } catch (err) {
    console.error('[CustomerFeedback] admin lookup failed:', err.message);
  }

  const meta = TYPE_META[doc.type] || TYPE_META.feedback;
  const customer = doc.username ? `@${doc.username}` : (doc.firstName || `ID:${doc.telegramId}`);
  const context = [doc.categoryName, doc.subcategoryName, doc.productName].filter(Boolean).join(' › ') || 'General';
  const text = `🔔 New Customer Feedback\n\nType: ${meta.label}\nCustomer: ${customer}\nContext: ${context}\n\n${safeText(doc.message)}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📄 Open', `cf_view:${doc._id}`), Markup.button.callback('✍️ Reply', `cf_reply:${doc._id}`)],
    [Markup.button.callback('✅ Resolve', `cf_resolve:${doc._id}`)],
  ]);

  for (const id of adminIds) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    await telegram.sendMessage(id, text, keyboard).catch((err) => {
      console.error('[CustomerFeedback] admin notification failed:', err.message);
    });
  }
}

async function editOrReply(ctx, text, keyboard) {
  try {
    return await ctx.editMessageText(text, keyboard);
  } catch (err) {
    const description = String(err?.description || err?.message || '');
    if (/message is not modified|query is too old|message to edit not found/i.test(description)) return null;
    return ctx.reply(text, keyboard).catch(() => null);
  }
}

function centerKeyboard(mode, page, totalPages) {
  const rows = [
    [Markup.button.callback('📥 Inbox', `cf_list:all:1`), Markup.button.callback('💡 Suggestions', `cf_list:suggestion:1`)],
    [Markup.button.callback('❤️ Feedback', `cf_list:feedback:1`), Markup.button.callback('🆕 New', `cf_list:new:1`)],
    [Markup.button.callback('💬 Replied', `cf_list:replied:1`), Markup.button.callback('✅ Resolved', `cf_list:resolved:1`)],
  ];
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback(`‹ ${page - 1}`, `cf_list:${mode}:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'cf_noop'));
  if (page < totalPages) nav.push(Markup.button.callback(`${page + 1} ›`, `cf_list:${mode}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('🔄 Refresh', `cf_list:${mode}:${page}`), Markup.button.callback('🔙 Back', 'nav:go:admin_main')]);
  return Markup.inlineKeyboard(rows);
}

async function renderList(ctx, mode = 'all', page = 1, edit = true) {
  const limit = 8;
  const filter = {};
  if (['suggestion', 'feedback'].includes(mode)) filter.type = mode;
  if (['new', 'read', 'replied', 'resolved'].includes(mode)) filter.status = mode;
  const total = await CustomerFeedback.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const records = await CustomerFeedback.find(filter)
    .sort({ createdAt: -1 })
    .skip((currentPage - 1) * limit)
    .limit(limit)
    .lean();

  const title = mode === 'all' ? '📥 Inbox' : (TYPE_META[mode]?.label || `${STATUS_META[mode] || mode}`);
  const lines = records.length
    ? records.map((doc, index) => {
      const customer = doc.username ? `@${doc.username}` : (doc.firstName || `ID:${doc.telegramId}`);
      return `${index + 1 + ((currentPage - 1) * limit)}. ${TYPE_META[doc.type]?.label || doc.type} · ${customer}\n   ${preview(doc.message)}\n   ${STATUS_META[doc.status] || doc.status} · ${new Date(doc.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })}`;
    }).join('\n\n')
    : 'No customer suggestions or feedback found.';
  const text = `💬 Customer Feedback — ${title}\n\nTotal: ${total}\n\n${lines}`;
  const keyboard = centerKeyboard(mode, currentPage, totalPages);
  return edit ? editOrReply(ctx, text, keyboard) : ctx.reply(text, keyboard);
}

async function renderDetail(ctx, id) {
  const doc = await CustomerFeedback.findById(id).lean();
  if (!doc) return editOrReply(ctx, '❌ Feedback မတွေ့ပါ။', Markup.inlineKeyboard([[Markup.button.callback('🔙 Feedback Center', 'cf_center')]]));
  if (doc.status === 'new') await CustomerFeedback.updateOne({ _id: id, status: 'new' }, { $set: { status: 'read' } });
  const customer = doc.username ? `@${doc.username}` : (doc.firstName || `ID:${doc.telegramId}`);
  const context = [doc.categoryName, doc.subcategoryName, doc.productName].filter(Boolean).join(' › ') || 'General';
  const replies = (doc.replies || []).slice(-8).map((reply) => `${reply.from === 'admin' ? 'Admin' : 'Customer'}: ${safeText(reply.message)}`).join('\n\n') || 'No replies yet.';
  const text = `${TYPE_META[doc.type]?.label || doc.type}\n\nCustomer: ${customer}\nTelegram ID: ${doc.telegramId}\nContext: ${context}\nStatus: ${STATUS_META[doc.status] || doc.status}\nCreated: ${new Date(doc.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })}\n\nMessage:\n${safeText(doc.message)}\n\nConversation:\n${replies}`;
  const rows = [
    [Markup.button.callback('✍️ Reply', `cf_reply:${doc._id}`), Markup.button.callback(doc.status === 'resolved' ? '↩️ Reopen' : '✅ Resolve', `cf_resolve:${doc._id}`)],
    [Markup.button.callback('🔙 Feedback Center', 'cf_center')],
  ];
  return editOrReply(ctx, text, Markup.inlineKeyboard(rows));
}

async function saveCustomerSubmission(ctx, type, message) {
  const user = ctx.user || await User.findOne({ telegramId: Number(ctx.from.id) });
  if (!user) throw new Error('User record not found');
  const doc = await CustomerFeedback.create({
    userId: user._id,
    telegramId: Number(ctx.from.id),
    username: ctx.from.username || user.username || null,
    firstName: ctx.from.first_name || user.first_name || null,
    type,
    message,
  });
  await notifyAdmins(ctx.telegram, doc);
  return doc;
}

module.exports = function registerCustomerFeedback(bot) {
  const startCustomerFlow = async (ctx, type) => {
    ctx.session ||= {};
    ctx.session.customerFeedback = { type };
    const meta = TYPE_META[type];
    await ctx.reply(`${meta.label}\n\n${type === 'suggestion' ? 'ဘာအကြံပြုချက်ပေးချင်ပါသလဲ ခင်ဗျာ? 💡' : 'သင့်ရဲ့ Feedback ကို ရေးပေးပါခင်ဗျာ ❤️'}\n\nစာကို တိုက်ရိုက်ရေးပို့ပါ။ (အများဆုံး ${MAX_MESSAGE_LENGTH} characters)`, Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cf_cancel')]]));
  };

  bot.hears('💡 အကြံပြုစာ', async (ctx) => startCustomerFlow(ctx, 'suggestion'));
  bot.hears('❤️ Feedback', async (ctx) => startCustomerFlow(ctx, 'feedback'));
  bot.command('suggestion', async (ctx) => startCustomerFlow(ctx, 'suggestion'));
  bot.command('customerfeedback', async (ctx) => startCustomerFlow(ctx, 'feedback'));

  bot.action('cf_cancel', async (ctx) => {
    await ctx.answerCbQuery('ပယ်ဖျက်ပြီးပါပြီ');
    if (ctx.session) ctx.session.customerFeedback = null;
    return ctx.editMessageText('❌ အကြံပြုစာ/Feedback ပေးပို့မှုကို ပယ်ဖျက်ပြီးပါပြီ။').catch(() => {});
  });

  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.customerFeedback;
    if (!state || ctx.message.text.startsWith('/')) return next();
    const message = String(ctx.message.text || '').trim();
    if (!message) return ctx.reply('❌ စာအလွတ် မပို့နိုင်ပါ။');
    if (message.length > MAX_MESSAGE_LENGTH) return ctx.reply(`❌ စာသားကို ${MAX_MESSAGE_LENGTH} characters အတွင်း ထည့်ပါ။`);
    ctx.session.customerFeedback = null;
    try {
      await saveCustomerSubmission(ctx, state.type, message);
      return ctx.reply(TYPE_META[state.type].thanks);
    } catch (err) {
      console.error('[CustomerFeedback] submission failed:', err.message);
      return ctx.reply('❌ ပေးပို့မရသေးပါ။ ခဏအကြာ ပြန်ကြိုးစားပါ။');
    }
  });

  bot.command('feedbackcenter', requirePermission('support'), async (ctx) => renderList(ctx, 'all', 1, false));
  bot.hears('💬 Customer Feedback', requirePermission('support'), async (ctx) => renderList(ctx, 'all', 1, false));
  bot.action('cf_center', requirePermission('support'), async (ctx) => { await ctx.answerCbQuery(); return renderList(ctx, 'all', 1, true); });
  bot.action(/^cf_list:(all|suggestion|feedback|new|read|replied|resolved):(\d+)$/, requirePermission('support'), async (ctx) => {
    await ctx.answerCbQuery();
    return renderList(ctx, ctx.match[1], Number(ctx.match[2]) || 1, true);
  });
  bot.action('cf_noop', requirePermission('support'), async (ctx) => ctx.answerCbQuery());
  bot.action(/^cf_view:([a-f0-9]{24})$/i, requirePermission('support'), async (ctx) => { await ctx.answerCbQuery(); return renderDetail(ctx, ctx.match[1]); });

  bot.action(/^cf_resolve:([a-f0-9]{24})$/i, requirePermission('support'), async (ctx) => {
    await ctx.answerCbQuery();
    const doc = await CustomerFeedback.findById(ctx.match[1]);
    if (!doc) return ctx.reply('❌ Feedback မတွေ့ပါ။');
    const resolved = doc.status !== 'resolved';
    doc.status = resolved ? 'resolved' : 'read';
    doc.resolvedAt = resolved ? new Date() : null;
    doc.resolvedBy = resolved ? Number(ctx.from.id) : null;
    await doc.save();
    await auditLog(ctx.from.id, resolved ? 'RESOLVE_CUSTOMER_FEEDBACK' : 'REOPEN_CUSTOMER_FEEDBACK', String(doc._id), 'CustomerFeedback', { type: doc.type });
    return renderDetail(ctx, doc._id);
  });

  bot.action(/^cf_reply:([a-f0-9]{24})$/i, requirePermission('support'), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session ||= {};
    ctx.session.customerFeedbackAdminReply = String(ctx.match[1]);
    return ctx.reply('✍️ Customer ကို ဘာပြန်ပြောချင်ပါသလဲ? စာရိုက်ပို့ပါ။ (အများဆုံး 4000 characters)', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `cf_reply_cancel:${ctx.match[1]}`)]]));
  });

  bot.action(/^cf_reply_cancel:([a-f0-9]{24})$/i, requirePermission('support'), async (ctx) => {
    await ctx.answerCbQuery('ပယ်ဖျက်ပြီးပါပြီ');
    if (ctx.session) ctx.session.customerFeedbackAdminReply = null;
    return ctx.editMessageText('❌ Reply ပေးပို့မှုကို ပယ်ဖျက်ပြီးပါပြီ။').catch(() => {});
  });

  bot.on('text', async (ctx, next) => {
    const id = ctx.session?.customerFeedbackAdminReply;
    if (!id || ctx.message.text.startsWith('/')) return next();
    if (!(await canManage(ctx))) return next();
    const message = String(ctx.message.text || '').trim();
    ctx.session.customerFeedbackAdminReply = null;
    if (!message || message.length > MAX_MESSAGE_LENGTH) return ctx.reply(`❌ Reply ကို 1-${MAX_MESSAGE_LENGTH} characters အတွင်း ထည့်ပါ။`);
    const doc = await CustomerFeedback.findById(id);
    if (!doc) return ctx.reply('❌ Feedback မတွေ့ပါ။');
    doc.replies.push({ from: 'admin', message, adminId: Number(ctx.from.id) });
    doc.status = 'replied';
    await doc.save();
    await auditLog(ctx.from.id, 'REPLY_CUSTOMER_FEEDBACK', String(doc._id), 'CustomerFeedback', { type: doc.type });
    await ctx.telegram.sendMessage(doc.telegramId, `💬 Admin Reply\n\n${message}`).catch(() => {});
    await ctx.reply('✅ Customer ဆီ Reply ပို့ပြီးပါပြီ။');
    return renderDetail(ctx, doc._id);
  });
};
