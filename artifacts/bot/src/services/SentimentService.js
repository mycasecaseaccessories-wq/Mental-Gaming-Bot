/**
 * SentimentService — AI sentiment analysis for user reviews. (AI Module 5)
 *
 * Uses Gemini to classify reviews as positive / neutral / negative.
 * Scans reviews in batches to minimize API calls.
 *
 * Alert System:
 *   If ≥ 3 negative reviews appear in the last 24 hours, the OWNER is
 *   notified immediately with an AI-summarized reason.
 *
 * Lifecycle:
 *   1. New review submitted → analyzed immediately (via analyzeAndSave)
 *   2. Batch scan via runBatchSentimentScan() — processes unanalyzed reviews
 *   3. Alert check runs every time the watcher fires (every 60 min)
 *
 * Sentiment labels stored in Review.sentimentLabel: 'positive' | 'neutral' | 'negative'
 */

const axios    = require('axios');
const { config } = require('../../config/settings');
const Review   = require('../models/Review');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';

const NEGATIVE_ALERT_THRESHOLD = 3; // trigger after N negative reviews in 24h
const BATCH_SIZE = 10;              // reviews per Gemini call

function geminiUrl(endpoint) {
  return `${GEMINI_BASE}/${GEMINI_MODEL}:${endpoint}?key=${config.ai.apiKey}`;
}

