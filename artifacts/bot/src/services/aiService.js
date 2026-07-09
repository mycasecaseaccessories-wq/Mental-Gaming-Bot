/**
 * AIService — Gemini 2.0 Flash
 *
 * Handles:
 *   generateProductDescription() — short copy for shop listings
 *   buildSupportContext()        — assemble user + store context for support AI
 *   answerSupportQuery()         — full AI support response with escalation signal
 *   answerAmbientQuery()         — conversational AI for non-command chat messages
 *   analyzeSentiment()           — detect frustration for auto-escalation
 */

const axios = require('axios');
const { config } = require('../../config/settings');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';

// Master switch — flip to true when a working Gemini key (with quota) is configured.
// While false, support/ambient flows run in no-AI mode (direct game-news lookup + tickets).
const AI_ENABLED = false;

function geminiUrl(endpoint) {
  return `${GEMINI_BASE}/${GEMINI_MODEL}:${endpoint}?key=${config.ai.apiKey}`;
}

// ── Core Gemini call ──────────────────────────────────────────────────────────
async function callGemini(systemPrompt, userPrompt, { maxTokens = 400, temperature = 0.7, history = [] } = {}) {
  if (!userPrompt || !userPrompt.trim()) return null;

  // Sanitize history — Gemini requires alternating user/model with non-empty parts
  const cleanHistory = (history || []).filter(
    (m) => m && m.role && Array.isArray(m.parts) && m.parts.some((p) => p?.text?.trim())
  );

  const contents = [
    ...cleanHistory,
    { role: 'user', parts: [{ text: userPrompt.trim() }] },
  ];

  try {
    const { data } = await axios.post(
      geminiUrl('generateContent'),
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    // Surface the real Gemini error body so 400s aren't opaque
    const body = err.response?.data;
    const reason = body?.error?.message || body?.error?.status || err.message;
    const status = err.response?.status || 'no-status';
    console.error(`[AIService] Gemini ${status}: ${reason}`);
    throw err;
  }
}

// ── Store knowledge base (injected into every support prompt) ─────────────────
const STORE_KNOWLEDGE = `
STORE: Mental Gaming Store (Telegram bot @mentalgamingstorebot)
LOCATION: Myanmar | CURRENCY: KS (Kyat Store = MMK)
SUPPORT HOURS: 9AM – 11PM Myanmar Time (UTC+6:30)

PRODUCTS:
- Mobile Legends: Diamonds, Weekly Pass, Starlight
- Free Fire: Diamonds, Membership
- PUBG Mobile: UC, Royal Pass
- Genshin Impact: Genesis Crystals, Battle Pass
- Valorant: VP Points, Premium Bundles
- Gift Cards: Google Play, App Store, Steam, Razer Gold

PRODUCT TYPES:
- Direct Top-up: Customer provides Game ID + Zone ID → admin delivers manually within 30 mins
- Digital Codes: Gift card codes sent automatically after order completion

PAYMENT: KPay, Wave Money, AYA Pay (admin bank accounts shown in /topup)
WALLET: Users top up KS balance → use KS to buy products (no need to pay each time)
COINS: Mental Coins earned on top-ups (1-2% bonus based on tier) → used for Spin Wheel

MEMBERSHIP TIERS:
- Silver: default | Gold: ≥50,000 KS deposited | Platinum: ≥200,000 KS deposited
- Higher tier = more coin bonus on top-ups

ORDER PROCESS:
1. Choose product in /shop
2. Enter Game ID (for Direct Top-up)
3. Confirm → KS deducted from wallet
4. Admin delivers within 30 minutes
5. Customer receives receipt

REFUND POLICY: Full refund to wallet if admin cancels the order
PROMO CODES: Applied at checkout step in /shop
FLASH SALES: Time-limited discounts shown with countdown timer

COMMANDS: /shop /orders /wallet /topup /history /spin /promo /myids /support /profile /faq
`;

// ── Build per-user context string ─────────────────────────────────────────────
async function buildUserContext(telegramId) {
  try {
    const User  = require('../models/User');
    const Order = require('../models/Order');

    const user = await User.findByTelegramId(telegramId);
    if (!user) return '';

    const recentOrders = await Order.find({ userId: user._id })
      .populate('productId', 'name')
      .sort({ timestamp: -1 })
      .limit(3);

    const orderLines = recentOrders.length
      ? recentOrders.map((o) =>
          `  - ${o.productId?.name || 'Unknown'} | ${o.status} | ${o.amount.toLocaleString()} KS`
        ).join('\n')
      : '  (none)';

    return (
      `\nCURRENT USER CONTEXT:\n` +
      `Name: ${user.username ? '@' + user.username : 'No username'} | Tier: ${user.membershipTier}\n` +
      `KS Balance: ${user.balanceKS.toLocaleString()} KS | Coins: ${user.balanceCoin.toLocaleString()} MC\n` +
      `Recent Orders:\n${orderLines}\n`
    );
  } catch {
    return '';
  }
}

// ── Topic-specific guidance injected into system prompt ───────────────────────
const TOPIC_GUIDANCE = {
  order: `Focus on order-related issues: pending orders (check /orders), delivery times (up to 30 mins for Direct Top-up, instant for Digital Codes), Game ID issues. If the order is past 30 minutes and still Pending, suggest creating a ticket.`,
  payment: `Focus on wallet top-ups: how to use /topup, payment methods (KPay/Wave/AYA Pay), approval times (usually within 15 minutes), E-Receipt. Explain dual wallet system.`,
  game: `Help with game-specific questions: how to find Game ID and Zone ID in various games (ML: Profile > bottom left shows ID+Zone, FF: Lobby > avatar > UID), what region means, how direct top-up works.`,
  bug: `Acknowledge the bug report professionally. Gather details: what happened, which command/feature, any error message. Always escalate bug reports to human admin.`,
  general: `Answer general questions about the store, products, pricing, how the system works. If unsure, recommend /support escalation.`,
};

// ── Full support answer with escalation signal ────────────────────────────────
async function answerSupportQuery(userMessage, { telegramId = null, topic = 'general', history = [] } = {}) {
  if (!config.ai.apiKey) return { answer: null, shouldEscalate: true };

  const [userContext, faqContext, gameNewsContext] = await Promise.all([
    telegramId ? buildUserContext(telegramId) : Promise.resolve(''),
    loadFAQContext(),
    loadGameNewsContext(userMessage),
  ]);
  const topicGuide  = TOPIC_GUIDANCE[topic] || TOPIC_GUIDANCE.general;

  const systemPrompt =
    `You are a friendly, concise AI support agent for Mental Gaming Store — a Telegram-based gaming store in Myanmar.\n` +
    `\n${STORE_KNOWLEDGE}\n` +
    `${faqContext}\n` +
    `${gameNewsContext}\n` +
    `${userContext}\n` +
    `CURRENT TOPIC: ${topic.toUpperCase()}\n` +
    `TOPIC GUIDANCE: ${topicGuide}\n` +
    `\nRULES:\n` +
    `- Keep answers under 150 words\n` +
    `- Use simple English (some users may not be fluent)\n` +
    `- Use Myanmar/gaming context where relevant\n` +
    `- If the user's issue requires admin action (refund, stuck order >30min, account issue), end your message with exactly: [ESCALATE]\n` +
    `- For bug reports, always end with: [ESCALATE]\n` +
    `- Never make up order IDs, prices, or account details\n` +
    `- If you don't know, say so honestly and suggest /support`;

  try {
    const raw = await callGemini(systemPrompt, userMessage, {
      maxTokens: 300,
      temperature: 0.5,
      history,
    });

    if (!raw) return { answer: null, shouldEscalate: true };

    const shouldEscalate = raw.includes('[ESCALATE]');
    const answer = raw.replace('[ESCALATE]', '').trim();

    return { answer, shouldEscalate };
  } catch (err) {
    console.error('[AIService] Support query failed:', err.message);
    return { answer: null, shouldEscalate: true };
  }
}

// ── Ambient conversational AI (for non-command messages) ─────────────────────
//
// Lighter-weight than the full support flow — handles casual queries,
// quick FAQs, and product questions directly in chat.
// If the issue needs human help, suggests [🎫 Open Support Ticket].

async function answerAmbientQuery(userMessage, { telegramId = null, history = [] } = {}) {
  if (!config.ai.apiKey) return { answer: null, shouldOpenTicket: false };

  const [userContext, faqContext, gameNewsContext] = await Promise.all([
    telegramId ? buildUserContext(telegramId) : Promise.resolve(''),
    loadFAQContext(),
    loadGameNewsContext(userMessage),
  ]);

  const systemPrompt =
    `You are a helpful, friendly AI assistant for Mental Gaming Store — a Telegram gaming top-up store in Myanmar.\n` +
    `You answer quick questions in the main chat (not in a support ticket flow).\n\n` +
    `${STORE_KNOWLEDGE}\n` +
    `${faqContext}\n` +
    `${gameNewsContext}\n` +
    `${userContext}\n` +
    `RULES:\n` +
    `- Keep responses SHORT — max 3 sentences or 80 words\n` +
    `- Be warm, casual, and helpful — like a knowledgeable friend\n` +
    `- Suggest specific commands when relevant (/shop, /topup, /orders, /faq, etc.)\n` +
    `- If the user has a complex issue, account problem, or needs admin action, end with exactly: [OPEN_TICKET]\n` +
    `- Never fabricate prices, order details, or account info\n` +
    `- If you genuinely don't know, say so briefly and suggest /faq or /support`;

  try {
    const raw = await callGemini(systemPrompt, userMessage, {
      maxTokens: 200,
      temperature: 0.6,
      history,
    });

    if (!raw) return { answer: null, shouldOpenTicket: false };

    const shouldOpenTicket = raw.includes('[OPEN_TICKET]');
    const answer = raw.replace('[OPEN_TICKET]', '').trim();

    return { answer, shouldOpenTicket };
  } catch (err) {
    console.error('[AIService] Ambient query failed:', err.message);
    return { answer: null, shouldOpenTicket: false };
  }
}

// ── Vision: extract text/dates from a game update image ──────────────────────
async function extractImageText(imageBase64, mimeType = 'image/jpeg') {
  if (!config.ai.apiKey || !imageBase64) return null;

  try {
    const { data } = await axios.post(
      geminiUrl('generateContent'),
      {
        system_instruction: {
          parts: [{
            text:
              'You extract text and key facts from gaming update/promotion images for a knowledge base. ' +
              'Summarize the update info concisely and ALWAYS include any dates, event periods, seasons, versions, or deadlines visible in the image. ' +
              'Reply in the same language as the image text. If nothing readable, reply exactly: NONE',
          }],
        },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: 'Extract the update information and any dates from this image.' },
          ],
        }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.1 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out || /^NONE\.?$/i.test(out)) return null;
    return out;
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message;
    console.error('[AIService] Image extract failed:', reason);
    return null;
  }
}

