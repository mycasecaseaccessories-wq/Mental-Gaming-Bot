/**
 * API Management Commands — Admin controls for external API integration.
 *
 * MANAGER+:
 *   /toggledelivery <productId>           — toggle Manual ↔ Auto delivery mode
 *   /setprovider <productId> <slug> <sku> — assign provider + product SKU
 *   /listproviders                        — show all provider health statuses
 *   /providerstats                        — API call stats (24h window)
 *   /testapi <productId>                  — dry-run API call (verifyPlayer only)
 *
 * OWNER:
 *   /setannouncechannel <@channel>        — set product announcement channel
 *   /announce <productId>                 — manually broadcast a product alert
 *   /webhookstats                         — webhook event processing stats
 */

const { Markup }   = require('telegraf');
const { requireRole, adminOnly } = require('../middlewares/adminCheck');
const {
  toggleDeliveryMode,
  setProviderConfig,
  checkAllProviders,
  getProviderStats,
  getProvider,
}                  = require('../services/ExternalApiService');
const {
  announceProductEverywhere,
  mdEsc,
}                  = require('../services/BroadcastService');
const { auditLog } = require('../services/logger');
const Product      = require('../models/Product');
const WebhookEvent = require('../models/WebhookEvent');
const SystemStatus = require('../models/SystemStatus');

const PROVIDER_LABELS = {
  smileone:  '🎮 SmileOne (MLBB / Genshin / FF)',
  unipin:    '🎰 UniPin (SEA region)',
  codashop:  '🛒 Codashop',
};

