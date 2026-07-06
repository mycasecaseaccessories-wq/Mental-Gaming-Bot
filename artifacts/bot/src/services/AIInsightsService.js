/**
 * AIInsightsService — Gemini-powered business intelligence. (AI Module 4)
 *
 * Analyzes historical order + revenue data and generates:
 *   1. Monthly Business Report
 *      - Trending game analysis ("Mobile Legends is up 32% this month")
 *      - Sales forecast for next 7 days
 *      - Flash sale recommendations based on conversion patterns
 *      - High-level commentary
 *
 *   2. Daily Brief — quick snapshot with 3 actionable insights
 *   3. Sales Forecast — numeric next-7-day prediction with reasoning
 *
 * All calls use the existing callGemini pattern from aiService.js.
 * Falls back gracefully if AI_API_KEY is not set.
 */

const axios    = require('axios');
const { config } = require('../../config/settings');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiUrl(endpoint) {
  return `${GEMINI_BASE}/${GEMINI_MODEL}:${endpoint}?key=${config.ai.apiKey}`;
}

async function callGemini(systemPrompt, userPrompt, { maxTokens = 600, temperature = 0.7 } = {}) {
  try {
    const { data } = await axios.post(
      geminiUrl('generateContent'),
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    if (err.response?.status === 429) {
      throw new Error('AI rate limit reached — please wait a few minutes before trying again.');
    }
    throw err;
  }
}

// ── Data formatters ───────────────────────────────────────────────────────────

function fmt(n) { return Math.round(n || 0).toLocaleString(); }

function formatReportData(report) {
  const { revenue, products, categories, users, trend, cancellation, peak, meta } = report;

  const productLines = (products || []).slice(0, 8).map((p, i) =>
    `${i + 1}. ${p.name} (${p.category}): ${p.count} orders, ${fmt(p.revenue)} KS revenue`
  ).join('\n');

  const categoryLines = (categories || []).slice(0, 6).map((c) =>
    `- ${c._id}: ${c.count} orders, ${fmt(c.revenue)} KS`
  ).join('\n');

  const trendLines = (trend || []).slice(-14).map((d) =>
    `${d.date}: ${d.orders} orders, ${fmt(d.revenue)} KS revenue, ${fmt(d.topups)} KS topups`
  ).join('\n');

  return (
    `=== MENTAL GAMING STORE — ANALYTICS SNAPSHOT ===\n` +
    `Period: ${meta.label}\n` +
    `Report Generated: ${new Date(meta.generatedAt).toISOString()}\n\n` +

    `--- REVENUE ---\n` +
    `Gross Revenue: ${fmt(revenue.grossRevenue)} KS\n` +
    `Net Revenue: ${fmt(revenue.netRevenue)} KS (after refunds)\n` +
    `Estimated Net Profit: ${fmt(revenue.netProfit)} KS (~${revenue.estimatedMarginPct}% margin)\n` +
    `Refunds: ${fmt(revenue.refunds.total)} KS (${revenue.refunds.count} transactions)\n` +
    `Wallet Top-ups: ${fmt(revenue.topups.total)} KS (${revenue.topups.count} transactions)\n\n` +

    `--- ORDERS ---\n` +
    `Total Orders: ${revenue.orderCount}\n` +
    `Cancellation Rate: ${cancellation.rate}% (${cancellation.cancelled} cancelled)\n` +
    (peak ? `Peak Hour: ${peak.hour}:00 (${peak.count} orders)\n` : '') + '\n' +

    `--- TOP PRODUCTS ---\n${productLines}\n\n` +
    `--- GAME CATEGORIES ---\n${categoryLines}\n\n` +

    `--- USER METRICS ---\n` +
    `Total Users: ${users.totalUsers}\n` +
    `New Users This Period: ${users.newUsers}\n` +
    (users.growthRate !== null ? `Growth vs Previous Period: ${users.growthRate > 0 ? '+' : ''}${users.growthRate}%\n` : '') +
    `Active Users (placed order): ${users.activeUsers}\n` +
    (users.retentionRate !== null ? `Returning User Activity Rate: ${users.retentionRate}%\n` : '') + '\n' +

    `--- DAILY TREND (last 14 days) ---\n${trendLines}\n`
  );
}

function formatHistoricalForForecast(trendData) {
  if (!trendData?.length) return 'No historical data available.';
  return trendData.map((d) =>
    `${d.date}: ${d.orders} orders, ${fmt(d.revenue)} KS`
  ).join('\n');
}

// ── Monthly Business Report ───────────────────────────────────────────────────

async function generateMonthlyReport(report) {
  if (!config.ai.apiKey) {
    return '⚠️ AI insights require an AI_API_KEY. Please configure it in settings.';
  }

  const dataStr = formatReportData(report);
  const topCategories = (report.categories || []).slice(0, 3).map((c) => c._id).join(', ');

  const systemPrompt =
    `You are a senior business analyst and financial advisor for a Telegram-based gaming store in Myanmar called "Mental Gaming Store".
The store sells game top-ups (Mobile Legends diamonds, Free Fire diamonds, PUBG UC, Genshin crystals, Valorant VP, gift cards etc.) to Myanmar gamers.
Currency is KS (Kyat Store = Myanmar Kyat). The store uses manual delivery by admins plus an API layer for automated deliveries.

Your role: Analyze the provided store performance data and write a professional, actionable monthly business report.

IMPORTANT RULES:
- Write in clear English, keep it practical and specific
- Use actual numbers from the data — never make up figures
- Keep the total report under 600 words
- Format with clear section headers using emoji
- Be direct about what is working and what needs attention
- Focus on actionable recommendations the store owner can act on TODAY`;

  const userPrompt =
    `Please analyze this store performance data and write a comprehensive business report:\n\n` +
    `${dataStr}\n\n` +
    `Structure your report with these EXACT sections:\n\n` +
    `📈 PERFORMANCE OVERVIEW\n(2-3 sentences on overall health)\n\n` +
    `🎮 TRENDING GAMES\n(Which game/category is gaining momentum and why)\n\n` +
    `🔮 SALES FORECAST (Next 7 Days)\n(Based on the daily trend, predict next week revenue with % confidence. Mention any weekday/weekend patterns.)\n\n` +
    `⚡ FLASH SALE RECOMMENDATION\n(Identify 1-2 specific products where interest is high but conversion is low, or stock is high. Recommend exact flash sale discount %)\n\n` +
    `⚠️ ATTENTION NEEDED\n(Any concerning patterns: high cancellation, low retention, payment method issues, slow days)\n\n` +
    `✅ TOP 3 ACTION ITEMS\n(Numbered list of the 3 most impactful things the admin should do this week)`;

  try {
    const result = await callGemini(systemPrompt, userPrompt, { maxTokens: 900, temperature: 0.6 });
    return result || 'Unable to generate insights at this time. Please try again.';
  } catch (err) {
    console.error('[AIInsightsService] Monthly report failed:', err.message);
    throw new Error(`AI report generation failed: ${err.message}`);
  }
}

// ── Daily Brief ───────────────────────────────────────────────────────────────

async function generateDailyBrief(report) {
  if (!config.ai.apiKey) return null;

  const { revenue, products, users, cancellation } = report;
  const topProduct = products?.[0];

  const dataStr =
    `Today's Revenue: ${fmt(revenue.grossRevenue)} KS from ${revenue.orderCount} orders\n` +
    `Refunds: ${fmt(revenue.refunds.total)} KS\n` +
    `New Users: ${users.newUsers}\n` +
    `Active Users: ${users.activeUsers}\n` +
    `Cancellation Rate: ${cancellation.rate}%\n` +
    `Top Product: ${topProduct ? `${topProduct.name} (${topProduct.count} orders, ${fmt(topProduct.revenue)} KS)` : 'No data'}`;

  const systemPrompt =
    `You are a concise business analyst for Mental Gaming Store (Myanmar gaming top-up bot).
    Write a SHORT daily performance brief. Max 3 bullet points. Each point = one insight + one action. Be very specific.`;

  const userPrompt = `Today's data:\n${dataStr}\n\nWrite a 3-bullet daily business brief.`;

  try {
    return await callGemini(systemPrompt, userPrompt, { maxTokens: 200, temperature: 0.5 });
  } catch {
    return null;
  }
}

// ── Sales Forecast ────────────────────────────────────────────────────────────

async function generateSalesForecast(historicalTrend) {
  if (!config.ai.apiKey) {
    return '⚠️ AI forecasting requires an AI_API_KEY.';
  }

  if (!historicalTrend?.length) {
    return '📊 Not enough historical data for forecasting (need at least 14 days of order history).';
  }

  const dataStr = formatHistoricalForForecast(historicalTrend);

  const systemPrompt =
    `You are a quantitative sales forecaster for a Myanmar gaming store.
Analyze daily revenue patterns and provide a 7-day revenue forecast.
Always show your reasoning (day-of-week patterns, trends, anomalies).
Format forecasts as a table with columns: Day | Predicted Orders | Predicted Revenue (KS) | Confidence
Be specific with numbers. Use the historical mean as baseline and adjust for patterns.`;

  const userPrompt =
    `Historical daily data (last ${historicalTrend.length} days):\n\n${dataStr}\n\n` +
    `Tasks:\n` +
    `1. Identify key patterns (e.g., weekends are higher, month-end spikes)\n` +
    `2. Forecast the next 7 days in a table format\n` +
    `3. Give an overall confidence rating for the forecast\n` +
    `4. List any assumptions or caveats`;

  try {
    const result = await callGemini(systemPrompt, userPrompt, { maxTokens: 700, temperature: 0.4 });
    return result || 'Unable to generate forecast.';
  } catch (err) {
    console.error('[AIInsightsService] Forecast failed:', err.message);
    throw new Error(`Forecast generation failed: ${err.message}`);
  }
}

// ── Flash Sale Recommender ────────────────────────────────────────────────────

async function getFlashSaleRecommendations(report) {
  if (!config.ai.apiKey) return null;

  const { products, categories } = report;
  if (!products?.length) return null;

  const productStr = products.map((p, i) =>
    `${i + 1}. ${p.name} (${p.category}/${p.region}): ${p.count} orders, ${fmt(p.revenue)} KS, avg order ${fmt(p.avgOrder)} KS`
  ).join('\n');

  const systemPrompt =
    `You are a promotions strategist for a gaming store. Identify 2 products for a flash sale.
Rules: pick products with moderate order count (demand exists) but NOT the #1 bestseller (already selling well).
Recommend specific discount percentages between 10-25%.
Keep your answer concise: product name, recommended discount, and one-line reason.`;

  const userPrompt =
    `Products ranked by revenue:\n${productStr}\n\n` +
    `Recommend exactly 2 products for a flash sale this week. Format:\n` +
    `1. [Product Name] — [X]% off — Reason: [one sentence]\n` +
    `2. [Product Name] — [X]% off — Reason: [one sentence]`;

  try {
    return await callGemini(systemPrompt, userPrompt, { maxTokens: 150, temperature: 0.5 });
  } catch {
    return null;
  }
}

module.exports = {
  generateMonthlyReport,
  generateDailyBrief,
  generateSalesForecast,
  getFlashSaleRecommendations,
};