// ── Game update knowledge from the game news channel ─────────────────────────
async function loadGameNewsContext(userMessage) {
  try {
    const GameNews = require('../models/GameNews');
    const SystemStatus = require('../models/SystemStatus');

    // Only ever serve knowledge from the CURRENTLY configured channel
    const st = await SystemStatus.get();
    if (!st.gameNewsChannelId) return '';
    const chatId = String(st.gameNewsChannelId);

    // Only use posts from the last 3 months
    const freshSince = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const base = { chatId, postedAt: { $gte: freshSince } };

    // Try relevance search first, fall back to most recent posts
    let entries = [];
    if (userMessage && userMessage.trim()) {
      try {
        entries = await GameNews.find(
          { ...base, $text: { $search: userMessage.slice(0, 200) } },
          { score: { $meta: 'textScore' } }
        )
          .sort({ score: { $meta: 'textScore' } })
          .limit(5)
          .lean();
      } catch {
        entries = []; // text index unavailable — use recency fallback below
      }
    }
    if (!entries.length) {
      entries = await GameNews.find(base).sort({ postedAt: -1 }).limit(8).lean();
    }
    if (!entries.length) return '';

    const lines = entries
      .map((n) => {
        const d = new Date(n.postedAt).toISOString().slice(0, 10);
        return `[${d}] ${n.text.slice(0, 500)}`;
      })
      .join('\n---\n');

    return (
      `\nGAME UPDATES KNOWLEDGE (latest posts from our official game update channel — ` +
      `when the user asks about games, updates, events, patches, or new releases, search THIS section first and answer from it; ` +
      `only fall back to general knowledge if nothing here matches):\n${lines}\n`
    );
  } catch {
    return '';
  }
}

