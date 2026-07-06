const { adminOnly } = require('../middlewares/adminCheck');
const { getTheme } = require('../services/ThemeService');
const { getAllRates } = require('../services/currencyService');
const { buildMessage, stat, divider, price } = require('../utils/ui');
const { pulseLoading, resolveMessage } = require('../utils/animations');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const SystemStatus = require('../models/SystemStatus');
const { Markup } = require('telegraf');

function gatewayIcon(status) {
  return status === 'Online' ? '🟢' : status === 'Busy' ? '🟡' : '🔴';
}

async function buildDashboardText(theme) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [
    ordersToday,
    pendingOrders,
    totalUsers,
    totalProducts,
    successToday,
    rates,
    sysStatus,
  ] = await Promise.all([
    Order.countDocuments({ timestamp: { $gte: startOfDay } }),
    Order.countDocuments({ status: 'Pending' }),
    User.countDocuments({}),
    Product.countDocuments({ isActive: true }),
    Order.countDocuments({ status: 'Success', timestamp: { $gte: startOfDay } }),
    getAllRates(),
    SystemStatus.get(),
  ]);

  const recentOrders = await Order.find({ status: 'Pending' })
    .populate('userId', 'username telegramId')
    .populate('productId', 'name')
    .sort({ timestamp: -1 })
    .limit(5);

  const rateLines = rates.map(
    (r) => `  ${r.currencyCode}: \`${parseFloat(r.rateToMMK.toFixed(4))}\` MMK`
  );

  const pendingLines = recentOrders.length
    ? recentOrders.map((o, i) => {
        const user = o.userId?.username ? `@${o.userId.username}` : `ID:${o.userId?.telegramId}`;
        const product = o.productId?.name || 'Unknown';
        return `  ${i + 1}. ${user} → ${product} — \`${price(o.amount)}\``;
      })
    : ['  _No pending orders_'];

  // Gateway status display
  const gwLines = [
    `  ${gatewayIcon(sysStatus.kpayStatus)} KBZ Pay: *${sysStatus.kpayStatus}*`,
    `  ${gatewayIcon(sysStatus.waveStatus)} Wave Money: *${sysStatus.waveStatus}*`,
    `  ${gatewayIcon(sysStatus.ayaStatus)} AYA Pay: *${sysStatus.ayaStatus}*`,
    `  ${gatewayIcon(sysStatus.cbStatus)} CB Pay: *${sysStatus.cbStatus}*`,
  ];
  if (sysStatus.gatewayNote) {
    gwLines.push(`  📝 _${sysStatus.gatewayNote}_`);
  }

  const sep = divider(theme);

  return buildMessage(theme, [
    {
      title: `📊 Admin Dashboard`,
      lines: [
        `🕐 ${now.toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} (MMT)`,
      ],
    },
    {
      title: null,
      lines: [
        `${sep}`,
        `📦 *Orders Today*`,
        stat('🔵', 'Total Today', ordersToday),
        stat('✅', 'Successful', successToday),
        stat('🟡', 'Pending',    pendingOrders),
        ``,
        `👥 *Store Stats*`,
        stat('👤', 'Total Users',    totalUsers),
        stat('🛍️', 'Active Products', totalProducts),
        ``,
        `💳 *Payment Gateways*`,
        ...gwLines,
        ``,
        `💱 *Exchange Rates*`,
        ...rateLines,
        ``,
        `🟡 *Recent Pending Orders*`,
        ...pendingLines,
        sep,
      ],
    },
  ]);
}

