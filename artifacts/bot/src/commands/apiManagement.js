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
  announceProductsEverywhere,
  announceAccountProductEverywhere,
  announceRefCampaignEverywhere,
  validateAnnouncementChannel,
  mdEsc,
}                  = require('../services/BroadcastService');
const { auditLog }     = require('../services/logger');
const Product          = require('../models/Product');
const Catalog           = require('../models/Catalog');
const AccountProduct   = require('../models/AccountProduct');
const WebhookEvent     = require('../models/WebhookEvent');
const SystemStatus     = require('../models/SystemStatus');
const AnnouncementSchedule = require('../models/AnnouncementSchedule');
const AnnouncementAutomationService = require('../services/AnnouncementAutomationService');
const AnnouncementRun = require('../models/AnnouncementRun');
const RefCampaign = require('../models/RefCampaign');

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
      return `*${p.name.slice(0, 25)}* — ${mode}${sku}\n\`${p._id.toString()}\``;
    });

    await ctx.reply(
      `📦 *Products & Delivery Modes*\n\n${lines.join('\n\n')}\n\n` +
      `_ID ကို နှိပ်ရင် copy ရပါမယ် — /toggledelivery <id>, /testapi <id>, /announce <id> တို့မှာ သုံးပါ_`,
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

    const check = await validateAnnouncementChannel(ctx.telegram, channelId);
    if (!check.ok) {
      return ctx.reply(
        `❌ *Announcement channel မသတ်မှတ်နိုင်ပါ*\n\n` +
        `${mdEsc(check.message)}\n\n` +
        `စစ်ရန်:\n` +
        `1️⃣ Bot ကို channel မှာ admin ထည့်ပါ\n` +
        `2️⃣ *Post Messages* permission ဖွင့်ပါ\n` +
        `3️⃣ Channel ID / @username မှန်ကြောင်း စစ်ပါ`,
        { parse_mode: 'Markdown' }
      );
    }

    await SystemStatus.set({ announcementChannelId: channelId }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_ANNOUNCE_CHANNEL', null, 'System', { channelId });

    await ctx.reply(
      `✅ Announcement channel set to: *${channelId}*\n\n` +
      `✅ Bot admin permission စစ်ပြီးပါပြီ။\n` +
      `New products and flash sales will be posted there.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /checkannounce — verify channel config and bot posting permission ───────

  bot.command('checkannounce', adminOnly(), async (ctx) => {
    const check = await validateAnnouncementChannel(ctx.telegram);
    if (!check.ok) {
      return ctx.reply(
        `❌ *Announcement channel စစ်ဆေးမှု မအောင်မြင်ပါ*\n\n` +
        `${mdEsc(check.message)}\n\n` +
        `ပြင်ပြီးရင် \`/checkannounce\` နဲ့ ပြန်စစ်ပါ။`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.reply(
      `✅ *Announcement channel အဆင်ပြေပါပြီ*\n\n` +
      `📢 Channel: *${mdEsc(check.title)}*\n` +
      `🆔 ID: \`${mdEsc(check.channelId)}\`\n` +
      `👤 Bot: Admin\n` +
      `✍️ Post Messages: ခွင့်ပြုထားပါပြီ\n\n` +
      `အခု \`/announce\` (သို့) Admin menu → 📣 Announce နဲ့ ကြော်ငြာတင်နိုင်ပါပြီ။`,
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
    await ctx.reply(
      `📣 *Product ကြေညာချက်*\n\nဘယ် product အမျိုးအစားကို ကြေညာမလဲ အရင်ရွေးပါ။\nပြီးရင် ရွေးထားတဲ့အမျိုးအစားထဲက active product အားလုံးကို ပြပေးပါမယ်။`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Shop Products', 'ann_category:shop')],
          [Markup.button.callback('🔐 Premium Accounts', 'ann_category:account')],
          [Markup.button.callback('🎯 Ref Campaign', 'ann_ref_campaign')],
          [Markup.button.callback('📅 Schedule Manager', 'ann_schedule_menu')],
          [Markup.button.callback('📜 Announcement History', 'ann_history')],
          [Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')],
        ]),
      }
    );
  }

  async function showScheduleMenu(ctx) {
    const schedules = await AnnouncementSchedule.find().sort({ createdAt: -1 }).limit(20).lean();
    const rows = [[Markup.button.callback('➕ New Schedule', 'ann_schedule_new')]];
    for (const s of schedules) {
      const retention = s.retentionSeconds ? `${Math.round(s.retentionSeconds / 3600)}h` : 'မဖျက်';
      rows.push([Markup.button.callback(`${s.isActive ? '🟢' : '⏸️'} ${s.name.slice(0, 28)} · ${retention}`, 'ann_sched_noop')]);
      rows.push([
        Markup.button.callback(s.isActive ? '⏸️ Pause' : '▶️ Resume', `ann_sched_toggle:${s._id}`),
        Markup.button.callback('▶️ Run Now', `ann_sched_run:${s._id}`),
        Markup.button.callback('🗑 Delete', `ann_sched_delete:${s._id}`),
      ]);
      rows.push([Markup.button.callback(`⏱ Retention: ${retention}`, `ann_sched_ret:${s._id}`)]);
    }
    rows.push([Markup.button.callback('📜 Run History', 'ann_history')]);
    rows.push([Markup.button.callback('↩️ Announce', 'ann_categories')]);
    return ctx.reply('📅 *Announcement Schedule Manager*\n\nButton နဲ့ schedule ဖန်တီး၊ pause/resume၊ run now၊ delete နဲ့ retention ပြောင်းနိုင်ပါတယ်။', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  async function showScheduleTarget(ctx) {
    const rows = [
      [Markup.button.callback('🌐 All Active Products', 'ann_sched_target:all')],
      [Markup.button.callback('📦 Shop Product တစ်ခု', 'ann_sched_target:product')],
      [Markup.button.callback('🔐 Premium Account တစ်ခု', 'ann_sched_target:account')],
      [Markup.button.callback('📂 Category အများရွေးမယ်', 'ann_sched_categories')],
    ];
    rows.push([Markup.button.callback('❌ Cancel', 'ann_cancel')]);
    return ctx.reply('📅 Schedule target ကို ရွေးပါ။\n\n📂 Category အများရွေးရင် parent အောက်က sub-category နဲ့ product အားလုံးကို auto include လုပ်ပါမယ်။', Markup.inlineKeyboard(rows));
  }

  async function showScheduleCategories(ctx) {
    const catalogRows = await Catalog.find({ isActive: true }).select('name parentCategory sortOrder').sort({ sortOrder: 1, name: 1 }).lean();
    const legacy = await Product.distinct('category', { isActive: true });
    const names = [...new Set([...catalogRows.map((c) => c.name), ...legacy.filter(Boolean)])];
    const selected = new Set(ctx.session.announceScheduleCategories || []);
    const rows = names.slice(0, 80).map((name) => [Markup.button.callback(`${selected.has(name) ? '✅' : '☐'} ${String(name).slice(0, 42)}`, `ann_sched_cat_toggle:${encodeURIComponent(name).slice(0, 55)}`)]);
    if (selected.size) rows.push([Markup.button.callback(`✅ Category ${selected.size} ခု — ဆက်သွားမယ်`, 'ann_sched_cat_done')]);
    rows.push([Markup.button.callback('🧹 Clear', 'ann_sched_cat_clear'), Markup.button.callback('❌ Cancel', 'ann_cancel')]);
    return ctx.reply('📂 Category အများရွေးပါ။ Parent category ကိုရွေးရင် အောက်က sub-category/product အားလုံးပါဝင်ပါမယ်။', Markup.inlineKeyboard(rows));
  }

  async function showScheduleProducts(ctx, type = 'shop') {
    const isAccount = type === 'account';
    const products = isAccount
      ? await AccountProduct.find({ isActive: true }).sort({ displayOrder: 1, serviceName: 1 }).limit(50).select('serviceName planLabel').lean()
      : await Product.find({ isActive: true }).sort({ updatedAt: -1 }).limit(50).select('name').lean();
    const rows = products.map((p) => [Markup.button.callback(
      `${isAccount ? '🔐' : '📦'} ${String(isAccount ? `${p.serviceName} — ${p.planLabel}` : p.name).slice(0, 45)}`,
      `ann_sched_product:${isAccount ? 'account' : 'shop'}:${p._id}`
    )]);
    rows.push([Markup.button.callback('↩️ Target ပြန်ရွေး', 'ann_schedule_new')]);
    return ctx.reply(`${isAccount ? '🔐 Premium Account' : '📦 Shop Product'} schedule လုပ်မယ့် item ကိုရွေးပါ။`, Markup.inlineKeyboard(rows));
  }

  async function showScheduleFrequency(ctx) {
    return ctx.reply('⏰ Frequency ကို ရွေးပါ။ Daily/Weekly/Monthly မှာ နာရီနဲ့ မိနစ်ကို နောက်တစ်ဆင့် ရွေးနိုင်ပါတယ်။', Markup.inlineKeyboard([
      [Markup.button.callback('🕘 Daily', 'ann_sched_freq:daily'), Markup.button.callback('📅 Weekly', 'ann_sched_freq:weekly')],
      [Markup.button.callback('🗓 Monthly', 'ann_sched_freq:monthly')],
      [Markup.button.callback('⏱ Every 1 hour', 'ann_sched_freq:hourly'), Markup.button.callback('⏱ Every 6 hours', 'ann_sched_freq:every_6_hours')],
      [Markup.button.callback('⏱ Every 12 hours', 'ann_sched_freq:interval:720')],
      [Markup.button.callback('❌ Cancel', 'ann_cancel')],
    ]));
  }

  async function showScheduleTime(ctx, frequency) {
    ctx.session.announceScheduleDraft = { ...(ctx.session.announceScheduleDraft || {}), frequency };
    const rows = [
      [Markup.button.callback('🌅 09:00', 'ann_sched_time:9:0'), Markup.button.callback('☀️ 12:00', 'ann_sched_time:12:0')],
      [Markup.button.callback('🌆 18:00', 'ann_sched_time:18:0'), Markup.button.callback('🌙 21:00', 'ann_sched_time:21:0')],
      [Markup.button.callback('⌨️ Custom time (HH:MM)', 'ann_sched_custom_time')],
      [Markup.button.callback('❌ Cancel', 'ann_cancel')],
    ];
    return ctx.reply(`⏰ ${frequency} schedule အတွက် MMT အချိန်ရွေးပါ။`, Markup.inlineKeyboard(rows));
  }

  async function createButtonSchedule(ctx, frequency, extra = {}) {
    const draft = ctx.session.announceScheduleDraft;
    if (!draft) return ctx.answerCbQuery('Schedule target မရှိတော့ပါ', { show_alert: true });
    try {
      const payload = {
      name: draft.name,
      targetType: draft.targetType,
      category: draft.category || (draft.categories || [])[0] || null,
      categories: draft.categories || [],
      productIds: draft.productId ? [draft.productId] : [],
      accountProductIds: draft.accountProductId ? [draft.accountProductId] : [],
      frequency,
      intervalMinutes: extra.intervalMinutes || null,
      localHour: extra.localHour ?? draft.localHour ?? 9,
      localMinute: extra.localMinute ?? draft.localMinute ?? 0,
      monthDay: extra.monthDay || draft.monthDay || 1,
      weekdays: extra.weekdays || draft.weekdays || [],
      retentionSeconds: 6 * 3600,
      destination: 'both',
      createdBy: ctx.from.id,
        isActive: true,
      };
      const schedule = new AnnouncementSchedule(payload);
    schedule.nextRunAt = AnnouncementAutomationService.nextRunAt(schedule);
      await schedule.save();
      ctx.session.announceScheduleDraft = null;
      return ctx.reply(`✅ Schedule ဖန်တီးပြီးပါပြီ။\n📌 ${schedule.name}\n⏰ Next: ${schedule.nextRunAt.toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })}\n🧹 Bot user message: 6h အကြာဖျက်မယ်၊ Channel post မဖျက်ပါ။`, Markup.inlineKeyboard([[Markup.button.callback('📅 Schedule Manager', 'ann_schedule_menu')]]));
    } catch (err) {
      console.error('[AnnouncementSchedule] create failed:', err.message);
      return ctx.reply(`❌ Schedule မသိမ်းနိုင်ပါ။ ${err.message.slice(0, 180)}`);
    }
  }

  async function showAnnounceCategory(ctx, category) {
    const selected = new Set((ctx.session.announceSelected || []).map((item) => `${item.type}:${item.id}`));
    if (category === 'shop') {
      const products = await Product.find({ isActive: true })
        .sort({ updatedAt: -1 })
        .select('name finalPrice')
        .lean();
      if (!products.length) return ctx.reply('❌ Active Shop Product မရှိသေးပါ။');

      const rows = products.map((p) => {
        const key = `shop:${p._id}`;
        return [Markup.button.callback(`${selected.has(key) ? '✅' : '☐'} ${p.name} — ${Number(p.finalPrice || 0).toLocaleString()} KS`, `ann_toggle:shop:${p._id}`)];
      });
      if (selected.size) rows.push([Markup.button.callback(`📢 Announce Selected (${selected.size})`, 'ann_bulk_confirm')]);
      rows.push([Markup.button.callback('✅ Select All in Shop', 'ann_select_all:shop')]);
      rows.push([Markup.button.callback('🧹 Clear Selection', 'ann_clear_selection')]);
      rows.push([Markup.button.callback('↩️ Product အမျိုးအစားများ', 'ann_categories')]);
      rows.push([Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')]);

      return ctx.reply(
        `🛒 *Shop Products*\n\nActive Shop Product အားလုံး (${products.length} ခု) — ကြေညာမယ့် product ကို ရွေးပါ:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
      );
    }

    const accountProducts = await AccountProduct.find({ isActive: true })
      .sort({ displayOrder: 1, serviceName: 1 })
      .select('serviceName planLabel price discountPercent emoji')
      .lean();
    if (!accountProducts.length) return ctx.reply('❌ Active Premium Account မရှိသေးပါ။');

    const rows = accountProducts.map((p) => {
      const finalPrice = Math.max(0, Math.round(Number(p.price || 0) * (1 - Number(p.discountPercent || 0) / 100)));
      const key = `account:${p._id}`;
      return [Markup.button.callback(`${selected.has(key) ? '✅' : '☐'} ${p.emoji || '🔐'} ${p.serviceName} — ${p.planLabel} (${finalPrice.toLocaleString()} KS)`, `ann_toggle:account:${p._id}`)];
    });
    if (selected.size) rows.push([Markup.button.callback(`📢 Announce Selected (${selected.size})`, 'ann_bulk_confirm')]);
    rows.push([Markup.button.callback('✅ Select All in Premium Accounts', 'ann_select_all:account')]);
    rows.push([Markup.button.callback('🧹 Clear Selection', 'ann_clear_selection')]);
    rows.push([Markup.button.callback('↩️ Product အမျိုးအစားများ', 'ann_categories')]);
    rows.push([Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')]);

    return ctx.reply(
      `🔐 *Premium Accounts*\n\nActive Premium Account အားလုံး (${accountProducts.length} ခု) — ကြေညာမယ့် product ကို ရွေးပါ:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  }

  async function showAnnounceStylesAccount(ctx, accountProduct) {
    await ctx.reply(
      `📣 *${mdEsc(accountProduct.serviceName)} — ${mdEsc(accountProduct.planLabel)}* ကို ကြေညာမယ်\n\n` +
      `Bot user အားလုံး + ကြေညာချက် channel နှစ်ခုလုံးကို ပို့ပါမယ်။\n` +
      `ဆက်လုပ်မလား?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📢 ကြေညာမယ်', `ann_send_acc:${accountProduct._id}`)],
          [Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')],
        ]),
      }
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

  bot.action('ann_noop', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
  });

  bot.action('ann_categories', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
    return showAnnouncePicker(ctx);
  });

  bot.action(/^ann_category:(shop|account)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
    return showAnnounceCategory(ctx, ctx.match[1]);
  });

  bot.action('ann_schedule_menu', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    return showScheduleMenu(ctx);
  });

  bot.action('ann_schedule_new', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    return showScheduleTarget(ctx);
  });

  bot.action('ann_sched_target:all', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.announceScheduleDraft = { name: 'All Active Products', targetType: 'all' };
    return showScheduleFrequency(ctx);
  });

  bot.action('ann_sched_target:product', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    return showScheduleProducts(ctx, 'shop');
  });

  bot.action('ann_sched_target:account', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    return showScheduleProducts(ctx, 'account');
  });

  bot.action(/^ann_sched_cat:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const category = decodeURIComponent(ctx.match[1]);
    ctx.session.announceScheduleDraft = { name: `${category} Category`, targetType: 'category', category };
    return showScheduleFrequency(ctx);
  });

  bot.action(/^ann_sched_product:(shop|account):([a-f0-9]{24})$/i, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const isAccount = ctx.match[1] === 'account';
    const product = isAccount
      ? await AccountProduct.findOne({ _id: ctx.match[2], isActive: true }).select('serviceName planLabel').lean()
      : await Product.findOne({ _id: ctx.match[2], isActive: true }).select('name').lean();
    if (!product) return ctx.reply('❌ Active product မတွေ့ပါ။');
    const name = isAccount ? `${product.serviceName} — ${product.planLabel}` : product.name;
    ctx.session.announceScheduleDraft = isAccount
      ? { name, targetType: 'account', accountProductId: String(product._id) }
      : { name, targetType: 'product', productId: String(product._id) };
    return showScheduleFrequency(ctx);
  });

  bot.action('ann_sched_categories', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.announceScheduleCategories = [];
    return showScheduleCategories(ctx);
  });

  bot.action(/^ann_sched_cat_toggle:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const category = decodeURIComponent(ctx.match[1]);
    const selected = new Set(ctx.session.announceScheduleCategories || []);
    if (selected.has(category)) selected.delete(category); else selected.add(category);
    ctx.session.announceScheduleCategories = [...selected].slice(0, 10);
    return showScheduleCategories(ctx);
  });

  bot.action('ann_sched_cat_clear', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Selection cleared');
    ctx.session.announceScheduleCategories = [];
    return showScheduleCategories(ctx);
  });

  bot.action('ann_sched_cat_done', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const categories = (ctx.session.announceScheduleCategories || []).slice(0, 10);
    if (!categories.length) return ctx.reply('အနည်းဆုံး category တစ်ခု ရွေးပါ။');
    ctx.session.announceScheduleDraft = { name: categories.join(', ').slice(0, 120), targetType: 'category', categories };
    ctx.session.announceScheduleCategories = [];
    return showScheduleFrequency(ctx);
  });

  bot.action(/^ann_sched_freq:(daily|weekly|monthly)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'weekly') {
      return ctx.reply('📅 Weekly announce လုပ်မယ့်နေ့ကို ရွေးပါ။', Markup.inlineKeyboard([
        [Markup.button.callback('တနင်္လာ', 'ann_sched_weekday:1'), Markup.button.callback('အင်္ဂါ', 'ann_sched_weekday:2')],
        [Markup.button.callback('ဗုဒ္ဓဟူး', 'ann_sched_weekday:3'), Markup.button.callback('ကြာသပတေး', 'ann_sched_weekday:4')],
        [Markup.button.callback('သောကြာ', 'ann_sched_weekday:5'), Markup.button.callback('စနေ', 'ann_sched_weekday:6')],
        [Markup.button.callback('တနင်္ဂနွေ', 'ann_sched_weekday:0')],
      ]));
    }
    if (ctx.match[1] === 'monthly') {
      return ctx.reply('🗓 Monthly announce လုပ်မယ့်ရက်ကို ရွေးပါ။', Markup.inlineKeyboard([
        [Markup.button.callback('လ ၁ ရက်', 'ann_sched_monthday:1'), Markup.button.callback('လ ၅ ရက်', 'ann_sched_monthday:5')],
        [Markup.button.callback('လ ၁၀ ရက်', 'ann_sched_monthday:10'), Markup.button.callback('လ ၁၅ ရက်', 'ann_sched_monthday:15')],
        [Markup.button.callback('လ ၂၀ ရက်', 'ann_sched_monthday:20'), Markup.button.callback('လ ၂၅ ရက်', 'ann_sched_monthday:25')],
        [Markup.button.callback('လ နောက်ဆုံးနေ့နီးပါး (၂၈)', 'ann_sched_monthday:28')],
      ]));
    }
    return showScheduleTime(ctx, ctx.match[1]);
  });

  bot.action(/^ann_sched_weekday:([0-6])$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.announceScheduleDraft = { ...(ctx.session.announceScheduleDraft || {}), weekdays: [Number(ctx.match[1])] };
    return showScheduleTime(ctx, 'weekly');
  });

  bot.action(/^ann_sched_monthday:(\d{1,2})$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.announceScheduleDraft = { ...(ctx.session.announceScheduleDraft || {}), monthDay: Number(ctx.match[1]) };
    return showScheduleTime(ctx, 'monthly');
  });

  // Hourly presets previously had buttons but no callback handler, so tapping
  // "Every 1 hour" or "Every 6 hours" silently did nothing.
  bot.action(/^ann_sched_freq:(hourly|every_6_hours)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Schedule ဖန်တီးနေပါပြီ...');
    return createButtonSchedule(ctx, ctx.match[1]);
  });

  bot.action(/^ann_sched_freq:interval:(\d+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Schedule ဖန်တီးနေပါပြီ...');
    return createButtonSchedule(ctx, 'interval', { intervalMinutes: Number(ctx.match[1]) });
  });

  bot.action(/^ann_sched_time:(\d{1,2}):(\d{1,2})$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Schedule ဖန်တီးနေပါပြီ...');
    return createButtonSchedule(ctx, ctx.session.announceScheduleDraft?.frequency || 'daily', { localHour: Number(ctx.match[1]), localMinute: Number(ctx.match[2]) });
  });

  bot.action('ann_sched_custom_time', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.announceScheduleAwaitingTime = true;
    return ctx.reply('⌨️ MMT အချိန်ကို `HH:MM` ပုံစံနဲ့ ရိုက်ပါ။ ဥပမာ `07:30` သို့ `22:15`', { parse_mode: 'Markdown' });
  });

  bot.hears(/^([01]?\d|2[0-3]):([0-5]\d)$/, requireRole('MANAGER'), async (ctx) => {
    if (!ctx.session.announceScheduleAwaitingTime) return;
    ctx.session.announceScheduleAwaitingTime = false;
    const hour = Number(ctx.match[1]);
    const minute = Number(ctx.match[2]);
    return createButtonSchedule(ctx, ctx.session.announceScheduleDraft?.frequency || 'daily', { localHour: hour, localMinute: minute });
  });

  bot.action('ann_sched_noop', requireRole('MANAGER'), (ctx) => ctx.answerCbQuery());

  bot.action(/^ann_sched_toggle:([a-f0-9]{24})$/i, requireRole('MANAGER'), async (ctx) => {
    const schedule = await AnnouncementSchedule.findById(ctx.match[1]);
    if (!schedule) return ctx.answerCbQuery('Schedule မတွေ့ပါ', { show_alert: true });
    schedule.isActive = !schedule.isActive;
    if (schedule.isActive && !schedule.nextRunAt) schedule.nextRunAt = AnnouncementAutomationService.nextRunAt(schedule);
    await schedule.save();
    await ctx.answerCbQuery(schedule.isActive ? 'ပြန်ဖွင့်ပြီးပါပြီ' : 'Pause လုပ်ပြီးပါပြီ');
    return showScheduleMenu(ctx);
  });

  bot.action(/^ann_sched_run:([a-f0-9]{24})$/i, requireRole('MANAGER'), async (ctx) => {
    const schedule = await AnnouncementSchedule.findById(ctx.match[1]);
    if (!schedule) return ctx.answerCbQuery('Schedule မတွေ့ပါ', { show_alert: true });
    schedule.isActive = true; schedule.nextRunAt = new Date(); await schedule.save();
    await ctx.answerCbQuery('Run Now စတင်ပါပြီ');
    // Do not hold the Telegram callback update while broadcasting to all users;
    // large user lists can exceed Telegraf's 90-second update timeout.
    AnnouncementAutomationService.runDueSchedules(ctx.telegram)
      .then((result) => ctx.reply(`✅ Run Now ပြီးပါပြီ။ Completed: ${result.completed}, Failed: ${result.failed}`))
      .catch((err) => ctx.reply(`❌ Run Now မအောင်မြင်ပါ။ ${String(err.message || err).slice(0, 180)}`).catch(() => {}));
    return showScheduleMenu(ctx);
  });

  bot.action(/^ann_sched_delete:([a-f0-9]{24})$/i, requireRole('MANAGER'), async (ctx) => {
    const deleted = await AnnouncementSchedule.findByIdAndDelete(ctx.match[1]);
    await ctx.answerCbQuery(deleted ? 'ဖျက်ပြီးပါပြီ' : 'Schedule မတွေ့ပါ');
    return showScheduleMenu(ctx);
  });

  bot.action(/^ann_sched_ret:([a-f0-9]{24})$/i, requireRole('MANAGER'), async (ctx) => {
    const schedule = await AnnouncementSchedule.findById(ctx.match[1]);
    if (!schedule) return ctx.answerCbQuery('Schedule မတွေ့ပါ', { show_alert: true });
    const options = [0, 3600, 21600, 43200, 86400];
    const index = options.indexOf(Number(schedule.retentionSeconds || 0));
    schedule.retentionSeconds = options[(index + 1) % options.length];
    await schedule.save();
    await ctx.answerCbQuery(`Retention ${schedule.retentionSeconds ? `${schedule.retentionSeconds / 3600}h` : 'မဖျက်'} ထားပါပြီ`);
    return showScheduleMenu(ctx);
  });

  bot.action('ann_history', requireRole('MANAGER'), async (ctx) => {
    const runs = await AnnouncementRun.find().sort({ startedAt: -1 }).limit(15).lean();
    const lines = runs.length
      ? runs.map((r) => `${r.status === 'completed' ? '✅' : r.status === 'skipped_duplicate' ? '⏭️' : '❌'} ${r.trigger} · ${r.selectedCount} items · users ${r.userSent} · ${new Date(r.startedAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })}`)
      : ['History မရှိသေးပါ။'];
    await ctx.answerCbQuery();
    return ctx.reply(`📜 *Announcement History*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📅 Schedule Manager', 'ann_schedule_menu'), Markup.button.callback('↩️ Announce', 'ann_categories')]]) });
  });

  bot.action(/^ann_toggle:(shop|account):([a-f0-9]{24})$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const item = { type: ctx.match[1], id: ctx.match[2] };
    const current = Array.isArray(ctx.session.announceSelected) ? ctx.session.announceSelected : [];
    const exists = current.some((x) => x.type === item.type && String(x.id) === item.id);
    ctx.session.announceSelected = exists
      ? current.filter((x) => !(x.type === item.type && String(x.id) === item.id))
      : [...current, item];
    try { await ctx.deleteMessage(); } catch {}
    return showAnnounceCategory(ctx, item.type);
  });

  bot.action(/^ann_select_all:(shop|account)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('ရွေးပြီးပါပြီ');
    const type = ctx.match[1];
    const docs = type === 'shop'
      ? await Product.find({ isActive: true }).select('_id').lean()
      : await AccountProduct.find({ isActive: true }).select('_id').lean();
    const current = Array.isArray(ctx.session.announceSelected) ? ctx.session.announceSelected.filter((x) => x.type !== type) : [];
    ctx.session.announceSelected = [...current, ...docs.map((d) => ({ type, id: String(d._id) }))];
    try { await ctx.deleteMessage(); } catch {}
    return showAnnounceCategory(ctx, type);
  });

  bot.action('ann_clear_selection', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('ရွေးထားတာတွေ ရှင်းပြီးပါပြီ');
    ctx.session.announceSelected = [];
    try { await ctx.deleteMessage(); } catch {}
    return showAnnouncePicker(ctx);
  });

  bot.action('ann_bulk_confirm', requireRole('MANAGER'), async (ctx) => {
    const selected = Array.isArray(ctx.session.announceSelected) ? ctx.session.announceSelected : [];
    if (!selected.length) return ctx.answerCbQuery('Product မရွေးရသေးပါ', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.reply(`📢 ရွေးထားတဲ့ product ${selected.length} ခုကို bot users နဲ့ channel နှစ်ခုလုံးဆီ ပို့မလား?`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🆕 ရိုးရိုး Announce (တစ်စောင်တည်း)', 'ann_bulk_send:new')],
        [Markup.button.callback('⚡ Flash Sale (တစ်စောင်တည်း)', 'ann_bulk_send:flash')],
        [Markup.button.callback('❌ မလုပ်တော့ပါ', 'ann_cancel')],
      ]),
    });
  });

  bot.action(/^ann_bulk_send:(new|flash)$/, requireRole('MANAGER'), async (ctx) => {
    const selected = Array.isArray(ctx.session.announceSelected) ? ctx.session.announceSelected : [];
    if (!selected.length) return ctx.answerCbQuery('Product မရွေးရသေးပါ', { show_alert: true });
    const style = ctx.match[1];
    await ctx.answerCbQuery('ပို့နေပါပြီ...');
    ctx.session.announceSelected = [];
    const shopIds = selected.filter((item) => item.type === 'shop').map((item) => item.id);
    const accounts = selected.filter((item) => item.type === 'account');
    let sent = 0, failed = 0, channelOk = true, selectedCount = 0;
    try {
      const products = await Product.find({ _id: { $in: shopIds }, isActive: true }).sort({ updatedAt: -1 });
      const result = await announceProductsEverywhere(products, style, ctx.telegram);
      sent += result.sent || 0;
      selectedCount += result.selectedCount || 0;
      channelOk = channelOk && result.channelOk;
      failed += result.channelOk ? 0 : 1;
    } catch (err) {
      failed += 1;
      channelOk = false;
      console.error('[Announce] grouped shop announcement failed:', err.message);
    }
    if (style === 'flash' && accounts.length) {
      failed += accounts.length;
      await ctx.reply('⚠️ Flash Sale က Shop Products အတွက်ပဲ grouped ပို့ထားပါတယ်။ Premium Account တွေကို ဒီရွေးချယ်မှုမှာ မပို့ပါ။');
    } else {
      for (const item of accounts) {
        try {
          const account = await AccountProduct.findOne({ _id: item.id, isActive: true });
          if (!account) { failed++; continue; }
          const result = await announceAccountProductEverywhere(account, ctx.telegram, { compact: true });
          sent += result.sent || 0;
          channelOk = channelOk && result.channelOk;
        } catch (err) {
          failed++;
          console.error('[Announce] account item failed:', err.message);
        }
      }
    }
    await ctx.reply(`✅ Grouped ${style === 'flash' ? 'Flash Sale' : 'Announce'} ပြီးပါပြီ။\n📦 Product တစ်စောင်တည်းထဲ စုစည်းထားသော items: ${selectedCount}\n👥 Bot user messages: ${sent}\n📢 Channel: ${channelOk ? '✅' : '❌'}\n❌ Failed: ${failed}`);
  });

  // Unified Announce picker: Shop Products and Premium Accounts share one
  // product-like selection flow while preserving their native purchase handlers.
  bot.action(/^ann_pick_item:(shop|account):(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const type = ctx.match[1];
    const id = ctx.match[2];
    try { await ctx.deleteMessage(); } catch {}

    if (type === 'account') {
      const accountProduct = await AccountProduct.findById(id).catch(() => null);
      if (!accountProduct || !accountProduct.isActive) return ctx.reply('❌ Account product ရှာမတွေ့ပါ (သို့) ပိတ်ထားပြီးပါပြီ။');
      return showAnnounceStylesAccount(ctx, accountProduct);
    }

    const product = await Product.findById(id).catch(() => null);
    if (!product || !product.isActive) return ctx.reply('❌ Product ရှာမတွေ့ပါ (သို့) ပိတ်ထားပြီးပါပြီ။');
    return showAnnounceStyles(ctx, product);
  });

  bot.action(/^ann_pick_acc:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]).catch(() => null);
    if (!p || !p.isActive) return ctx.reply('❌ Account product ရှာမတွေ့ပါ (သို့) ပိတ်ထားပြီးပါပြီ။');
    try { await ctx.deleteMessage(); } catch {}
    await showAnnounceStylesAccount(ctx, p);
  });

  bot.action(/^ann_send_acc:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]).catch(() => null);
    if (!p) return ctx.answerCbQuery('❌ Account product ရှာမတွေ့ပါ', { show_alert: true });

    await ctx.answerCbQuery('📤 ပို့နေပါပြီ...');
    try { await ctx.editMessageText(`📤 *${mdEsc(p.serviceName)} — ${mdEsc(p.planLabel)}* ကြေညာချက် ပို့နေပါတယ်... ခဏစောင့်ပါ။`, { parse_mode: 'Markdown' }); } catch {}

    const { channelOk, channelError, sent, blocked, failed } = await announceAccountProductEverywhere(p, ctx.telegram);
    await auditLog(ctx.from.id, 'ACCOUNT_PRODUCT_ANNOUNCED', p._id.toString(), 'System', { channelOk, sent, blocked, failed });

    await ctx.reply(
      `✅ *ကြေညာပြီးပါပြီ!*\n\n` +
      `📢 Channel: ${channelOk ? '✅ တင်ပြီး' : `❌ မတင်နိုင်ပါ — ${mdEsc(channelError || 'Telegram error')}`}\n` +
      `👥 Bot users: ✅ ${sent} ယောက် ရောက်ပြီး` +
      `${blocked ? ` / 🚫 ${blocked} ယောက် (bot block လုပ်ထား — DB မှာ မှတ်ပြီး)` : ''}` +
      `${failed ? ` / ❌ ${failed} ယောက် မရောက်` : ''}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('ann_ref_campaign', requireRole('MANAGER'), async (ctx) => {
    const campaign = await RefCampaign.getActive();
    if (!campaign) return ctx.answerCbQuery('ဖွင့်ထားတဲ့ Ref Campaign မရှိပါ', { show_alert: true });
    await ctx.answerCbQuery('📤 Campaign announce ပို့နေပါပြီ...');
    try { await ctx.editMessageText('📤 Ref Campaign announcement ကို bot users နဲ့ channel ဆီ ပို့နေပါတယ်...'); } catch {}
    const result = await announceRefCampaignEverywhere(campaign, ctx.telegram, { destination: 'both' });
    await auditLog(ctx.from.id, 'REF_CAMPAIGN_ANNOUNCED', campaign._id.toString(), 'System', result);
    return ctx.reply(
      `✅ *Ref Campaign ကြေညာပြီးပါပြီ!*\n\n` +
      `📢 Channel: ${result.channelOk ? '✅ တင်ပြီး' : `❌ ${mdEsc(result.channelError || 'မတင်နိုင်ပါ')}`}\n` +
      `👥 Bot users: ✅ ${result.sent || 0} ယောက်\n` +
      `❌ Failed: ${result.failed || 0}`,
      { parse_mode: 'Markdown' }
    );
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

    const { channelOk, channelError, sent, blocked, failed } = await announceProductEverywhere(product, style, ctx.telegram);
    await auditLog(ctx.from.id, 'PRODUCT_ANNOUNCED', product._id.toString(), 'System', { style, channelOk, sent, blocked, failed });

    await ctx.reply(
      `✅ *ကြေညာပြီးပါပြီ!*\n\n` +
      `📢 Channel: ${channelOk ? '✅ တင်ပြီး' : `❌ မတင်နိုင်ပါ — ${mdEsc(channelError || 'Telegram error')}`}\n` +
      `👥 Bot users: ✅ ${sent} ယောက် ရောက်ပြီး` +
      `${blocked ? ` / 🚫 ${blocked} ယောက် (bot block လုပ်ထား — DB မှာ မှတ်ပြီး)` : ''}` +
      `${failed ? ` / ❌ ${failed} ယောက် မရောက်` : ''}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Announcement schedules ───────────────────────────────────────────────────

  bot.command('annschedule', requireRole('MANAGER'), async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const action = parts[1] || 'list';
    if (action === 'list') {
      const schedules = await AnnouncementSchedule.find().sort({ createdAt: -1 }).limit(50).lean();
      if (!schedules.length) return ctx.reply('📅 Announcement schedule မရှိသေးပါ။');
      const lines = schedules.map((s) => `${s.isActive ? '🟢' : '⏸️'} ID:${s._id} ${mdEsc(s.name)} — ${s.targetType}/${s.frequency} — ${s.retentionSeconds ? `${Math.round(s.retentionSeconds / 3600)}h delete` : 'မဖျက်'}\n   next: ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' }) : '—'}`);
      return ctx.reply(`📅 *Announcement Schedules*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    }
    if (action === 'pause' || action === 'resume' || action === 'delete' || action === 'run') {
      const id = parts[2];
      if (!id || !/^[a-f0-9]{24}$/i.test(id)) return ctx.reply('Usage: /annschedule pause|resume|delete|run <scheduleId>');
      const schedule = await AnnouncementSchedule.findById(id);
      if (!schedule) return ctx.reply('❌ Schedule မတွေ့ပါ။');
      if (action === 'delete') {
        await schedule.deleteOne();
        await auditLog(ctx.from.id, 'ANNOUNCEMENT_SCHEDULE_DELETE', id, 'System', {});
        return ctx.reply('✅ Schedule ဖျက်ပြီးပါပြီ။');
      }
      if (action === 'pause') {
        schedule.isActive = false;
        await schedule.save();
        return ctx.reply('⏸️ Schedule pause လုပ်ပြီးပါပြီ။');
      }
      if (action === 'resume') {
        schedule.isActive = true;
        if (!schedule.nextRunAt) schedule.nextRunAt = AnnouncementAutomationService.nextRunAt(schedule);
        await schedule.save();
        return ctx.reply('▶️ Schedule ပြန်ဖွင့်ပြီးပါပြီ။');
      }
      schedule.nextRunAt = new Date();
      await schedule.save();
      const result = await AnnouncementAutomationService.runDueSchedules(ctx.telegram);
      return ctx.reply(`✅ Run Now ပြီးပါပြီ။ Completed: ${result.completed}, Failed: ${result.failed}`);
    }
    if (action === 'add') {
      const raw = parts.slice(2).join(' ');
      const [name, targetType, target, frequency, time, retentionHours, destination = 'both'] = raw.split('|').map((x) => x?.trim());
      const validTypes = ['category', 'product', 'account', 'all'];
      const validFrequency = ['once', 'hourly', 'every_6_hours', 'daily', 'weekly', 'interval'];
      const validDestinations = ['users', 'channel', 'both'];
      if (!name || !validTypes.includes(targetType) || !validFrequency.includes(frequency) || !validDestinations.includes(destination)) {
        return ctx.reply('Usage: /annschedule add Name|category|CapCut|daily|09:00|6|both\nTarget type: category/product/account/all; destination: users/channel/both; retention max 48h');
      }
      const [hourText, minuteText] = String(time || '09:00').split(':');
      const localHour = Number(hourText); const localMinute = Number(minuteText);
      if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23 || !Number.isInteger(localMinute) || localMinute < 0 || localMinute > 59) return ctx.reply('Time ကို HH:MM ပုံစံသုံးပါ။');
      const retention = Math.min(Math.max(Number(retentionHours || 0), 0), 48) * 3600;
      const payload = { name, targetType, frequency, localHour, localMinute, retentionSeconds: retention, createdBy: ctx.from.id, destination };
      if (targetType === 'category') payload.category = target;
      if (targetType === 'product') { if (!/^[a-f0-9]{24}$/i.test(target || '')) return ctx.reply('Product ID မမှန်ပါ။'); payload.productIds = [target]; }
      if (targetType === 'account') { if (!/^[a-f0-9]{24}$/i.test(target || '')) return ctx.reply('Account Product ID မမှန်ပါ။'); payload.accountProductIds = [target]; }
      const doc = new AnnouncementSchedule(payload);
      doc.nextRunAt = AnnouncementAutomationService.nextRunAt(doc);
      await doc.save();
      await auditLog(ctx.from.id, 'ANNOUNCEMENT_SCHEDULE_CREATE', doc._id.toString(), 'System', { targetType, frequency, retentionSeconds: retention });
      return ctx.reply(`✅ Schedule ဖန်တီးပြီးပါပြီ။\nID: ${doc._id}\nNext: ${doc.nextRunAt.toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })}`);
    }
    return ctx.reply('Commands: /annschedule list | add | pause | resume | run | delete');
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