// ── Lazy-load FAQ context to avoid circular requires ─────────────────────────
async function loadFAQContext() {
  try {
    const { buildFAQContext } = require('./FAQService');
    return await buildFAQContext();
  } catch {
    return '';
  }
}

// ── Sentiment analysis — detect high frustration ──────────────────────────────
async function analyzeSentiment(message) {
  if (!config.ai.apiKey) return 'neutral';

  try {
    const result = await callGemini(
      'Classify the sentiment of this customer support message in one word: "frustrated", "angry", "neutral", or "happy". Reply with only the single word.',
      message,
      { maxTokens: 5, temperature: 0 }
    );
    return result?.toLowerCase().trim() || 'neutral';
  } catch {
    return 'neutral';
  }
}

// ── Product description generator ────────────────────────────────────────────
async function generateProductDescription(productName, category, region) {
  if (!config.ai.apiKey) return `${productName} — ${category} for ${region} region.`;

  try {
    const result = await callGemini(
      'You are a copywriter for a gaming store in Myanmar. Write a short, engaging product description in 1-2 sentences. Be direct and mention the game name and what the customer gets.',
      `Product: ${productName} | Category: ${category} | Region: ${region}`,
      { maxTokens: 80, temperature: 0.8 }
    );
    return result || `${productName} — ${category} for ${region} region.`;
  } catch (err) {
    console.error('[AIService] Description generation failed:', err.message);
    return `${productName} — ${category} for ${region} region.`;
  }
}

module.exports = {
  AI_ENABLED,
  answerSupportQuery,
  answerAmbientQuery,
  generateProductDescription,
  analyzeSentiment,
  buildUserContext,
  extractImageText,
};
