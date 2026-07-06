/**
 * Analytics Command Suite — Admin Financial Analytics Dashboard with AI Insights
 *
 * MANAGER+:
 *   /analytics [today|yesterday|week|month]  — full analytics dashboard
 *   /analyticsai [today|yesterday|week|month] — Gemini monthly business report
 *   /forecast                                 — 7-day AI sales forecast
 *   /sentimentreport                          — AI sentiment analysis of reviews
 *   /systemhealth                             — real-time system status
 *   /exportdetail [orders|transactions|users] [period] — enhanced CSV export
 *
 * OWNER:
 *   /setgateway <method> <Online|Busy|Offline> — toggle payment gateway status
 *   /setgatewaynote [message]                   — set note shown with gateway status
 */

const { Markup }          = require('telegraf');
const { requireRole, adminOnly } = require('../middlewares/adminCheck');
const AnalyticsService    = require('../services/AnalyticsService');
const AIInsightsService   = require('../services/AIInsightsService');
const SentimentService    = require('../services/SentimentService');
const ExportService       = require('../services/ExportService');
const SystemStatus        = require('../models/SystemStatus');
const { auditLog }        = require('../services/logger');
const { config }          = require('../../config/settings');

const VALID_PERIODS = ['today', 'yesterday', 'week', 'month'];
const VALID_GATEWAYS = ['kpay', 'wave', 'aya', 'cb'];
const GATEWAY_LABELS = { kpay: 'KBZ Pay', wave: 'Wave Money', aya: 'AYA Pay', cb: 'CB Pay' };

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n) { return Math.round(n || 0).toLocaleString(); }

function gatewayIcon(status) {
  return status === 'Online' ? '🟢' : status === 'Busy' ? '🟡' : '🔴';
}

function trendBar(value, max, width = 10) {
  if (!max || max === 0) return '░'.repeat(width);
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Analytics dashboard text builder ─────────────────────────────────────────

function buildAnalyticsText(report) {
  const { meta, revenue, products, categories, users, gateway, cancellation, peak } = report;
  const fmt = (n) => Math.round(n || 0).toLocaleString();

  // Top products (max 5)
  const topProductLines = (products || []).slice(0, 5).map((p, i) =>
    `  ${i + 1}. *${p.name.slice(0, 28)}* — ${p.count} orders — ${fmt(p.revenue)} KS`
  ).join('\n') || '  _No orders in this period_';

  // Category breakdown (max 4)
  const maxCatRev = Math.max(...(categories || []).map((c) => c.revenue), 1);
  const categoryLines = (categories || []).slice(0, 4).map((c) => {
    const bar = trendBar(c.revenue, maxCatRev, 8);
    const pct = revenue.grossRevenue > 0 ? Math.round((c.revenue / revenue.grossRevenue) * 100) : 0;
    return `  \`${bar}\` *${c._id}* ${pct}% — ${fmt(c.revenue)} KS`;
  }).join('\n') || '  _No data_';

  // Gateway breakdown
  const gwLines = (gateway || []).slice(0, 4).map((g) =>
    `  💳 *${g._id || 'Unknown'}*: ${g.count}× — ${fmt(g.total)} KS`
  ).join('\n') || '  _No top-ups_';

  // User join source (top 3)
  const joinLines = (users.joinSources || []).slice(0, 3).map((j) =>
    `  ${j._id === 'referral' ? '🔗' : j._id === 'channel' ? '📢' : j._id === 'direct' ? '🔍' : '•'} ${j._id || 'unknown'}: ${j.count}`
  ).join('\n');

  const growthStr = users.growthRate !== null
    ? ` (${users.growthRate >= 0 ? '↑' : '↓'}${Math.abs(users.growthRate)}% vs prev)`
    : '';

  return (
    `📊 *Analytics Dashboard*\n` +
    `📅 _${meta.label}_\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +

    `💰 *Revenue*\n` +
    `  Gross: *${fmt(revenue.grossRevenue)} KS*\n` +
    `  Refunds: −${fmt(revenue.refunds.total)} KS (${revenue.refunds.count}×)\n` +
    `  Net: *${fmt(revenue.netRevenue)} KS*\n` +
    `  Est. Net Profit: *~${fmt(revenue.netProfit)} KS* (${revenue.estimatedMarginPct}%)\n\n` +

    `📦 *Orders*\n` +
    `  ✅ Completed: *${revenue.orderCount}*\n` +
    `  ❌ Cancelled: ${cancellation.cancelled} (${cancellation.rate}% rate)\n` +
    `  💳 Top-ups: ${revenue.topups.count}× — ${fmt(revenue.topups.total)} KS\n` +
    (peak ? `  🕐 Peak Hour: ${peak.hour}:00 (${peak.count} orders)\n` : '') + '\n' +

    `🏆 *Top Products*\n${topProductLines}\n\n` +

    `📂 *By Category*\n${categoryLines}\n\n` +

    `💳 *Top-Up Methods*\n${gwLines}\n\n` +

    `👥 *Users*\n` +
    `  New: *+${users.newUsers}*${growthStr}\n` +
    `  Active: *${users.activeUsers}*\n` +
    `  Total: ${users.totalUsers}\n` +
    (users.retentionRate !== null ? `  Retention: ${users.retentionRate}%\n` : '') +
    (joinLines ? `  Sources:\n${joinLines}\n` : '') +
    `\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `_🤖 Use /analyticsai for AI insights_`
  );
}

// ── Period selector keyboard ──────────────────────────────────────────────────

function periodKeyboard(prefix) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📅 Today',     `${prefix}:today`),
      Markup.button.callback('⬅️ Yesterday', `${prefix}:yesterday`),
    ],
    [
      Markup.button.callback('📆 This Week', `${prefix}:week`),
      Markup.button.callback('🗓 30 Days',   `${prefix}:month`),
    ],
  ]);
}