module.exports = function registerApiManagement(bot) {

  // ── /toggledelivery <productId> ───────────────────────────────────────────────

  bot.command('toggledelivery', requireRole('MANAGER'), async (ctx) => {
    const productId = ctx.message.text.split(/\s+/)[1];
    if (!productId) return ctx.reply(
      `Usage: \`/toggledelivery <productId>\`\n\n` +
      `_Get product IDs from /adminproducts_`,
      { parse_mode: 'Markdown' }
    );

    const product = await toggleDeliveryMode(productId);
    if (!product) return ctx.reply('❌ Product not found.');

    const icon = product.deliveryMode === 'Auto' ? '🤖' : '👤';
    await auditLog(ctx.from.id, 'PRODUCT_DELIVERY_TOGGLED', productId, 'System', { mode: product.deliveryMode });

    await ctx.reply(
      `${icon} *Delivery Mode Updated*\n\n` +
      `📦 Product: *${product.name}*\n` +
      `🔄 Mode: *${product.deliveryMode}*\n` +
      (product.deliveryMode === 'Auto' && product.apiProvider
        ? `🔌 Provider: *${product.apiProvider}*\n`
        : product.deliveryMode === 'Auto'
          ? `⚠️ No provider set — use /setprovider to configure.\n`
          : '') ,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setprovider <productId> <slug> <sku> ─────────────────────────────────────

  bot.command('setprovider', requireRole('MANAGER'), async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    if (parts.length < 3) {
      return ctx.reply(
        `*Set API Provider*\n\n` +
        `Usage: \`/setprovider <productId> <provider> <sku>\`\n\n` +
        `Available providers:\n` +
        Object.entries(PROVIDER_LABELS).map(([k, v]) => `• \`${k}\` — ${v}`).join('\n'),
        { parse_mode: 'Markdown' }
      );
    }

    const [productId, providerSlug, ...skuParts] = parts;
    const sku = skuParts.join(' ');

    if (!PROVIDER_LABELS[providerSlug]) {
      return ctx.reply(`❌ Unknown provider: \`${providerSlug}\`\n\nValid: ${Object.keys(PROVIDER_LABELS).join(', ')}`, { parse_mode: 'Markdown' });
    }

    const product = await setProviderConfig(productId, providerSlug, sku);
    if (!product) return ctx.reply('❌ Product not found.');

    await auditLog(ctx.from.id, 'PRODUCT_PROVIDER_SET', productId, 'System', { provider: providerSlug, sku });

    await ctx.reply(
      `✅ *Provider Configured*\n\n` +
      `📦 Product: *${product.name}*\n` +
      `🔌 Provider: *${PROVIDER_LABELS[providerSlug]}*\n` +
      `🆔 SKU: \`${sku}\`\n` +
      `🤖 Mode: *Auto*\n\n` +
      `_Orders will now be delivered automatically via ${providerSlug}._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /listproviders ────────────────────────────────────────────────────────────

  bot.command('listproviders', requireRole('MANAGER'), async (ctx) => {
    await ctx.reply('🔌 _Checking providers..._', { parse_mode: 'Markdown' });

    const statuses = await checkAllProviders();
    const lines = Object.values(statuses).map(({ slug, enabled, balance, currency, error }) => {
      if (error && !balance) {
        return `❌ *${slug}*: ${error.slice(0, 60)}`;
      }
      const balStr = balance !== null ? ` — 💰 ${balance} ${currency}` : '';
      return `${enabled ? '🟢' : '🔴'} *${slug}*${balStr}`;
    });

    await ctx.reply(
      `🔌 *Provider Health Check*\n\n${lines.join('\n')}\n\n` +
      `_Balance shown when provider API keys are configured._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /providerstats ────────────────────────────────────────────────────────────

  bot.command('providerstats', requireRole('MANAGER'), async (ctx) => {
    const stats = await getProviderStats(24);

    if (!stats.length) {
      return ctx.reply('📊 No API calls in the last 24 hours.');
    }

    const lines = stats.map(({ _id, total, success, avgDuration }) => {
      const successRate = total ? Math.round((success / total) * 100) : 0;
      const avgMs = avgDuration ? Math.round(avgDuration) : '—';
      return `*${_id}*: ${total} calls | ✅ ${successRate}% | ⏱ avg ${avgMs}ms`;
    });

    await ctx.reply(
      `📊 *API Stats (Last 24h)*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /testapi <productId> ──────────────────────────────────────────────────────

  bot.command('testapi', requireRole('MANAGER'), async (ctx) => {
    const productId = ctx.message.text.split(/\s+/)[1];
    if (!productId) return ctx.reply('Usage: /testapi <productId>');

    const product = await Product.findById(productId);
    if (!product) return ctx.reply('❌ Product not found.');
    if (!product.apiProvider) return ctx.reply('❌ No provider assigned to this product.');

    const provider = getProvider(product.apiProvider);
    if (!provider) return ctx.reply(`❌ Unknown provider: ${product.apiProvider}`);

    await ctx.reply(`🔌 Testing *${product.apiProvider}* connection...`, { parse_mode: 'Markdown' });

    try {
      const balance = await provider.checkBalance();
      await ctx.reply(
        `✅ *Provider Test Passed*\n\n` +
        `🔌 Provider: *${product.apiProvider}*\n` +
        `📦 Product SKU: \`${product.apiProductSku || 'Not set'}\`\n` +
        `💰 Balance: ${balance.balance !== null ? `${balance.balance} ${balance.currency}` : '_Not available_'}\n\n` +
        `_Player verification requires a real Game ID._`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Provider test failed: ${err.message}`);
    }
  });

  // ── /adminproducts — show products with API status ────────────────────────────

  bot.command('adminproducts', requireRole('MANAGER'), async (ctx) => {
    const products = await Product.find({ isActive: true }).sort({ category: 1 }).limit(20);
    if (!products.length) return ctx.reply('No active products.');

    const lines = products.map((p) => {
      const mode = p.deliveryMode === 'Auto' ? `🤖 ${p.apiProvider || 'no provider'}` : '👤 Manual';
      const sku  = p.apiProductSku ? ` [${p.apiProductSku}]` : '';
      return `\`${p._id.toString().slice(-6)}\` *${p.name.slice(0, 25)}* — ${mode}${sku}`;
    });

    await ctx.reply(
      `📦 *Products & Delivery Modes*\n\n${lines.join('\n')}\n\n` +
      `_Use /toggledelivery <id> to switch mode_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setannouncechannel <@channel> ────────────────────────────────────────────

  bot.command('setannouncechannel', adminOnly(), async (ctx) => {
    const channelId = ctx.message.text.split(/\s+/)[1];
    if (!channelId) {
      const status = await SystemStatus.get();
      return ctx.reply(
        `📢 *Announcement Channel*\n\nCurrent: ${status.announcementChannelId || '_Not set_'}\n\n` +
        `Usage: \`/setannouncechannel @channel_username\`\nor: \`/setannouncechannel -1001234567890\``,
        { parse_mode: 'Markdown' }
      );
    }

    await SystemStatus.set({ announcementChannelId: channelId }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_ANNOUNCE_CHANNEL', null, 'System', { channelId });

    await ctx.reply(
      `✅ Announcement channel set to: *${channelId}*\n\n` +
      `New products and flash sales will be posted there.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /announce — product broadcast to channel + ALL bot users ────────────────

  async function showAnnounceStyles(ctx, product) {
    const hasFlash = product.flashSalePrice > 0;
    const rows = [
      [Markup.button.callback('🆕 New Product ပုံစံ', `ann_send:new:${product._id}`)],
    ];
    if (hasFlash) rows.push([Markup.button.callback('⚡ Flash Sale ပုံစံ', `ann_send:flash:${product._id}`)]);
    rows.push([Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')]);

    await ctx.reply(
      `📣 *${mdEsc(product.name)}* ကို ကြေညာမယ်\n\n` +
      `Bot user အားလုံး + ကြေညာချက် channel နှစ်ခုလုံးကို ပို့ပါမယ်။\n` +
      `ပုံစံ ရွေးပါ:` +
      (hasFlash ? '' : `\n\n_⚡ Flash Sale ပုံစံ လိုချင်ရင် product မှာ flash sale price အရင် သတ်မှတ်ပါ။_`),
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  }

  async function showAnnouncePicker(ctx) {
    const products = await Product.find({ isActive: true })
      .sort({ updatedAt: -1 })
      .limit(15)
      .select('name finalPrice')
      .lean();

    if (!products.length) return ctx.reply('❌ Active product မရှိသေးပါ။');

    const rows = products.map((p) => [
      Markup.button.callback(`${p.name} — ${p.finalPrice.toLocaleString()} KS`, `ann_pick:${p._id}`),
    ]);
    rows.push([Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')]);

    await ctx.reply(
      `📣 *Product ကြေညာချက်*\n\nဘယ် product ကို ကြေညာမလဲ ရွေးပါ:\n_(bot user အားလုံး + channel နှစ်ခုလုံး ပို့ပါမယ်)_`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  }

  bot.hears('📣 Announce', requireRole('MANAGER'), (ctx) => showAnnouncePicker(ctx));

  bot.command('announce', requireRole('MANAGER'), async (ctx) => {
    const productId = ctx.message.text.split(/\s+/)[1];

    if (productId) {
      const product = await Product.findById(productId).catch(() => null);
      if (!product) return ctx.reply('❌ Product ရှာမတွေ့ပါ။');
      return showAnnounceStyles(ctx, product);
    }

    return showAnnouncePicker(ctx);
  });

  bot.action(/^ann_pick:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const product = await Product.findById(ctx.match[1]).catch(() => null);
    if (!product) return ctx.reply('❌ Product ရှာမတွေ့ပါ။');
    try { await ctx.deleteMessage(); } catch {}
    await showAnnounceStyles(ctx, product);
  });

  bot.action('ann_cancel', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('ပယ်ဖျက်ပြီး');
    try { await ctx.deleteMessage(); } catch {}
  });

  bot.action(/^ann_send:(new|flash):(.+)$/, requireRole('MANAGER'), async (ctx) => {
    const style = ctx.match[1];
    const product = await Product.findById(ctx.match[2]).catch(() => null);
    if (!product) return ctx.answerCbQuery('❌ Product ရှာမတွေ့ပါ', { show_alert: true });
    if (style === 'flash' && !(product.flashSalePrice > 0)) {
      return ctx.answerCbQuery('❌ Flash sale price မသတ်မှတ်ရသေးပါ', { show_alert: true });
    }

    await ctx.answerCbQuery('📤 ပို့နေပါပြီ...');
    try { await ctx.editMessageText(`📤 *${mdEsc(product.name)}* ကြေညာချက် ပို့နေပါတယ်... ခဏစောင့်ပါ။`, { parse_mode: 'Markdown' }); } catch {}

    const { channelOk, sent, failed } = await announceProductEverywhere(product, style, ctx.telegram);
    await auditLog(ctx.from.id, 'PRODUCT_ANNOUNCED', product._id.toString(), 'System', { style, channelOk, sent, failed });

    await ctx.reply(
      `✅ *ကြေညာပြီးပါပြီ!*\n\n` +
      `📢 Channel: ${channelOk ? '✅ တင်ပြီး' : '⚠️ မတင်နိုင်ပါ (channel မသတ်မှတ်ရသေး / bot admin မဟုတ်)'}\n` +
      `👥 Bot users: ✅ ${sent} ယောက် ရောက်ပြီး${failed ? ` / ❌ ${failed} ယောက် မရောက်` : ''}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /webhookstats — webhook event processing overview ────────────────────────

  bot.command('webhookstats', adminOnly(), async (ctx) => {
    const [pending, processed, failed, ignored, recent] = await Promise.all([
      WebhookEvent.countDocuments({ status: 'pending' }),
      WebhookEvent.countDocuments({ status: 'processed' }),
      WebhookEvent.countDocuments({ status: 'failed' }),
      WebhookEvent.countDocuments({ status: 'ignored' }),
      WebhookEvent.find({ status: { $in: ['pending', 'failed'] } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('source eventType status createdAt error'),
    ]);

    const recentLines = recent.map((e) =>
      `${e.status === 'failed' ? '❌' : '⏳'} \`${e.source}\` ${e.eventType} — ${e.status}`
    ).join('\n') || '_None_';

    await ctx.reply(
      `📡 *Webhook Stats*\n\n` +
      `⏳ Pending: *${pending}*\n` +
      `✅ Processed: *${processed}*\n` +
      `❌ Failed: *${failed}*\n` +
      `⏭️ Ignored: *${ignored}*\n\n` +
      `*Recent (pending/failed):*\n${recentLines}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Attribution analytics ─────────────────────────────────────────────────────

  bot.command('joinsources', requireRole('MANAGER'), async (ctx) => {
    const User = require('../models/User');

    const pipeline = [
      { $group: { _id: '$joinSource', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];

    const [results, total] = await Promise.all([
      User.aggregate(pipeline),
      User.countDocuments({}),
    ]);

    const icons = { referral: '🔗', channel: '📢', share: '📤', direct: '🔍', unknown: '❓' };
    const lines = results.map(({ _id, count }) => {
      const pct = total ? Math.round((count / total) * 100) : 0;
      return `${icons[_id] || '•'} *${_id || 'unknown'}*: ${count} (${pct}%)`;
    });

    await ctx.reply(
      `📊 *User Join Sources*\n\n` +
      `Total Users: *${total}*\n\n` +
      lines.join('\n'),
      { parse_mode: 'Markdown' }
    );
  });
};
