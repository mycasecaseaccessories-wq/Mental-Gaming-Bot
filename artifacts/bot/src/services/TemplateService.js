/**
 * TemplateService — Quick-reply template management.
 *
 * Pre-seeded templates are created on first use if the collection is empty.
 */

const Template = require('../models/Template');
const { auditLog } = require('./logger');
const { config } = require('../../config/settings');

const SEED_TEMPLATES = [
  {
    name: 'Invalid Screenshot',
    category: 'payment',
    content:
      '❌ *Invalid Screenshot*\n\n' +
      'Your screenshot appears to be invalid or has been used before.\n' +
      'Please provide a *new, clear screenshot* of your payment and resubmit.',
  },
  {
    name: 'Please Provide Game ID',
    category: 'order',
    content:
      '🎮 *Game ID Required*\n\n' +
      'Please provide your *Game ID* (and Zone ID if applicable) so we can complete your order.',
  },
  {
    name: 'Order Processed',
    category: 'order',
    content:
      '✅ *Order Processed!*\n\n' +
      'Your order has been successfully processed. ' +
      'Please check your delivery details above.\n\n' +
      '_Thank you for shopping at Mental Gaming Store! 🎮_',
  },
  {
    name: 'Payment Pending Review',
    category: 'payment',
    content:
      '⏳ *Payment Under Review*\n\n' +
      'Your payment is currently being reviewed by our team. ' +
      'We will update you within *30 minutes*.\n\n' +
      '_Thank you for your patience!_',
  },
  {
    name: 'Top-up Approved',
    category: 'payment',
    content:
      '💰 *Top-up Approved!*\n\n' +
      'Your wallet has been topped up successfully. ' +
      'Your updated balance is now available.\n\n' +
      '_Happy shopping! 🛒_',
  },
  {
    name: 'Fraud Warning',
    category: 'warning',
    content:
      '⚠️ *Security Notice*\n\n' +
      'We have detected suspicious activity on your account. ' +
      'Continued violations may result in a *permanent ban*.\n\n' +
      '_If you believe this is a mistake, please contact /support._',
  },
  {
    name: 'Order Cancelled — Refunded',
    category: 'order',
    content:
      '❌ *Order Cancelled*\n\n' +
      'Your order has been cancelled and the amount has been *fully refunded* to your wallet.\n\n' +
      '_Please contact /support if you have any questions._',
  },
  {
    name: 'Please Wait',
    category: 'general',
    content:
      '⏳ *Please Wait*\n\n' +
      'Our team is currently processing your request. ' +
      'We will get back to you as soon as possible.\n\n' +
      '_Thank you for your patience!_',
  },
];

// ── Auto-seed on first call ────────────────────────────────────────────────────

let seeded = false;

async function ensureSeeded() {
  if (seeded) return;
  const count = await Template.countDocuments({});
  if (count === 0) {
    const adminId = config.bot.adminId;
    await Template.insertMany(SEED_TEMPLATES.map((t) => ({ ...t, createdBy: adminId })));
  }
  seeded = true;
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

async function listTemplates(category = null) {
  await ensureSeeded();
  const q = { isActive: true };
  if (category) q.category = category;
  return Template.find(q).sort({ category: 1, name: 1 });
}

async function getTemplate(id) {
  return Template.findById(id);
}

async function createTemplate(name, content, category, createdBy) {
  await ensureSeeded();
  const t = await Template.create({ name, content, category, createdBy });
  await auditLog(createdBy, 'TEMPLATE_CREATED', t._id.toString(), 'Template', { name });
  return t;
}

async function updateTemplate(id, fields, updatedBy) {
  const t = await Template.findByIdAndUpdate(id, { $set: fields }, { new: true });
  if (!t) throw new Error('Template not found.');
  await auditLog(updatedBy, 'TEMPLATE_UPDATED', id, 'Template', fields);
  return t;
}

async function deleteTemplate(id, deletedBy) {
  const t = await Template.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
  if (!t) throw new Error('Template not found.');
  await auditLog(deletedBy, 'TEMPLATE_DELETED', id, 'Template', { name: t.name });
  return t;
}

async function incrementUsage(id) {
  await Template.findByIdAndUpdate(id, { $inc: { usageCount: 1 } });
}

// ── Keyboard builder for template picker ─────────────────────────────────────

const CATEGORY_EMOJI = { order: '📦', payment: '💳', warning: '⚠️', general: '💬' };

async function buildTemplatePicker(contextType, contextId) {
  await ensureSeeded();
  const templates = await Template.find({ isActive: true }).sort({ category: 1, name: 1 });

  const { Markup } = require('telegraf');
  const rows = templates.map((t) => [
    Markup.button.callback(
      `${CATEGORY_EMOJI[t.category] || '📝'} ${t.name}`,
      `tpl_use:${contextType}:${contextId}:${t._id}`
    ),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', `tpl_cancel:${contextType}:${contextId}`)]);
  return Markup.inlineKeyboard(rows);
}

module.exports = {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  incrementUsage,
  buildTemplatePicker,
  CATEGORY_EMOJI,
};