// ── Export keyboard ───────────────────────────────────────────────────────────

function exportKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📦 Orders',    'exportdetail:orders:week'),
      Markup.button.callback('💳 Transactions', 'exportdetail:transactions:week'),
    ],
    [
      Markup.button.callback('👥 Users',     'exportdetail:users:month'),
    ],
  ]);
}

// ── /analytics ────────────────────────────────────────────────────────────────

module.exports = function registerAnalytics(bot) {

  bot.command('analytics', requireRole('MANAGER'), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    const period = VALID_PERIODS.includes(arg) ? arg : 'today';

    const waitMsg = await ctx.reply('⏳ _Loading analytics..._', { parse_mode: 'Markdown' });
    try {
      const report = await AnalyticsService.getFullReport(period);
      const text   = buildAnalyticsText(report);

      await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📅 Today',     'analytics:today'),
            Markup.button.callback('⬅️ Yesterday', 'analytics:yesterday'),
          ],
          [
            Markup.button.callback('📆 Week', 'analytics:week'),
            Markup.button.callback('🗓 30 Days', 'analytics:month'),
          ],
          [
            Markup.button.callback('🤖 AI Insights', `analyticsai_run:${period}`),
            Markup.button.callback('📥 Export', 'analytics_export_menu'),
          ],
        ]),
      });
    } catch (err) {
      console.error('[Analytics] /analytics failed:', err);
      await ctx.telegram
        .editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined, `❌ Analytics error: ${err.message}`)
        .catch(async () => {
          await ctx.reply(`❌ Analytics error: ${err.message}`).catch(() => {});
        });
    }
  });

  // Period switcher callbacks
  bot.action(/^analytics:(today|yesterday|week|month)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const period = ctx.match[1];
    try {
      const report = await AnalyticsService.getFullReport(period);
      const text   = buildAnalyticsText(report);

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📅 Today',     'analytics:today'),
            Markup.button.callback('⬅️ Yesterday', 'analytics:yesterday'),
          ],
          [
            Markup.button.callback('📆 Week', 'analytics:week'),
            Markup.button.callback('🗓 30 Days', 'analytics:month'),
          ],
          [
            Markup.button.callback('🤖 AI Insights', `analyticsai_run:${period}`),
            Markup.button.callback('📥 Export', 'analytics_export_menu'),
          ],
        ]),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action('analytics_export_menu', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📥 *Export Report*\n\nChoose what to export (last 7 days):`,
      { parse_mode: 'Markdown', ...exportKeyboard() }
    );
  });

  // ── /analyticsai ────────────────────────────────────────────────────────────

  bot.command('analyticsai', requireRole('MANAGER'), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    const period = VALID_PERIODS.includes(arg) ? arg : 'month';

    const waitMsg = await ctx.reply(
      `🤖 _Generating AI business report for ${period}…_\n_This takes 10-20 seconds._`,
      { parse_mode: 'Markdown' }
    );

    try {
      const report = await AnalyticsService.getFullReport(period);
      const insights = await AIInsightsService.generateMonthlyReport(report);

      await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});

      // Split long reports into chunks (Telegram 4096 char limit)
      const MAX = 3800;
      if (insights.length <= MAX) {
        await ctx.reply(`🤖 *AI Business Report*\n📅 _${report.meta.label}_\n\n${insights}`, {
          parse_mode: 'Markdown',
          ...periodKeyboard('analyticsai_run'),
        });
      } else {
        await ctx.reply(`🤖 *AI Business Report*\n📅 _${report.meta.label}_`, { parse_mode: 'Markdown' });
        for (let i = 0; i < insights.length; i += MAX) {
          await ctx.reply(insights.slice(i, i + MAX), { parse_mode: 'Markdown' });
        }
        await ctx.reply('_Use the buttons to view a different period:_', { parse_mode: 'Markdown', ...periodKeyboard('analyticsai_run') });
      }

      await auditLog(ctx.from.id, 'AI_REPORT_GENERATED', null, 'System', { period });
    } catch (err) {
      await ctx.telegram.editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined,
        `❌ AI report failed: ${err.message}`);
    }
  });

  // AI insights triggered from analytics dashboard button
  bot.action(/^analyticsai_run:(today|yesterday|week|month)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Generating AI report…');
    const period = ctx.match[1];
    try {
      const report   = await AnalyticsService.getFullReport(period);
      const insights = await AIInsightsService.generateMonthlyReport(report);
      const MAX = 3800;
      if (insights.length <= MAX) {
        await ctx.reply(`🤖 *AI Business Report*\n📅 _${report.meta.label}_\n\n${insights}`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(`🤖 *AI Business Report*\n📅 _${report.meta.label}_`, { parse_mode: 'Markdown' });
        for (let i = 0; i < insights.length; i += MAX) {
          await ctx.reply(insights.slice(i, i + MAX), { parse_mode: 'Markdown' });
        }
      }
    } catch (err) {
      await ctx.reply(`❌ AI insights error: ${err.message}`);
    }
  });

  // ── /forecast ────────────────────────────────────────────────────────────────

  bot.command('forecast', requireRole('MANAGER'), async (ctx) => {
    const waitMsg = await ctx.reply(
      `🔮 _Analyzing 90 days of data for forecasting…_\n_This may take ~20 seconds._`,
      { parse_mode: 'Markdown' }
    );

    try {
      const historicalTrend = await AnalyticsService.getHistoricalTrend(90);

      if (historicalTrend.length < 7) {
        await ctx.telegram.editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined,
          `⚠️ Not enough data for forecasting. Need at least 7 days of order history.`);
        return;
      }

      // Also get flash sale recommendations
      const report = await AnalyticsService.getFullReport('month');
      const [forecast, flashRecs] = await Promise.all([
        AIInsightsService.generateSalesForecast(historicalTrend),
        AIInsightsService.getFlashSaleRecommendations(report),
      ]);

      await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});

      await ctx.reply(
        `🔮 *7-Day Sales Forecast*\n` +
        `_Based on ${historicalTrend.length} days of historical data_\n\n` +
        `${forecast}`,
        { parse_mode: 'Markdown' }
      );

      if (flashRecs) {
        await ctx.reply(
          `⚡ *Flash Sale Recommendations*\n\n${flashRecs}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await ctx.telegram.editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined,
        `❌ Forecast error: ${err.message}`);
    }
  });

  // ── /sentimentreport ─────────────────────────────────────────────────────────

  bot.command('sentimentreport', requireRole('MANAGER'), async (ctx) => {
    const waitMsg = await ctx.reply('🔍 _Scanning reviews for sentiment…_', { parse_mode: 'Markdown' });

    try {
      const { processed, labels } = await SentimentService.runBatchSentimentScan();
      const stats = await SentimentService.getSentimentStats(30);

      await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});

      const { breakdown, total, analyzed, unanalyzed, score, days } = stats;
      const pctPos = analyzed > 0 ? Math.round((breakdown.positive / analyzed) * 100) : 0;
      const pctNeu = analyzed > 0 ? Math.round((breakdown.neutral  / analyzed) * 100) : 0;
      const pctNeg = analyzed > 0 ? Math.round((breakdown.negative / analyzed) * 100) : 0;

      const scoreBar = trendBar(score + 100, 200, 12); // -100 to +100 mapped to 0-200
      const scoreLabel = score >= 40 ? 'Excellent 🎉' : score >= 10 ? 'Good 👍' : score >= -10 ? 'Mixed 😐' : 'Poor 😟';

      await ctx.reply(
        `🧠 *Sentiment Analysis Report*\n` +
        `📅 _Last ${days} days — ${analyzed} reviews analyzed_\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
        `😊 Positive: *${breakdown.positive}* (${pctPos}%)\n` +
        `😐 Neutral:  *${breakdown.neutral}*  (${pctNeu}%)\n` +
        `😠 Negative: *${breakdown.negative}* (${pctNeg}%)\n\n` +
        `📊 Sentiment Score: *${score > 0 ? '+' : ''}${score}* — ${scoreLabel}\n` +
        `\`[${scoreBar}]\`\n\n` +
        `📝 Total Reviews: ${total}\n` +
        `✅ Analyzed: ${analyzed}\n` +
        `⏳ Unanalyzed: ${unanalyzed}\n` +
        (processed > 0 ? `\n🔄 _Just processed ${processed} new reviews_\n` : '') +
        `\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `_Alert threshold: ${3}+ negatives in 24h → owner notified_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Rescan Now', 'sentiment_rescan')],
          ]),
        }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined,
        `❌ Sentiment scan error: ${err.message}`);
    }
  });

  bot.action('sentiment_rescan', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Scanning…');
    try {
      const { processed } = await SentimentService.runBatchSentimentScan();
      await ctx.reply(`✅ Sentiment rescan complete — ${processed} reviews processed.`);
    } catch (err) {
      await ctx.reply(`❌ Rescan failed: ${err.message}`);
    }
  });

  // ── /systemhealth ─────────────────────────────────────────────────────────────

  bot.command('systemhealth', requireRole('MANAGER'), async (ctx) => {
    try {
      const mongoose = require('mongoose');
      const os       = require('os');

      const [status, pendingOrders] = await Promise.all([
        SystemStatus.get(),
        require('../models/Order').countDocuments({ status: 'Pending' }),
      ]);

      // System metrics
      const uptimeSec  = Math.floor(process.uptime());
      const uptimeH    = Math.floor(uptimeSec / 3600);
      const uptimeM    = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr  = `${uptimeH}h ${uptimeM}m`;

      const mem        = process.memoryUsage();
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotalMB= Math.round(mem.heapTotal / 1024 / 1024);

      const dbState    = ['Disconnected', 'Connected', 'Connecting', 'Disconnecting'];
      const dbStatus   = dbState[mongoose.connection.readyState] || 'Unknown';
      const dbIcon     = mongoose.connection.readyState === 1 ? '🟢' : '🔴';

      // Gateway status
      const gwStatus = [
        `  ${gatewayIcon(status.kpayStatus)} *KBZ Pay*: ${status.kpayStatus}`,
        `  ${gatewayIcon(status.waveStatus)} *Wave Money*: ${status.waveStatus}`,
        `  ${gatewayIcon(status.ayaStatus)} *AYA Pay*: ${status.ayaStatus}`,
        `  ${gatewayIcon(status.cbStatus)} *CB Pay*: ${status.cbStatus}`,
      ].join('\n');

      const gwNote = status.gatewayNote ? `\n  📝 _${status.gatewayNote}_\n` : '\n';

      // Mode indicators
      const modeLines = [
        status.maintenanceMode ? `  🔧 *MAINTENANCE MODE* ON` : null,
        status.holidayMode ? `  🎉 *HOLIDAY MODE* ON` : null,
        !status.referralEnabled ? `  🔗 Referral: OFF` : null,
      ].filter(Boolean).join('\n');

      await ctx.reply(
        `🖥 *System Health*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
        `⏱ *Bot Uptime:* ${uptimeStr}\n` +
        `${dbIcon} *Database:* ${dbStatus}\n` +
        `💾 *Memory:* ${heapUsedMB}MB / ${heapTotalMB}MB heap\n` +
        `🟡 *Pending Orders:* ${pendingOrders}\n\n` +
        `💳 *Payment Gateways*\n${gwStatus}${gwNote}\n` +
        (modeLines ? `⚠️ *Active Modes*\n${modeLines}\n\n` : '') +
        `🕐 _${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT_\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `_Use /setgateway to update payment statuses_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'systemhealth_refresh')],
          ]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ System health error: ${err.message}`);
    }
  });

  bot.action('systemhealth_refresh', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Refreshing…');
    // Re-trigger the full health check by calling the same logic
    const fakeCtx = { ...ctx, message: { text: '/systemhealth', from: ctx.from } };
    await ctx.deleteMessage().catch(() => {});

    try {
      const mongoose = require('mongoose');
      const [status, pendingOrders] = await Promise.all([
        SystemStatus.get(),
        require('../models/Order').countDocuments({ status: 'Pending' }),
      ]);
      const uptimeSec = Math.floor(process.uptime());
      const mem = process.memoryUsage();
      const heapUsedMB  = Math.round(mem.heapUsed  / 1024 / 1024);
      const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
      const dbState = ['Disconnected', 'Connected', 'Connecting', 'Disconnecting'];
      const dbStatus = dbState[require('mongoose').connection.readyState] || 'Unknown';
      const dbIcon   = require('mongoose').connection.readyState === 1 ? '🟢' : '🔴';
      const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
      const gwStatus = [
        `  ${gatewayIcon(status.kpayStatus)} *KBZ Pay*: ${status.kpayStatus}`,
        `  ${gatewayIcon(status.waveStatus)} *Wave Money*: ${status.waveStatus}`,
        `  ${gatewayIcon(status.ayaStatus)} *AYA Pay*: ${status.ayaStatus}`,
        `  ${gatewayIcon(status.cbStatus)} *CB Pay*: ${status.cbStatus}`,
      ].join('\n');

      await ctx.reply(
        `🖥 *System Health* _(refreshed)_\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
        `⏱ *Uptime:* ${uptimeStr}\n${dbIcon} *DB:* ${dbStatus}\n` +
        `💾 *Memory:* ${heapUsedMB}MB / ${heapTotalMB}MB\n🟡 *Pending:* ${pendingOrders}\n\n` +
        `💳 *Gateways*\n${gwStatus}\n\n🕐 _${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'systemhealth_refresh')]]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /setgateway <method> <status> ────────────────────────────────────────────

  bot.command('setgateway', adminOnly(), async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);

    if (parts.length < 2) {
      const status = await SystemStatus.get();
      const lines = VALID_GATEWAYS.map((g) => {
        const st = status[`${g}Status`];
        return `  ${gatewayIcon(st)} /setgateway ${g} \`Online|Busy|Offline\` — currently *${st}*`;
      }).join('\n');

      return ctx.reply(
        `💳 *Payment Gateway Status*\n\n` +
        `Current statuses:\n${lines}\n\n` +
        `Usage: \`/setgateway kpay Busy\``,
        { parse_mode: 'Markdown' }
      );
    }

    const [gatewayRaw, statusRaw] = parts;
    const gateway = gatewayRaw.toLowerCase();
    const newStatus = statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1).toLowerCase();

    if (!VALID_GATEWAYS.includes(gateway)) {
      return ctx.reply(`❌ Unknown gateway: \`${gateway}\`\nValid: ${VALID_GATEWAYS.join(', ')}`, { parse_mode: 'Markdown' });
    }

    if (!['Online', 'Busy', 'Offline'].includes(newStatus)) {
      return ctx.reply('❌ Invalid status. Use: `Online`, `Busy`, or `Offline`', { parse_mode: 'Markdown' });
    }

    const field = `${gateway}Status`;
    await SystemStatus.set({ [field]: newStatus }, ctx.from.id);
    await auditLog(ctx.from.id, 'GATEWAY_STATUS_CHANGED', null, 'System', { gateway, newStatus });

    await ctx.reply(
      `${gatewayIcon(newStatus)} *${GATEWAY_LABELS[gateway]}* status updated to *${newStatus}*\n\n` +
      `_Users will see this status in the /topup menu._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setgatewaynote ───────────────────────────────────────────────────────────

  bot.command('setgatewaynote', adminOnly(), async (ctx) => {
    const note = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();

    if (!note) {
      await SystemStatus.set({ gatewayNote: null }, ctx.from.id);
      return ctx.reply('✅ Gateway note cleared.');
    }

    await SystemStatus.set({ gatewayNote: note }, ctx.from.id);
    await ctx.reply(`✅ Gateway note set:\n_"${note}"_`, { parse_mode: 'Markdown' });
  });

  // ── /exportdetail ─────────────────────────────────────────────────────────────

  bot.command('exportdetail', requireRole('MANAGER'), async (ctx) => {
    const args   = ctx.message.text.split(/\s+/).slice(1);
    const type   = args[0]?.toLowerCase();
    const period = args[1]?.toLowerCase() || 'week';

    const VALID_TYPES = ['orders', 'transactions', 'users'];

    if (!type || !VALID_TYPES.includes(type)) {
      return ctx.reply(
        `📥 *Detailed Export*\n\n` +
        `Usage: \`/exportdetail <type> [period]\`\n\n` +
        `Types: \`orders\` | \`transactions\` | \`users\`\n` +
        `Periods: \`today\` | \`yesterday\` | \`week\` | \`month\`\n\n` +
        `Examples:\n` +
        `• \`/exportdetail orders week\`\n` +
        `• \`/exportdetail transactions month\`\n` +
        `• \`/exportdetail users month\``,
        { parse_mode: 'Markdown', ...exportKeyboard() }
      );
    }

    if (!VALID_PERIODS.includes(period)) {
      return ctx.reply('❌ Invalid period. Use: today, yesterday, week, month');
    }

    const waitMsg = await ctx.reply(`⏳ Generating ${type} export…`);
    try {
      const { start, end } = AnalyticsService.getDateRange(period);
      const { csv, filename, summary } = await ExportService.exportReport(type, start, end);

      await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});
      await ctx.reply(summary, { parse_mode: 'Markdown' });
      await ctx.replyWithDocument(
        { source: Buffer.from('\uFEFF' + csv, 'utf-8'), filename },
        { caption: `📎 \`${filename}\`\n_Open in Excel or Google Sheets_`, parse_mode: 'Markdown' }
      );
      await auditLog(ctx.from.id, 'DETAIL_EXPORT', null, 'System', { type, period });
    } catch (err) {
      await ctx.telegram.editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined,
        `❌ Export failed: ${err.message}`);
    }
  });

  // Inline export buttons from the export menu
  bot.action(/^exportdetail:(orders|transactions|users):(today|yesterday|week|month)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const [, type, period] = ctx.match;
    const waitMsg = await ctx.reply(`⏳ Generating ${type} export for ${period}…`);
    try {
      const { start, end } = AnalyticsService.getDateRange(period);
      const { csv, filename, summary } = await ExportService.exportReport(type, start, end);
      await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});
      await ctx.reply(summary, { parse_mode: 'Markdown' });
      await ctx.replyWithDocument(
        { source: Buffer.from('\uFEFF' + csv, 'utf-8'), filename },
        { caption: `📎 \`${filename}\``, parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(waitMsg.chat.id, waitMsg.message_id, undefined,
        `❌ ${err.message}`);
    }
  });
};
