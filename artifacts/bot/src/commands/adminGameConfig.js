/**
 * adminGameConfig.js — Admin panel for game economics management
 *
 * Sections:
 *   💰 Coin Bonus Rates  — view/edit per-tier coin bonus rates
 *   📊 Tier Config       — view/edit tier thresholds and discounts
 *   🎰 Spin Rewards      — view/edit spin wheel prize weights & cost
 *   💳 Adjust Balance    — manually credit/debit KS or Coins for any user
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const GameConfig = require('../models/GameConfig');
const User = require('../models/User');
const { creditKS, debitKS, creditCoin, debitCoin, _invalidateRateCache } = require('../services/WalletService');
const { auditLog } = require('../services/logger');
const { price } = require('../utils/ui');
const Catalog = require('../models/Catalog');
const TierService = require('../services/TierService');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build the "Select category" keyboard for Add Product from the admin's own
// catalogs (categories) in the DB. Sub-catalogs are shown indented under their
// parent. Returns null when the store has no categories yet.
async function buildAddProductCategoryKeyboard() {
  const catalogs = await Catalog.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
  if (!catalogs.length) return null;

  const roots = catalogs.filter((c) => !c.parentCategory);
  const childrenByParent = {};
  for (const c of catalogs) {
    if (c.parentCategory) {
      const key = String(c.parentCategory);
      (childrenByParent[key] = childrenByParent[key] || []).push(c);
    }
  }

  const ordered = [];
  const seen = new Set();
  for (const r of roots) {
    ordered.push(r);
    seen.add(String(r._id));
    for (const child of childrenByParent[String(r._id)] || []) {
      ordered.push({ ...child, _indent: true });
      seen.add(String(child._id));
    }
  }
  // Orphaned children (parent inactive/deleted) still get listed.
  for (const c of catalogs) {
    if (!seen.has(String(c._id))) ordered.push(c);
  }

  const buttons = ordered.map((c) =>
    Markup.button.callback(c._indent ? `↳ ${c.name}` : c.name, `ap_cat:${c._id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('❌ Cancel', 'ap_cancel')]);
  return Markup.inlineKeyboard(rows);
}

const NO_CATEGORY_MSG =
  `🛍️ *Add New Product*\n\n⚠️ သင့်ဆိုင်မှာ category (catalog) မရှိသေးပါ။\n\n` +
  `ဒါဆို အရင် category တစ်ခု ဖန်တီးပါ:\n📂 *Catalogs* → *➕ Add Catalog*\n\n` +
  `ပြီးရင် ဒီကို ပြန်လာပြီး product ထည့်ပါ။`;

async function buildConfigText(cfg) {
  return (
    `⚙️ *Coins & Tiers Config*\n\n` +
    `*🪙 Coin Bonus Rates (% of KS → Mental Coins on top-up):*\n` +
    `  🥈 Silver:   \`${(cfg.coinBonusRateSilver * 100).toFixed(1)}%\`\n` +
    `  🥇 Gold:     \`${(cfg.coinBonusRateGold * 100).toFixed(1)}%\`\n` +
    `  💎 Platinum: \`${(cfg.coinBonusRatePlatinum * 100).toFixed(1)}%\`\n\n` +
    `*📊 Tier Thresholds (total KS deposited):*\n` +
    `  🥇 Gold:     \`${cfg.tierGoldMin.toLocaleString()} KS\`\n` +
    `  💎 Platinum: \`${cfg.tierPlatinumMin.toLocaleString()} KS\`\n\n` +
    `*🏷 Tier Discounts (% off final price):*\n` +
    `  🥈 Silver:   \`${cfg.tierSilverDiscount}%\`\n` +
    `  🥇 Gold:     \`${cfg.tierGoldDiscount}%\`\n` +
    `  💎 Platinum: \`${cfg.tierPlatinumDiscount}%\``
  );
}

function buildSpinText(cfg) {
  const prizes = [
    { label: '🎉 Thank You (no reward)', w: cfg.spinWeightThanks },
    { label: '🪙 50 Coins',             w: cfg.spinWeightCoins50 },
    { label: '🪙 200 Coins',            w: cfg.spinWeightCoins200 },
    { label: '🪙 500 Coins',            w: cfg.spinWeightCoins500 },
    { label: '💰 1,000 KS',             w: cfg.spinWeightKS1000 },
    { label: '💰 5,000 KS',             w: cfg.spinWeightKS5000 },
    { label: '🎰 Free Spin',            w: cfg.spinWeightFreeSpin },
  ];
  const total = prizes.reduce((s, p) => s + p.w, 0) || 1;
  const lines = prizes.map((p) => `  ${p.label}: weight \`${p.w}\` _(${((p.w / total) * 100).toFixed(1)}%)_`);
  return (
    `🎰 *Spin Wheel Config*\n\n` +
    `💳 Paid spin cost: \`${cfg.spinCostCoins} Mental Coins\`\n\n` +
    `*Prize Pool:*\n${lines.join('\n')}`
  );
}

const SPIN_WEIGHT_FIELDS = {
  thanks:    'spinWeightThanks',
  coins_50:  'spinWeightCoins50',
  coins_200: 'spinWeightCoins200',
  coins_500: 'spinWeightCoins500',
  ks_1000:   'spinWeightKS1000',
  ks_5000:   'spinWeightKS5000',
  free_spin: 'spinWeightFreeSpin',
};

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerAdminGameConfig(bot) {

  // ── Coins & Tiers panel ────────────────────────────────────────────────────
  async function sendCoinsPanel(ctx) {
    const cfg = await GameConfig.get();
    const text = await buildConfigText(cfg);
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🪙 Edit Coin Rates',        'gc_edit_coin_menu')],
        [Markup.button.callback('📊 Edit Tier Thresholds',   'gc_edit_tier_menu')],
        [Markup.button.callback('🏷 Edit Tier Discounts',    'gc_edit_discount_menu')],
        [Markup.button.callback('🏆 Loyalty Tiers',          'admin_loyalty_panel')],
        [Markup.button.callback('💳 Adjust User Balance',    'gc_adjust_menu')],
        [Markup.button.callback('🔙 Back to Admin Panel',    'nav:go:admin_main')],
      ]),
    });
  }

  bot.action('admin_coins_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendCoinsPanel(ctx);
  });

  bot.hears('🪙 Coins & Tiers', adminOnly(), async (ctx) => {
    await sendCoinsPanel(ctx);
  });

  bot.command('coinsconfig', adminOnly(), async (ctx) => {
    await sendCoinsPanel(ctx);
  });

  // ── Loyalty Tiers editor (spend-based dual-tier; admin-editable) ───────────
  // Seed GameConfig.loyaltyTiers from defaults on first edit so the array can be
  // mutated. Returns the (possibly newly-seeded) cfg document.
  async function seedLoyaltyTiersIfEmpty(cfg) {
    if (!Array.isArray(cfg.loyaltyTiers) || cfg.loyaltyTiers.length === 0) {
      cfg.loyaltyTiers = TierService.DEFAULT_TIERS.map((t) => ({
        id:         t.id,
        min:        t.min,
        mcBonusPct: t.mcBonusPct,
        emoji:      t.emoji,
        benefits:   [...t.benefits],
      }));
      await cfg.save();
    }
    return cfg;
  }

  // Escape Telegram (legacy) Markdown metacharacters in admin-supplied text so a
  // custom tier name/benefit containing *, _, `, [ can't break the panel render.
  function escLt(s) {
    return String(s == null ? '' : s).replace(/[_*`[\]]/g, '\\$&');
  }

  // Ensure at least one tier has min:0 so every spend level maps to a tier.
  // Mutates cfg.loyaltyTiers in place; caller is responsible for save().
  function guaranteeBaseTier(cfg) {
    if (Array.isArray(cfg.loyaltyTiers) && cfg.loyaltyTiers.length > 0 &&
        !cfg.loyaltyTiers.some((t) => t.min === 0)) {
      const lowest = cfg.loyaltyTiers.reduce((a, b) => (a.min <= b.min ? a : b));
      lowest.min = 0;
    }
  }

  async function sendLoyaltyPanel(ctx) {
    const tiers = await TierService.resolveTiers();
    const lines = tiers.map((t) =>
      `${t.emoji} *${escLt(t.id)}* — min \`${t.min.toLocaleString()} KS\`, bonus \`${t.mcBonusPct}%\`\n` +
      `   _${(t.benefits && t.benefits.length) ? escLt(t.benefits.join(', ')) : 'no benefits listed'}_`
    );
    const cfg = await GameConfig.get();
    const usingDefaults = !Array.isArray(cfg.loyaltyTiers) || cfg.loyaltyTiers.length === 0;
    const text =
      `🏆 *Loyalty Tiers* _(spend-based)_\n\n` +
      lines.join('\n') +
      `\n\n_${usingDefaults ? 'Currently using built-in defaults. Editing seeds an editable copy.' : 'Custom tiers active.'}_\n` +
      `Tap a tier to edit, or add a new one.`;
    const rows = tiers.map((t) => [Markup.button.callback(`✏️ ${t.emoji} ${t.id}`, `lt_edit:${t.id}`)]);
    rows.push([Markup.button.callback('➕ Add Tier', 'lt_add_start')]);
    if (!usingDefaults) rows.push([Markup.button.callback('♻️ Reset to Default', 'lt_reset_ask')]);
    rows.push([Markup.button.callback('🔙 Back', 'admin_coins_panel')]);
    await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  bot.action('admin_loyalty_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendLoyaltyPanel(ctx);
  });

  bot.action(/^lt_edit:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const name = ctx.match[1];
    const tiers = await TierService.resolveTiers();
    const t = tiers.find((x) => x.id === name);
    if (!t) return ctx.reply('❌ Tier not found. It may have been removed.');
    await ctx.reply(
      `${t.emoji} *${escLt(t.id)}* — edit\n\n` +
      `📊 Min spend: \`${t.min.toLocaleString()} KS\`\n` +
      `🪙 MC bonus: \`${t.mcBonusPct}%\`\n` +
      `🎁 Benefits: _${(t.benefits && t.benefits.length) ? escLt(t.benefits.join(', ')) : '(none)'}_\n\nWhat do you want to change?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Min Spend', `lt_set:min:${t.id}`), Markup.button.callback('🪙 Bonus %', `lt_set:bonus:${t.id}`)],
          [Markup.button.callback('😀 Emoji', `lt_set:emoji:${t.id}`), Markup.button.callback('🎁 Benefits', `lt_set:benefits:${t.id}`)],
          [Markup.button.callback('🗑 Delete Tier', `lt_del_ask:${t.id}`)],
          [Markup.button.callback('🔙 Back', 'admin_loyalty_panel')],
        ]),
      }
    );
  });

  bot.action(/^lt_set:(min|bonus|emoji|benefits):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const name = ctx.match[2];
    ctx.session.gcEdit = { type: 'ltEditField', field, tierName: name };
    const prompts = {
      min:      `📊 Enter new *min spend* for *${name}* in KS (e.g. \`500000\`):`,
      bonus:    `🪙 Enter new *MC bonus %* for *${name}* (e.g. \`0.5\` for 0.5%):`,
      emoji:    `😀 Enter new *emoji* for *${name}* (a single emoji):`,
      benefits: `🎁 Enter *benefits* for *${name}*, comma-separated\n_(e.g. "0.5% MC bonus, Priority support")_. Type \`none\` to clear.`,
    };
    await ctx.reply(prompts[field], { parse_mode: 'Markdown' });
  });

  bot.action(/^lt_del_ask:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const name = ctx.match[1];
    await ctx.reply(`⚠️ Delete loyalty tier *${name}*?\n\nExisting users are re-evaluated on their next order.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Delete', `lt_del_confirm:${name}`), Markup.button.callback('❌ Cancel', 'admin_loyalty_panel')],
      ]),
    });
  });

  bot.action(/^lt_del_confirm:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const name = ctx.match[1];
    const cfg = await GameConfig.get();
    await seedLoyaltyTiersIfEmpty(cfg);
    const before = cfg.loyaltyTiers.length;
    if (before <= 1) return ctx.reply('❌ Cannot delete the last remaining tier. Add another first or use ♻️ Reset to Default.');
    cfg.loyaltyTiers = cfg.loyaltyTiers.filter((t) => t.id !== name);
    if (cfg.loyaltyTiers.length === before) return ctx.reply('⚠️ Tier not found.');
    guaranteeBaseTier(cfg);
    await cfg.save();
    await auditLog(ctx.from.id, 'LOYALTY_TIER_DELETE', name, 'GameConfig', {});
    await ctx.reply(`🗑 Tier *${name}* deleted.`, { parse_mode: 'Markdown' });
    await sendLoyaltyPanel(ctx);
  });

  bot.action('lt_add_start', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'ltAddName' };
    await ctx.reply(
      `➕ *Add Loyalty Tier*\n\nStep 1/4: Enter the tier *name* (e.g. "Elite").\n_No colons (\`:\`) allowed._`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('lt_reset_ask', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`♻️ Reset loyalty tiers to built-in defaults?\n\nThis removes all custom tiers.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Reset', 'lt_reset_confirm'), Markup.button.callback('❌ Cancel', 'admin_loyalty_panel')],
      ]),
    });
  });

  bot.action('lt_reset_confirm', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await GameConfig.set({ loyaltyTiers: [] });
    await auditLog(ctx.from.id, 'LOYALTY_TIER_RESET', null, 'GameConfig', {});
    await ctx.reply('♻️ Loyalty tiers reset to defaults.');
    await sendLoyaltyPanel(ctx);
  });

  // ── Spin panel ─────────────────────────────────────────────────────────────
  bot.action('admin_spin_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await GameConfig.get();
    const customCount = (cfg.customSpinPrizes || []).length;
    const customLines = customCount > 0
      ? '\n\n*Custom Prizes:*\n' + cfg.customSpinPrizes.map((p, i) =>
          `  ${i + 1}. ${p.label} _(${p.type}${p.value ? ` ${p.value}` : ''}, w=${p.weight})_`
        ).join('\n')
      : '';
    await ctx.reply(buildSpinText(cfg) + customLines, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit Prize Weights', 'gc_edit_spin_weights')],
        [Markup.button.callback('💳 Edit Spin Cost',     'gc_edit_spin_cost')],
        [Markup.button.callback('➕ Add Custom Reward',   'gc_spin_add_start')],
        ...(customCount > 0
          ? [[Markup.button.callback(`🗑 Remove Custom (${customCount})`, 'gc_spin_remove_menu')]]
          : []),
        [Markup.button.callback('🔙 Back to Admin Panel', 'nav:go:admin_main')],
      ]),
    });
  });

  // ── Add custom spin reward (multi-step wizard) ─────────────────────────────
  bot.action('gc_spin_add_start', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'spinAddType' };
    await ctx.reply(
      `➕ *Add Custom Spin Reward*\n\nStep 1/4: Select reward *type*:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🪙 Mental Coins', 'gc_spin_add_t:coin'),
           Markup.button.callback('💰 KS Cash',      'gc_spin_add_t:ks')],
          [Markup.button.callback('🎰 Free Spin',    'gc_spin_add_t:spin'),
           Markup.button.callback('🎉 Thank You',    'gc_spin_add_t:none')],
          [Markup.button.callback('❌ Cancel',       'gc_spin_add_cancel')],
        ]),
      }
    );
  });

  bot.action(/^gc_spin_add_t:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const type = ctx.match[1];
    if (!['coin', 'ks', 'spin', 'none'].includes(type)) return ctx.reply('❌ Invalid type.');
    ctx.session.gcEdit = { type: 'spinAddLabel', prizeType: type };
    await ctx.reply(
      `Step 2/4: Enter the *label* shown to users\n_(e.g. "🪙 1000 Coins", "💰 10,000 KS Jackpot")_`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('gc_spin_add_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    ctx.session.gcEdit = null;
    await ctx.reply('❌ Add reward cancelled.');
  });

  // ── Remove custom prize ────────────────────────────────────────────────────
  bot.action('gc_spin_remove_menu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await GameConfig.get();
    const custom = cfg.customSpinPrizes || [];
    if (!custom.length) return ctx.reply('No custom rewards to remove.');
    const rows = custom.map((p) => [
      Markup.button.callback(`🗑 ${p.label}`, `gc_spin_rm:${p._id}`),
    ]);
    rows.push([Markup.button.callback('🔙 Back', 'admin_spin_panel')]);
    await ctx.reply(`🗑 *Remove Custom Reward*\n\nSelect one to remove:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  });

  bot.action(/^gc_spin_rm:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const cfg = await GameConfig.get();
    const before = (cfg.customSpinPrizes || []).length;
    cfg.customSpinPrizes = (cfg.customSpinPrizes || []).filter((p) => String(p._id) !== id);
    await cfg.save();
    const removed = before - cfg.customSpinPrizes.length;
    await auditLog(ctx.from.id, 'SPIN_CUSTOM_REMOVE', id, 'GameConfig', { removed });
    await ctx.reply(removed > 0 ? `✅ Removed custom reward.` : '⚠️ Reward not found.');
  });

  // ── Coin rate edit ─────────────────────────────────────────────────────────
  bot.action('gc_edit_coin_menu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await GameConfig.get();
    await ctx.reply(
      `🪙 *Edit Coin Bonus Rates*\n\nCurrent rates:\n` +
      `🥈 Silver: ${(cfg.coinBonusRateSilver * 100).toFixed(1)}%\n` +
      `🥇 Gold: ${(cfg.coinBonusRateGold * 100).toFixed(1)}%\n` +
      `💎 Platinum: ${(cfg.coinBonusRatePlatinum * 100).toFixed(1)}%\n\nSelect tier:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🥈 Silver', 'gc_set_coin:Silver'), Markup.button.callback('🥇 Gold', 'gc_set_coin:Gold')],
          [Markup.button.callback('💎 Platinum', 'gc_set_coin:Platinum')],
          [Markup.button.callback('🔙 Back', 'admin_coins_panel')],
        ]),
      }
    );
  });

  bot.action(/^gc_set_coin:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'coinRate', tier: ctx.match[1] };
    await ctx.reply(
      `🪙 Set *${ctx.match[1]}* coin bonus rate\n\nEnter as percentage (e.g. \`1.5\` for 1.5%):`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Tier threshold edit ────────────────────────────────────────────────────
  bot.action('gc_edit_tier_menu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await GameConfig.get();
    await ctx.reply(
      `📊 *Edit Tier Thresholds*\n\nCurrent thresholds:\n` +
      `🥇 Gold: ${cfg.tierGoldMin.toLocaleString()} KS\n` +
      `💎 Platinum: ${cfg.tierPlatinumMin.toLocaleString()} KS\n\nSelect tier:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🥇 Gold', 'gc_set_tier:Gold'), Markup.button.callback('💎 Platinum', 'gc_set_tier:Platinum')],
          [Markup.button.callback('🔙 Back', 'admin_coins_panel')],
        ]),
      }
    );
  });

  bot.action(/^gc_set_tier:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'tierMin', tier: ctx.match[1] };
    await ctx.reply(
      `📊 Set *${ctx.match[1]}* threshold\n\nEnter minimum total KS deposited (e.g. \`500000\`):`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Tier discount edit ─────────────────────────────────────────────────────
  bot.action('gc_edit_discount_menu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await GameConfig.get();
    await ctx.reply(
      `🏷 *Edit Tier Discounts*\n\nCurrent discounts:\n` +
      `🥈 Silver: ${cfg.tierSilverDiscount}%\n` +
      `🥇 Gold: ${cfg.tierGoldDiscount}%\n` +
      `💎 Platinum: ${cfg.tierPlatinumDiscount}%\n\nSelect tier:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🥈 Silver', 'gc_set_disc:Silver'), Markup.button.callback('🥇 Gold', 'gc_set_disc:Gold')],
          [Markup.button.callback('💎 Platinum', 'gc_set_disc:Platinum')],
          [Markup.button.callback('🔙 Back', 'admin_coins_panel')],
        ]),
      }
    );
  });

  bot.action(/^gc_set_disc:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'discount', tier: ctx.match[1] };
    await ctx.reply(
      `🏷 Set *${ctx.match[1]}* discount\n\nEnter percentage (e.g. \`2\` for 2%):`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Spin config edit ───────────────────────────────────────────────────────
  bot.action('gc_edit_spin_cost', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await GameConfig.get();
    ctx.session.gcEdit = { type: 'spinCost' };
    await ctx.reply(
      `💳 *Edit Spin Cost*\n\nCurrent: *${cfg.spinCostCoins} Mental Coins*\n\nEnter new cost in coins:`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('gc_edit_spin_weights', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🎰 *Edit Prize Weights*\n\nSelect prize to edit:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎉 Thank You',  'gc_spin_w:thanks'),    Markup.button.callback('🪙 50 Coins',  'gc_spin_w:coins_50')],
        [Markup.button.callback('🪙 200 Coins',  'gc_spin_w:coins_200'), Markup.button.callback('🪙 500 Coins', 'gc_spin_w:coins_500')],
        [Markup.button.callback('💰 1,000 KS',   'gc_spin_w:ks_1000'),   Markup.button.callback('💰 5,000 KS', 'gc_spin_w:ks_5000')],
        [Markup.button.callback('🎰 Free Spin',  'gc_spin_w:free_spin')],
        [Markup.button.callback('🔙 Back',       'admin_spin_panel')],
      ]),
    });
  });

  bot.action(/^gc_spin_w:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'spinWeight', prizeId: ctx.match[1] };
    await ctx.reply(
      `🎰 Set weight for *${ctx.match[1]}*\n\nEnter new weight (integer). Higher = more likely.\nCurrent total should be ~100 for easy probability reading.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── User balance adjustment ────────────────────────────────────────────────
  bot.action('gc_adjust_menu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.gcEdit = { type: 'adjustUserId' };
    await ctx.reply(`💳 *Adjust User Balance*\n\nEnter the Telegram ID of the user:`, { parse_mode: 'Markdown' });
  });

  bot.action(/^gc_adj:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const op = ctx.match[1];
    if (op === 'cancel') {
      ctx.session.gcEdit = null;
      return ctx.reply('❌ Cancelled.');
    }
    const state = ctx.session?.gcEdit;
    if (!state) return ctx.reply('❌ Session expired. Start again.');
    const labels = { addks: 'Add KS', subks: 'Remove KS', addcoin: 'Add Coins', subcoin: 'Remove Coins' };
    const unit = op.includes('coin') ? 'Mental Coins' : 'KS';
    ctx.session.gcEdit = { type: 'adjustAmount', userId: state.userId, userName: state.userName, op };
    await ctx.reply(`Enter amount to *${labels[op] || op}* (in ${unit}):`, { parse_mode: 'Markdown' });
  });

  // ── Product management wizard (add) ───────────────────────────────────────
  bot.action('admin_product_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const kb = await buildAddProductCategoryKeyboard();
    if (!kb) {
      ctx.session.adminAddProduct = null;
      return ctx.reply(NO_CATEGORY_MSG, { parse_mode: 'Markdown' });
    }
    ctx.session.adminAddProduct = { step: 'category' };
    await ctx.reply(`🛍️ *Add New Product*\n\nStep 1/4: Select category:`, {
      parse_mode: 'Markdown',
      ...kb,
    });
  });

  bot.action(/^ap_cat:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const raw = ctx.match[1];
    let categoryName = raw;
    let catalogId = null;
    const cat = await Catalog.findById(raw).select('name').lean().catch(() => null);
    if (cat) { categoryName = cat.name; catalogId = String(cat._id); }
    ctx.session.adminAddProduct = { step: 'name', category: categoryName, catalogId };
    await ctx.reply(
      `✅ Category: *${categoryName}*\n\nStep 2/4: Enter product name (e.g. "86 Diamonds"):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Category', 'ap_back_to_cat'), Markup.button.callback('❌ Cancel', 'ap_cancel')],
        ]),
      }
    );
  });

  bot.action('ap_back_to_cat', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const kb = await buildAddProductCategoryKeyboard();
    if (!kb) {
      ctx.session.adminAddProduct = null;
      return ctx.reply(NO_CATEGORY_MSG, { parse_mode: 'Markdown' });
    }
    ctx.session.adminAddProduct = { step: 'category' };
    await ctx.reply(`🛍️ *Add New Product*\n\nStep 1/4: Select category:`, {
      parse_mode: 'Markdown',
      ...kb,
    });
  });

  bot.action('ap_back_to_name', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.session.adminAddProduct || {};
    if (!state.category) {
      const kb = await buildAddProductCategoryKeyboard();
      ctx.session.adminAddProduct = kb ? { step: 'category' } : null;
      if (!kb) return ctx.reply(NO_CATEGORY_MSG, { parse_mode: 'Markdown' });
      return ctx.reply('🛍️ *Add New Product*\n\nStep 1/4: Select category:', { parse_mode: 'Markdown', ...kb });
    }
    ctx.session.adminAddProduct = { step: 'name', category: state.category, catalogId: state.catalogId };
    await ctx.reply(
      `✅ Category: *${state.category || '?'}*\n\nStep 2/4: Enter product name (e.g. "86 Diamonds"):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Category', 'ap_back_to_cat'), Markup.button.callback('❌ Cancel', 'ap_cancel')],
        ]),
      }
    );
  });

  bot.action('ap_back_to_price', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.session.adminAddProduct || {};
    if (!state.category || !state.name) {
      const kb = await buildAddProductCategoryKeyboard();
      ctx.session.adminAddProduct = kb ? { step: 'category' } : null;
      if (!kb) return ctx.reply(NO_CATEGORY_MSG, { parse_mode: 'Markdown' });
      return ctx.reply('🛍️ *Add New Product*\n\nStep 1/4: Select category:', { parse_mode: 'Markdown', ...kb });
    }
    ctx.session.adminAddProduct = { step: 'price', category: state.category, name: state.name, catalogId: state.catalogId };
    await ctx.reply(
      `✅ Name: *${state.name || '?'}*\n\nStep 3/4: Enter price in KS (e.g. \`5000\`):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Name', 'ap_back_to_name'), Markup.button.callback('❌ Cancel', 'ap_cancel')],
        ]),
      }
    );
  });

  bot.action('ap_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    ctx.session.adminAddProduct = null;
    await ctx.reply('❌ Product creation cancelled.');
  });

  bot.action(/^ap_toggle:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const Product = require('../models/Product');
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    p.isActive = !p.isActive;
    await p.save();
    await auditLog(ctx.from.id, p.isActive ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED', ctx.match[1], 'Product', {});
    await ctx.reply(`${p.isActive ? '✅' : '🔴'} *${p.name}* is now *${p.isActive ? 'Active' : 'Inactive'}*.`, { parse_mode: 'Markdown' });
  });

  bot.action(/^ap_delete_ask:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const Product = require('../models/Product');
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    ctx.session.confirmDeleteProduct = ctx.match[1];
    await ctx.reply(
      `⚠️ Delete *${p.name}*?\n\nThis cannot be undone.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Delete', 'ap_delete_confirm'), Markup.button.callback('❌ Cancel', 'ap_delete_cancel')],
        ]),
      }
    );
  });

  bot.action('ap_delete_confirm', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const Product = require('../models/Product');
    const productId = ctx.session.confirmDeleteProduct;
    ctx.session.confirmDeleteProduct = null;
    if (!productId) return ctx.reply('❌ No product selected.');
    const p = await Product.findByIdAndDelete(productId);
    if (!p) return ctx.reply('❌ Product not found.');
    await auditLog(ctx.from.id, 'PRODUCT_DELETED', productId, 'Product', { name: p.name });
    await ctx.reply(`🗑 *${p.name}* deleted.`, { parse_mode: 'Markdown' });
  });

  bot.action('ap_delete_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    ctx.session.confirmDeleteProduct = null;
    await ctx.reply('❌ Delete cancelled.');
  });

  // ── Universal text interceptor for all gcEdit / adminAddProduct flows ──────
  bot.on('text', async (ctx, next) => {
    const { config } = require('../../config/settings');
    if (Number(ctx.from?.id) !== Number(config.bot.adminId)) return next();

    // Let slash commands flow through to their proper handlers
    if (ctx.message?.text?.startsWith('/')) return next();

    // Fast path: skip entirely if no wizard/edit session is active
    if (!ctx.session?.adminAddProduct && !ctx.session?.gcEdit) return next();

    // ── Product wizard ──────────────────────────────────────────────────────
    const addState = ctx.session?.adminAddProduct;
    if (addState) {
      const input = ctx.message.text.trim();
      if (addState.step === 'name') {
        if (input.length < 2 || input.length > 80) return ctx.reply('❌ Name must be 2–80 characters.');
        ctx.session.adminAddProduct = { ...addState, step: 'price', name: input };
        return ctx.reply(
          `✅ Name: *${input}*\n\nStep 3/4: Enter price in KS (e.g. \`5000\`):`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Back to Name', 'ap_back_to_name'), Markup.button.callback('❌ Cancel', 'ap_cancel')],
            ]),
          }
        );
      }
      if (addState.step === 'price') {
        const p = parseInt(input.replace(/,/g, ''), 10);
        if (isNaN(p) || p <= 0) return ctx.reply('❌ Enter a positive number.');
        ctx.session.adminAddProduct = { ...addState, step: 'description', price: p };
        return ctx.reply(
          `✅ Price: *${price(p)}*\n\nStep 4/4: Enter description (or type \`skip\`):`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Back to Price', 'ap_back_to_price'), Markup.button.callback('❌ Cancel', 'ap_cancel')],
            ]),
          }
        );
      }
      if (addState.step === 'description') {
        const desc = input.toLowerCase() === 'skip' ? '' : input;
        // Safety guard: never attempt to create a product with incomplete data.
        // If the earlier steps' data is somehow missing from the session, show a
        // clear message and let the admin restart instead of a raw DB error.
        if (!addState.name || !addState.category || addState.price == null) {
          ctx.session.adminAddProduct = null;
          return ctx.reply(
            '❌ ဆော့ရီးပါ — Product ဖန်တီးမှု အဆင့်အချက်အလက် (name/category) ပျောက်သွားလို့ မဆက်နိုင်တော့ပါ။\n\n' +
            '👉 📂 *Manage Products → ➕ Add Product* ကနေ အစကနေ ပြန်စပေးပါ။ Category → Name → Price → Description အစဉ်လိုက် တစ်ဆင့်ချင်း ဖြည့်ပေးပါ။',
            { parse_mode: 'Markdown' }
          );
        }
        ctx.session.adminAddProduct = null;
        const Product = require('../models/Product');
        try {
          const product = await Product.create({
            name: addState.name,
            category: addState.category,
            ...(addState.catalogId ? { catalogId: addState.catalogId } : {}),
            region: 'Global',
            baseCurrency: 'MMK',
            baseCost: addState.price,
            finalPrice: addState.price,
            description: desc,
            isActive: true,
          });
          await auditLog(ctx.from.id, 'PRODUCT_CREATED', product._id.toString(), 'Product', { name: product.name, price: addState.price });
          const CacheService = require('../services/CacheService');
          if (typeof CacheService.invalidate === 'function') CacheService.invalidate(addState.category);
          return ctx.reply(
            `✅ *Product Created!*\n\n📦 *${product.name}*\n📁 ${product.category}\n💰 ${price(product.finalPrice)}` +
            (desc ? `\n📝 ${desc}` : '') +
            `\n\n_It now appears in the shop under ${product.category}._`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          ctx.session.adminAddProduct = null;
          return ctx.reply(`❌ Failed: ${err.message}`);
        }
      }
    }

    // ── GameConfig edit flows ───────────────────────────────────────────────
    const state = ctx.session?.gcEdit;
    if (!state) return next();

    const input = ctx.message.text.trim();

    if (state.type === 'coinRate') {
      const pct = parseFloat(input);
      if (isNaN(pct) || pct < 0 || pct > 100) return ctx.reply('❌ Enter 0–100 (e.g. 1.5 for 1.5%).');
      const field = { Silver: 'coinBonusRateSilver', Gold: 'coinBonusRateGold', Platinum: 'coinBonusRatePlatinum' }[state.tier];
      await GameConfig.set({ [field]: pct / 100 });
      if (_invalidateRateCache) _invalidateRateCache();
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'UPDATE_COIN_RATE', null, 'GameConfig', { tier: state.tier, pct });
      return ctx.reply(`✅ *${state.tier}* coin bonus rate → *${pct}%*`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'tierMin') {
      const val = parseInt(input.replace(/,/g, ''), 10);
      if (isNaN(val) || val <= 0) return ctx.reply('❌ Enter a positive integer.');
      const field = { Gold: 'tierGoldMin', Platinum: 'tierPlatinumMin' }[state.tier];
      await GameConfig.set({ [field]: val });
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'UPDATE_TIER_THRESHOLD', null, 'GameConfig', { tier: state.tier, min: val });
      return ctx.reply(`✅ *${state.tier}* threshold → *${val.toLocaleString()} KS*`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'discount') {
      const pct = parseFloat(input);
      if (isNaN(pct) || pct < 0 || pct > 100) return ctx.reply('❌ Enter 0–100.');
      const field = { Silver: 'tierSilverDiscount', Gold: 'tierGoldDiscount', Platinum: 'tierPlatinumDiscount' }[state.tier];
      await GameConfig.set({ [field]: pct });
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'UPDATE_TIER_DISCOUNT', null, 'GameConfig', { tier: state.tier, pct });
      return ctx.reply(`✅ *${state.tier}* discount → *${pct}%*`, { parse_mode: 'Markdown' });
    }

    // ── Loyalty tier: edit an existing tier's field ──────────────────────────
    if (state.type === 'ltEditField') {
      const cfg = await GameConfig.get();
      await seedLoyaltyTiersIfEmpty(cfg);
      const tier = cfg.loyaltyTiers.find((t) => t.id === state.tierName);
      if (!tier) {
        ctx.session.gcEdit = null;
        return ctx.reply('❌ Tier not found. It may have been removed.');
      }
      if (state.field === 'min') {
        const val = parseInt(input.replace(/,/g, ''), 10);
        if (isNaN(val) || val < 0) return ctx.reply('❌ Enter a non-negative integer (KS).');
        tier.min = val;
      } else if (state.field === 'bonus') {
        const val = parseFloat(input);
        if (isNaN(val) || val < 0 || val > 100) return ctx.reply('❌ Enter 0–100 (e.g. 0.5 for 0.5%).');
        tier.mcBonusPct = val;
      } else if (state.field === 'emoji') {
        if (input.length < 1 || input.length > 8) return ctx.reply('❌ Enter a single emoji.');
        tier.emoji = input;
      } else if (state.field === 'benefits') {
        tier.benefits = input.toLowerCase() === 'none'
          ? []
          : input.split(',').map((s) => s.trim()).filter(Boolean);
      }
      guaranteeBaseTier(cfg);
      await cfg.save();
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'LOYALTY_TIER_EDIT', state.tierName, 'GameConfig', { field: state.field });
      return ctx.reply(`✅ *${state.tierName}* ${state.field} updated.`, { parse_mode: 'Markdown' });
    }

    // ── Loyalty tier: add wizard ─────────────────────────────────────────────
    if (state.type === 'ltAddName') {
      const name = input;
      if (name.length < 2 || name.length > 20) return ctx.reply('❌ Name must be 2–20 characters.');
      if (name.includes(':')) return ctx.reply('❌ Name cannot contain a colon (:).');
      const tiers = await TierService.resolveTiers();
      if (tiers.some((t) => t.id.toLowerCase() === name.toLowerCase())) {
        return ctx.reply('❌ A tier with that name already exists.');
      }
      ctx.session.gcEdit = { type: 'ltAddMin', name };
      return ctx.reply(`Step 2/4: Enter *min spend* to reach *${name}* in KS (e.g. \`3000000\`):`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'ltAddMin') {
      const val = parseInt(input.replace(/,/g, ''), 10);
      if (isNaN(val) || val < 0) return ctx.reply('❌ Enter a non-negative integer (KS).');
      ctx.session.gcEdit = { type: 'ltAddBonus', name: state.name, min: val };
      return ctx.reply(`Step 3/4: Enter *MC bonus %* for *${state.name}* (e.g. \`0.5\`):`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'ltAddBonus') {
      const val = parseFloat(input);
      if (isNaN(val) || val < 0 || val > 100) return ctx.reply('❌ Enter 0–100 (e.g. 0.5 for 0.5%).');
      ctx.session.gcEdit = { type: 'ltAddEmoji', name: state.name, min: state.min, mcBonusPct: val };
      return ctx.reply(`Step 4/4: Enter an *emoji* for *${state.name}* (or type \`skip\` for 🏅):`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'ltAddEmoji') {
      const emoji = input.toLowerCase() === 'skip' ? '🏅' : input;
      if (emoji.length > 8) return ctx.reply('❌ Enter a single emoji or `skip`.');
      const cfg = await GameConfig.get();
      await seedLoyaltyTiersIfEmpty(cfg);
      if (cfg.loyaltyTiers.some((t) => t.id.toLowerCase() === state.name.toLowerCase())) {
        ctx.session.gcEdit = null;
        return ctx.reply('❌ A tier with that name already exists.');
      }
      cfg.loyaltyTiers.push({
        id:         state.name,
        min:        state.min,
        mcBonusPct: state.mcBonusPct,
        emoji,
        benefits:   [`${state.mcBonusPct}% MC bonus`],
      });
      guaranteeBaseTier(cfg);
      await cfg.save();
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'LOYALTY_TIER_ADD', state.name, 'GameConfig', { min: state.min, mcBonusPct: state.mcBonusPct });
      return ctx.reply(
        `✅ *Loyalty Tier Added!*\n\n${emoji} *${state.name}*\n📊 Min: \`${state.min.toLocaleString()} KS\`\n🪙 Bonus: \`${state.mcBonusPct}%\`\n\n_Edit its benefits from 🏆 Loyalty Tiers → ✏️ ${state.name} → 🎁 Benefits._`,
        { parse_mode: 'Markdown' }
      );
    }

    if (state.type === 'spinCost') {
      const val = parseInt(input, 10);
      if (isNaN(val) || val < 0) return ctx.reply('❌ Enter a non-negative integer.');
      await GameConfig.set({ spinCostCoins: val });
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'UPDATE_SPIN_COST', null, 'GameConfig', { cost: val });
      return ctx.reply(`✅ Spin cost → *${val} Mental Coins*`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'spinAddLabel') {
      if (input.length < 2 || input.length > 60) return ctx.reply('❌ Label must be 2–60 characters.');
      ctx.session.gcEdit = { type: 'spinAddValue', prizeType: state.prizeType, label: input };
      if (state.prizeType === 'none' || state.prizeType === 'spin') {
        ctx.session.gcEdit.value = state.prizeType === 'spin' ? 1 : 0;
        ctx.session.gcEdit.type = 'spinAddWeight';
        return ctx.reply(`Step 4/4: Enter *weight* (integer, higher = more common):`, { parse_mode: 'Markdown' });
      }
      const unit = state.prizeType === 'coin' ? 'Mental Coins' : 'KS';
      return ctx.reply(`Step 3/4: Enter *${unit}* amount to award (e.g. \`1000\`):`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'spinAddValue') {
      const val = parseInt(input.replace(/,/g, ''), 10);
      if (isNaN(val) || val <= 0) return ctx.reply('❌ Enter a positive integer.');
      ctx.session.gcEdit = { type: 'spinAddWeight', prizeType: state.prizeType, label: state.label, value: val };
      return ctx.reply(`Step 4/4: Enter *weight* (integer, higher = more common):`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'spinAddWeight') {
      const weight = parseInt(input, 10);
      if (isNaN(weight) || weight < 0) return ctx.reply('❌ Enter a non-negative integer.');
      const cfg = await GameConfig.get();
      cfg.customSpinPrizes.push({
        label:  state.label,
        type:   state.prizeType,
        value:  state.value || 0,
        weight,
      });
      await cfg.save();
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'SPIN_CUSTOM_ADD', null, 'GameConfig', {
        label: state.label, type: state.prizeType, value: state.value || 0, weight,
      });
      return ctx.reply(
        `✅ *Custom Reward Added!*\n\n` +
        `🏷 ${state.label}\n` +
        `📊 Type: \`${state.prizeType}\`${state.value ? ` (${state.value})` : ''}\n` +
        `⚖️ Weight: *${weight}*`,
        { parse_mode: 'Markdown' }
      );
    }

    if (state.type === 'spinWeight') {
      const val = parseInt(input, 10);
      if (isNaN(val) || val < 0) return ctx.reply('❌ Enter a non-negative integer.');
      const field = SPIN_WEIGHT_FIELDS[state.prizeId];
      if (!field) return ctx.reply('❌ Unknown prize ID.');
      await GameConfig.set({ [field]: val });
      ctx.session.gcEdit = null;
      await auditLog(ctx.from.id, 'UPDATE_SPIN_WEIGHT', null, 'GameConfig', { prize: state.prizeId, weight: val });
      return ctx.reply(`✅ Weight for *${state.prizeId}* → *${val}*`, { parse_mode: 'Markdown' });
    }

    if (state.type === 'adjustUserId') {
      const id = parseInt(input, 10);
      if (isNaN(id)) return ctx.reply('❌ Enter a valid Telegram ID (numbers only).');
      const user = await User.findByTelegramId(id);
      if (!user) return ctx.reply(`❌ User \`${id}\` not found.`, { parse_mode: 'Markdown' });
      ctx.session.gcEdit = { type: 'adjustType', userId: id, userName: user.username || user.first_name || String(id) };
      return ctx.reply(
        `👤 *${ctx.session.gcEdit.userName}* (\`${id}\`)\n💰 KS: ${price(user.balanceKS)} | 🪙 Coins: ${user.balanceCoin.toLocaleString()} MC\n\nChoose action:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add KS',     'gc_adj:addks'),   Markup.button.callback('➖ Remove KS',     'gc_adj:subks')],
            [Markup.button.callback('➕ Add Coins',  'gc_adj:addcoin'), Markup.button.callback('➖ Remove Coins',  'gc_adj:subcoin')],
            [Markup.button.callback('❌ Cancel',     'gc_adj:cancel')],
          ]),
        }
      );
    }

    if (state.type === 'adjustAmount') {
      const amount = parseInt(input.replace(/,/g, ''), 10);
      if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Enter a positive integer.');
      const user = await User.findByTelegramId(state.userId);
      if (!user) return ctx.reply('❌ User not found.');
      ctx.session.gcEdit = null;
      try {
        if (state.op === 'addks') {
          await creditKS(user._id, amount, { type: 'AdminCredit', note: 'Admin manual credit' });
          await auditLog(ctx.from.id, 'ADMIN_CREDIT_KS', user._id.toString(), 'User', { amount });
          return ctx.reply(`✅ +*${amount.toLocaleString()} KS* credited to *${state.userName}*`, { parse_mode: 'Markdown' });
        } else if (state.op === 'subks') {
          await debitKS(user._id, amount, { type: 'AdminDebit', note: 'Admin manual debit' });
          await auditLog(ctx.from.id, 'ADMIN_DEBIT_KS', user._id.toString(), 'User', { amount });
          return ctx.reply(`✅ -*${amount.toLocaleString()} KS* debited from *${state.userName}*`, { parse_mode: 'Markdown' });
        } else if (state.op === 'addcoin') {
          await creditCoin(user._id, amount, { type: 'Bonus', note: 'Admin manual coin credit' });
          await auditLog(ctx.from.id, 'ADMIN_CREDIT_COIN', user._id.toString(), 'User', { amount });
          return ctx.reply(`✅ +*${amount.toLocaleString()} MC* credited to *${state.userName}*`, { parse_mode: 'Markdown' });
        } else if (state.op === 'subcoin') {
          await debitCoin(user._id, amount, { type: 'Debit', note: 'Admin manual coin debit' });
          await auditLog(ctx.from.id, 'ADMIN_DEBIT_COIN', user._id.toString(), 'User', { amount });
          return ctx.reply(`✅ -*${amount.toLocaleString()} MC* debited from *${state.userName}*`, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        return ctx.reply(`❌ ${err.message}`);
      }
    }

    return next();
  });
};