async function callGemini(systemPrompt, userPrompt, opts = {}) {
  const { maxTokens = 400, temperature = 0.1 } = opts;
  const { data } = await axios.post(
    geminiUrl('generateContent'),
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ── Single review analysis ────────────────────────────────────────────────────

/**
 * Classify one review's sentiment.
 * Rating-only reviews (no comment) use the star rating as a signal.
 */
async function classifySentiment(review) {
  if (!config.ai.apiKey) {
    // Fallback: use star rating
    if (review.rating === null) return 'neutral';
    if (review.rating >= 4)    return 'positive';
    if (review.rating === 3)   return 'neutral';
    return 'negative';
  }

  const stars   = review.rating ? `${review.rating}/5 stars` : 'no rating';
  const comment = review.comment?.trim() || '(no comment provided)';
  const product = review.productName || 'unknown product';

  const systemPrompt =
    `You are a sentiment classifier for a gaming store review system. 
Classify the customer review below as exactly ONE of: positive, neutral, negative.
Reply with ONLY the single word — no explanation, no punctuation.
Context: Myanmar gaming store selling game top-ups. 1-2 star = likely negative, 3 = neutral, 4-5 = positive.
But text can override rating (e.g. 3 stars but angry comment = negative).`;

  const userPrompt =
    `Product: ${product}\nRating: ${stars}\nComment: ${comment}`;

  try {
    const result = await callGemini(systemPrompt, userPrompt, { maxTokens: 5, temperature: 0 });
    const label = result?.toLowerCase().trim();
    if (['positive', 'neutral', 'negative'].includes(label)) return label;
    // Fallback to rating
    if (review.rating >= 4) return 'positive';
    if (review.rating === 3) return 'neutral';
    return review.rating ? 'negative' : 'neutral';
  } catch {
    // Silent fallback
    if (review.rating >= 4) return 'positive';
    if (review.rating === 3) return 'neutral';
    return review.rating ? 'negative' : 'neutral';
  }
}

// ── Batch sentiment for many reviews in one API call ─────────────────────────

async function classifyBatch(reviews) {
  if (!config.ai.apiKey || !reviews.length) {
    return reviews.map((r) => {
      if (r.rating >= 4) return 'positive';
      if (r.rating === 3) return 'neutral';
      return r.rating ? 'negative' : 'neutral';
    });
  }

  const lines = reviews.map((r, i) => {
    const stars   = r.rating ? `${r.rating}★` : '?★';
    const comment = r.comment?.trim().slice(0, 120) || '(no comment)';
    return `${i + 1}. [${stars}] ${comment}`;
  }).join('\n');

  const systemPrompt =
    `You are a batch sentiment classifier for a Myanmar gaming store.
Classify each review as: positive, neutral, or negative.
Reply with ONLY a JSON array of labels in order, e.g.: ["positive","negative","neutral"]
No extra text.`;

  const userPrompt = `Reviews to classify:\n${lines}\n\nReturn JSON array only.`;

  try {
    const result = await callGemini(systemPrompt, userPrompt, { maxTokens: 100, temperature: 0 });
    const cleaned = result?.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const labels  = JSON.parse(cleaned);
    if (Array.isArray(labels) && labels.length === reviews.length) {
      return labels.map((l) =>
        ['positive', 'neutral', 'negative'].includes(l?.toLowerCase()) ? l.toLowerCase() : 'neutral'
      );
    }
  } catch {}

  // Fallback: classify individually
  return reviews.map((r) => {
    if (r.rating >= 4) return 'positive';
    if (r.rating === 3) return 'neutral';
    return r.rating ? 'negative' : 'neutral';
  });
}

// ── Analyze + save a single review ───────────────────────────────────────────

async function analyzeAndSave(reviewId) {
  const review = await Review.findById(reviewId);
  if (!review || review.sentimentAnalyzedAt) return null; // already done

  // Only analyze reviews that have a rating
  if (!review.rating && !review.comment) return null;

  const label = await classifySentiment(review);

  await Review.findByIdAndUpdate(reviewId, {
    sentimentLabel:      label,
    sentimentAnalyzedAt: new Date(),
  });

  return label;
}

// ── Batch scan — process all unanalyzed reviews ───────────────────────────────

async function runBatchSentimentScan() {
  const unanalyzed = await Review.find({
    sentimentAnalyzedAt: null,
    $or: [{ rating: { $ne: null } }, { comment: { $ne: null } }],
  })
    .sort({ createdAt: -1 })
    .limit(50);

  if (!unanalyzed.length) return { processed: 0, labels: {} };

  // Process in batches of BATCH_SIZE
  let processed = 0;
  const labels  = { positive: 0, neutral: 0, negative: 0 };

  for (let i = 0; i < unanalyzed.length; i += BATCH_SIZE) {
    const batch  = unanalyzed.slice(i, i + BATCH_SIZE);
    const result = await classifyBatch(batch);

    const now = new Date();
    await Promise.all(
      batch.map((review, idx) =>
        Review.findByIdAndUpdate(review._id, {
          sentimentLabel:      result[idx],
          sentimentAnalyzedAt: now,
        })
      )
    );

    for (const label of result) {
      if (labels[label] !== undefined) labels[label]++;
    }
    processed += batch.length;
  }

  return { processed, labels };
}

// ── Negative review alert ─────────────────────────────────────────────────────

async function checkNegativeReviewAlert(telegram) {
  if (!telegram) return;

  const since24h = new Date(Date.now() - 24 * 3600_000);

  const negativeReviews = await Review.find({
    sentimentLabel:      'negative',
    sentimentAnalyzedAt: { $gte: since24h },
  })
    .populate('userId', 'username telegramId')
    .sort({ createdAt: -1 })
    .limit(10);

  if (negativeReviews.length < NEGATIVE_ALERT_THRESHOLD) return;

  // Check if we already sent an alert in last 4 hours (prevent spam)
  const ALERT_COOLDOWN_KEY = '_lastNegativeSentimentAlert';
  const global  = globalThis;
  const lastAlert = global[ALERT_COOLDOWN_KEY] || 0;
  if (Date.now() - lastAlert < 4 * 3600_000) return;
  global[ALERT_COOLDOWN_KEY] = Date.now();

  // Generate AI summary of WHY users are unhappy
  const summary = await generateNegativeSummary(negativeReviews);
  const adminId = config.bot.adminId;

  const reviewLines = negativeReviews.slice(0, 5).map((r) => {
    const user  = r.userId?.username ? `@${r.userId.username}` : `ID: ${r.userId?.telegramId}`;
    const stars = r.rating ? `${'⭐'.repeat(r.rating)}` : '?';
    const text  = r.comment?.slice(0, 80) || '(no comment)';
    return `• ${user} ${stars}\n  _"${text}"_`;
  }).join('\n');

  try {
    await telegram.sendMessage(
      adminId,
      `🚨 *Negative Review Alert!*\n\n` +
      `⚠️ *${negativeReviews.length} negative reviews* in the last 24 hours.\n\n` +
      `*Recent negative reviews:*\n${reviewLines}\n\n` +
      `\`─────────────────────\`\n` +
      `🤖 *AI Analysis:*\n${summary || '_Unable to generate summary_'}\n\n` +
      `_Use /sentimentreport for full breakdown._`,
      { parse_mode: 'Markdown' }
    );
    console.log(`[SentimentService] 🚨 Alert sent — ${negativeReviews.length} negative reviews in 24h`);
  } catch (err) {
    console.error('[SentimentService] Alert send failed:', err.message);
  }
}

async function generateNegativeSummary(reviews) {
  if (!config.ai.apiKey || !reviews.length) return null;

  const reviewLines = reviews.map((r) =>
    `"${r.productName || 'unknown'}" — ${r.rating}★ — ${r.comment?.slice(0, 100) || 'no comment'}`
  ).join('\n');

  const systemPrompt =
    `You are a customer success analyst for a Myanmar gaming store.
Analyze these negative reviews and write a 2-3 sentence explanation of the core issue(s).
Be specific — identify patterns (e.g., "slow approval", "wrong amount delivered", "payment rejected").
Write in plain English. No bullet points. No fluff.`;

  const userPrompt = `Negative reviews to analyze:\n${reviewLines}`;

  try {
    return await callGemini(systemPrompt, userPrompt, { maxTokens: 150, temperature: 0.3 });
  } catch {
    return null;
  }
}

// ── Sentiment stats ───────────────────────────────────────────────────────────

async function getSentimentStats(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);

  const [breakdown, total, unanalyzed] = await Promise.all([
    Review.aggregate([
      { $match: { sentimentAnalyzedAt: { $gte: since }, sentimentLabel: { $ne: null } } },
      { $group: { _id: '$sentimentLabel', count: { $sum: 1 }, avgRating: { $avg: '$rating' } } },
      { $sort: { count: -1 } },
    ]),
    Review.countDocuments({ createdAt: { $gte: since } }),
    Review.countDocuments({ sentimentAnalyzedAt: null, createdAt: { $gte: since } }),
  ]);

  const map = { positive: 0, neutral: 0, negative: 0 };
  const avgRatings = {};
  for (const b of breakdown) {
    map[b._id] = b.count;
    avgRatings[b._id] = b.avgRating;
  }

  const analyzed = total - unanalyzed;
  const score    = analyzed > 0
    ? Math.round(((map.positive - map.negative) / analyzed) * 100)
    : 0;

  return { breakdown: map, avgRatings, total, analyzed, unanalyzed, score, days };
}

// ── Watcher integration ───────────────────────────────────────────────────────

async function runSentimentWatcherCycle(telegram) {
  try {
    await runBatchSentimentScan();
    await checkNegativeReviewAlert(telegram);
  } catch (err) {
    console.error('[SentimentService] Watcher cycle error:', err.message);
  }
}

module.exports = {
  analyzeAndSave,
  runBatchSentimentScan,
  checkNegativeReviewAlert,
  getSentimentStats,
  runSentimentWatcherCycle,
  classifySentiment,
};