module.exports = function registerDashboard(bot) {
  bot.command('dashboard', adminOnly(), async (ctx) => {
    const ref = await pulseLoading(ctx, 'Loading Dashboard', 3, 400);
    try {
      const theme = getTheme(ctx.user);
      const text = await buildDashboardText(theme);

      await resolveMessage(ctx, ref, text, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'dashboard_refresh')],
          [Markup.button.callback('📦 View Pending', 'admin_pending_orders')],
          [Markup.button.callback('📊 Analytics', 'dashboard_analytics')],
          [Markup.button.callback('💱 Manage Rates', 'open_rate_manager')],
          [Markup.button.callback('🖥 System Health', 'dashboard_syshealth')],
          [Markup.button.callback('🛍️ Mini App Button', 'miniapp_panel')],
        ]),
      });
    } catch (err) {
      await resolveMessage(ctx, ref, `❌ Dashboard error: ${err.message}`);
    }
  });

  bot.hears('📊 Dashboard', adminOnly(), async (ctx) => {
    const ref = await pulseLoading(ctx, 'Loading Dashboard', 3, 400);
    try {
      const theme = getTheme(ctx.user);
      const text = await buildDashboardText(theme);
      await resolveMessage(ctx, ref, text, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'dashboard_refresh')],
          [Markup.button.callback('📦 View Pending', 'admin_pending_orders')],
          [Markup.button.callback('📊 Analytics', 'dashboard_analytics')],
          [Markup.button.callback('💱 Manage Rates', 'open_rate_manager')],
          [Markup.button.callback('🖥 System Health', 'dashboard_syshealth')],
          [Markup.button.callback('🛍️ Mini App Button', 'miniapp_panel')],
        ]),
      });
    } catch (err) {
      await resolveMessage(ctx, ref, `❌ Dashboard error: ${err.message}`);
    }
  });

  bot.action('dashboard_refresh', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Refreshing...');
    try {
      const theme = getTheme(ctx.user);
      const text = await buildDashboardText(theme);
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'dashboard_refresh')],
          [Markup.button.callback('📦 View Pending', 'admin_pending_orders')],
          [Markup.button.callback('📊 Analytics', 'dashboard_analytics')],
          [Markup.button.callback('💱 Manage Rates', 'open_rate_manager')],
          [Markup.button.callback('🖥 System Health', 'dashboard_syshealth')],
          [Markup.button.callback('🛍️ Mini App Button', 'miniapp_panel')],
        ]),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action('dashboard_analytics', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('📊 Use /analytics to view the full analytics dashboard, or choose a shortcut:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('📅 Today',   'analytics:today'),
          Markup.button.callback('📆 Week',    'analytics:week'),
        ],
        [
          Markup.button.callback('🤖 AI Report', 'analyticsai_run:month'),
          Markup.button.callback('🖥 Health',    'systemhealth_refresh'),
        ],
      ])
    );
  });

  bot.action('dashboard_syshealth', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    // Directly show system health inline without switching command
    const mongoose = require('mongoose');
    const status = await SystemStatus.get();
    const pendingOrders = await Order.countDocuments({ status: 'Pending' });
    const uptimeSec = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    const heapUsedMB  = Math.round(mem.heapUsed  / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const dbState = ['Disconnected', 'Connected', 'Connecting', 'Disconnecting'];
    const dbStatus = dbState[mongoose.connection.readyState] || 'Unknown';
    const dbIcon   = mongoose.connection.readyState === 1 ? '🟢' : '🔴';
    const gwStatus = [
      `  ${gatewayIcon(status.kpayStatus)} *KBZ Pay*: ${status.kpayStatus}`,
      `  ${gatewayIcon(status.waveStatus)} *Wave Money*: ${status.waveStatus}`,
      `  ${gatewayIcon(status.ayaStatus)} *AYA Pay*: ${status.ayaStatus}`,
      `  ${gatewayIcon(status.cbStatus)} *CB Pay*: ${status.cbStatus}`,
    ].join('\n');
    const gwNote = status.gatewayNote ? `\n  📝 _${status.gatewayNote}_` : '';
    await ctx.reply(
      `🖥 *System Health*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
      `⏱ Uptime: *${Math.floor(uptimeSec/3600)}h ${Math.floor((uptimeSec%3600)/60)}m*\n` +
      `${dbIcon} DB: *${dbStatus}*\n` +
      `💾 Memory: *${heapUsedMB}MB / ${heapTotalMB}MB*\n` +
      `🟡 Pending Orders: *${pendingOrders}*\n\n` +
      `💳 *Gateways*\n${gwStatus}${gwNote}\n\n` +
      `_/setgateway <method> <Online|Busy|Offline>_`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('admin_pending_orders', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const orders = await Order.find({ status: 'Pending' })
      .populate('userId', 'username telegramId')
      .populate('productId', 'name finalPrice')
      .sort({ timestamp: -1 })
      .limit(10);

    if (!orders.length) return ctx.reply('✅ No pending orders right now.');

    const theme = getTheme(ctx.user);
    const lines = orders.map((o, i) => {
      const user = o.userId?.username ? `@${o.userId.username}` : `ID:${o.userId?.telegramId}`;
      const product = o.productId?.name || 'Unknown';
      const ts = new Date(o.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Rangoon' });
      return `${i + 1}\\. ${user} — *${product}* — \`${price(o.amount)}\` _(${ts})_`;
    });

    await ctx.reply(
      `📦 *Pending Orders (${orders.length})*\n\n${lines.join('\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard', 'dashboard_refresh')]]),
      }
    );
  });

  // ── Mini App Button Admin Panel ─────────────────────────────────────────────

  async function buildMiniAppPanelText(status) {
    const env = process.env.MINI_APP_URL ||
      (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(',')[0].trim()}/` : null) ||
      (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}/` : null) ||
      '_(not set)_';
    const activeUrl = status.miniAppButtonUrl || env;
    const statusIcon = status.miniAppButtonEnabled !== false ? '🟢 Enabled' : '🔴 Disabled';
    return (
      `🛍️ *Mini App Reply-Keyboard Button*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `Status: *${statusIcon}*\n` +
      `Button text: \`${status.miniAppButtonText || '🛍️ Mental Gaming Store'}\`\n` +
      `Active URL: \`${activeUrl}\`\n` +
      `DB URL override: \`${status.miniAppButtonUrl || '_(uses env var)_'}\`\n\n` +
      `_The button appears above the message input when users press /start._\n\n` +
      `Commands:\n` +
      `• /setminiapptext <text> — change button label\n` +
      `• /setminiappurl <url> — override URL\n` +
      `• /clearminiappurl — revert to env var`
    );
  }

  bot.action('miniapp_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const status = await SystemStatus.get();
    const text = await buildMiniAppPanelText(status);
    const toggleLabel = status.miniAppButtonEnabled !== false ? '🔴 Disable Button' : '🟢 Enable Button';
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(toggleLabel, 'miniapp_toggle')],
        [Markup.button.callback('🔙 Dashboard', 'dashboard_refresh')],
      ]),
    });
  });

  bot.action('miniapp_toggle', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const status = await SystemStatus.get();
    const newVal = !(status.miniAppButtonEnabled !== false);
    await SystemStatus.set({ miniAppButtonEnabled: newVal }, ctx.from.id);
    const updated = await SystemStatus.get();
    const text = await buildMiniAppPanelText(updated);
    const toggleLabel = updated.miniAppButtonEnabled !== false ? '🔴 Disable Button' : '🟢 Enable Button';
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(toggleLabel, 'miniapp_toggle')],
        [Markup.button.callback('🔙 Dashboard', 'dashboard_refresh')],
      ]),
    });
  });

  bot.command('setminiapptext', adminOnly(), async (ctx) => {
    const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!text) return ctx.reply('Usage: /setminiapptext <button label>\nExample: /setminiapptext 🛍️ Open Store');
    await SystemStatus.set({ miniAppButtonText: text }, ctx.from.id);
    return ctx.reply(`✅ Mini App button text set to:\n\`${text}\`\n\n_Press /start to see the updated keyboard._`, { parse_mode: 'Markdown' });
  });

  bot.command('setminiappurl', adminOnly(), async (ctx) => {
    const url = ctx.message.text.split(' ')[1]?.trim();
    if (!url || !url.startsWith('https://')) return ctx.reply('Usage: /setminiappurl <https://...>\nMust be an HTTPS URL.');
    await SystemStatus.set({ miniAppButtonUrl: url }, ctx.from.id);
    return ctx.reply(`✅ Mini App button URL set to:\n\`${url}\`\n\n_Press /start to see the updated keyboard._`, { parse_mode: 'Markdown' });
  });

  bot.command('clearminiappurl', adminOnly(), async (ctx) => {
    await SystemStatus.set({ miniAppButtonUrl: null }, ctx.from.id);
    return ctx.reply('✅ Mini App URL override cleared — bot will use env var (MINI_APP_URL / REPLIT_DEV_DOMAIN).', { parse_mode: 'Markdown' });
  });
};
