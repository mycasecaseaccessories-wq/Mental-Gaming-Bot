/**
 * FAQService — Dynamic FAQ library with full-text search and video tutorials.
 *
 * Search priority: exact match > tag match > text index
 * All FAQ data is stored in MongoDB and hot-editable by admins at runtime.
 */

const FAQ = require('../models/FAQ');

// ── Search ─────────────────────────────────────────────────────────────────────

/**
 * Full-text search across question, answer, tags.
 * Falls back to regex if MongoDB text search returns nothing.
 */
async function search(query, limit = 6) {
  if (!query || query.trim().length < 2) return [];

  const q = query.trim();

  // Try MongoDB text index first (best relevance scoring)
  let results = await FAQ.find(
    { $text: { $search: q }, isActive: true },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit);

  // Fallback: regex search on question (good for partial matches)
  if (!results.length) {
    results = await FAQ.find({
      isActive: true,
      $or: [
        { question: { $regex: q, $options: 'i' } },
        { tags:     { $in: [q.toLowerCase()] } },
      ],
    })
      .sort({ viewCount: -1 })
      .limit(limit);
  }

  return results;
}

// ── Get by category ────────────────────────────────────────────────────────────

async function getByCategory(category, limit = 8) {
  return FAQ.find({ category, isActive: true })
    .sort({ sortOrder: 1, viewCount: -1 })
    .limit(limit);
}

// ── Get all active FAQs (for AI context injection) ─────────────────────────────

async function getTopFAQs(limit = 20) {
  return FAQ.find({ isActive: true })
    .sort({ viewCount: -1 })
    .limit(limit)
    .select('question answer tags category');
}

// ── Get by ID ──────────────────────────────────────────────────────────────────

async function getById(faqId) {
  return FAQ.findOne({ faqId, isActive: true });
}

// ── Increment view count ───────────────────────────────────────────────────────

async function incrementView(faqId) {
  await FAQ.updateOne({ faqId }, { $inc: { viewCount: 1 } });
}

// ── Admin CRUD ─────────────────────────────────────────────────────────────────

async function create(data) {
  const faqId = await FAQ.generateId();
  return FAQ.create({ faqId, ...data });
}

async function update(faqId, data) {
  return FAQ.findOneAndUpdate({ faqId }, { $set: data }, { new: true });
}

async function remove(faqId) {
  return FAQ.findOneAndUpdate({ faqId }, { $set: { isActive: false } }, { new: true });
}

async function listAll(includeInactive = false) {
  const filter = includeInactive ? {} : { isActive: true };
  return FAQ.find(filter).sort({ category: 1, sortOrder: 1, createdAt: -1 });
}

// ── Build FAQ context string for AI prompt injection ──────────────────────────

async function buildFAQContext() {
  try {
    const faqs = await getTopFAQs(15);
    if (!faqs.length) return '';

    const lines = faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
    return `\nFREQUENTLY ASKED QUESTIONS (use these to answer user questions):\n${lines}\n`;
  } catch {
    return '';
  }
}

// ── Seed default FAQs (called once if collection empty) ───────────────────────

async function seedDefaultFAQs() {
  const count = await FAQ.countDocuments();
  if (count > 0) return;

  const defaults = [
    {
      question: 'How do I top up my wallet?',
      answer: 'Go to /topup, select your payment method (KPay, Wave, AYA Pay), enter the amount, upload your payment screenshot. Admin approves within 15 minutes.',
      tags: ['topup', 'wallet', 'deposit', 'recharge'],
      category: 'payment',
    },
    {
      question: 'How long does order delivery take?',
      answer: 'Direct Top-up orders (e.g. MLBB, Free Fire) are delivered within 30 minutes by our admin team. Digital Code orders are instant after your wallet has enough KS.',
      tags: ['delivery', 'order', 'time', 'wait'],
      category: 'order',
    },
    {
      question: 'How do I find my Game ID?',
      answer: 'Mobile Legends: Open profile (bottom-left) → your ID and Zone ID are shown below your name. Free Fire: Main lobby → tap your avatar → UID shown below your name.',
      tags: ['game id', 'zone id', 'uid', 'mlbb', 'free fire'],
      category: 'game',
    },
    {
      question: 'What payment methods are accepted?',
      answer: 'We accept KBZ Pay (KPay), Wave Money, and AYA Pay. Account details are shown when you select a method in /topup.',
      tags: ['payment', 'kpay', 'wave', 'aya pay', 'method'],
      category: 'payment',
    },
    {
      question: 'Can I get a refund?',
      answer: 'Yes! If your order is cancelled by our admin for any reason, the full amount is refunded to your KS wallet immediately. Contact /support if you need to cancel.',
      tags: ['refund', 'cancel', 'money back'],
      category: 'order',
    },
    {
      question: 'What are Mental Coins?',
      answer: 'Mental Coins (MC) are loyalty points earned on every top-up (1-2% depending on your tier). Use them in the Spin Wheel (/spin) for prizes.',
      tags: ['coins', 'mental coins', 'loyalty', 'spin'],
      category: 'account',
    },
    {
      question: 'How do membership tiers work?',
      answer: 'Silver (default) → Gold (≥50,000 KS deposited) → Platinum (≥200,000 KS deposited). Higher tier = more Mental Coins per top-up and priority support.',
      tags: ['tier', 'membership', 'gold', 'platinum', 'silver'],
      category: 'account',
    },
    {
      question: 'How do I use a promo code?',
      answer: 'Promo codes can be applied at checkout in /shop before confirming your order. Enter the code in the promo field to see the discount applied.',
      tags: ['promo', 'discount', 'coupon', 'code'],
      category: 'promo',
    },
  ];

  for (const faq of defaults) {
    try {
      const faqId = await FAQ.generateId();
      await FAQ.create({ faqId, ...faq });
    } catch {}
  }
  console.log('[FAQService] ✅ Default FAQs seeded');
}

module.exports = {
  search,
  getByCategory,
  getTopFAQs,
  getById,
  incrementView,
  create,
  update,
  remove,
  listAll,
  buildFAQContext,
  seedDefaultFAQs,
};
