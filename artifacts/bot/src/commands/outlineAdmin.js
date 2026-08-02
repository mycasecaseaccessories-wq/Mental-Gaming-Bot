/**
 * outlineAdmin.js — Outline VPN admin panel.
 *
 * Admin မီနူး (Admin keyboard မှ "🔑 Outline VPN"):
 *   🖥️ Servers   — ထည့်/ကြည့်/ဖျက်
 *   📋 Plans     — ဖန်တီး/ကြည့်/ဖျက်
 *   ⚙️ Free Config — Free key settings
 *   📊 All Keys  — Server တစ်ခု ရွေး → key list
 *
 * Wizard steps are stored in ctx.session.outlineAdminWizard = { step, data }
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const OutlineServer = require('../models/OutlineServer');
const OutlineKey = require('../models/OutlineKey');
const OutlinePlan = require('../models/OutlinePlan');
const OutlineFreeConfig = require('../models/OutlineFreeConfig');
const OutlineService = require('../services/OutlineService');
const { auditLog } = require('../services/logger');

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[_*`[\]()~>#+=|{}.!-]/g, '\\$1');
}

function fmtGb(gb) {
  return gb == null ? '∞ (ကန့်သတ်မထားပါ)' : `${gb} GB`;
}

function fmtDays(d) {
  return d == null ? '∞ (သက်တမ်း မသတ်မှတ်)' : `${d} ရက်`;
}

function clearWizard(ctx) {
  if (ctx.session) ctx.session.outlineAdminWizard = null;
}

function setWizard(ctx, step, data = {}) {
  if (!ctx.session) ctx.session = {};
  ctx.session.outlineAdminWizard = { step, data };
}

function getWizard(ctx) {
  return ctx.session?.outlineAdminWizard || null;
}

// ── Keyboards ────────────────────────────────────────────────────────────────

function adminMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖥️ Servers', 'oadm_servers')],
    [Markup.button.callback('📋 Plans', 'oadm_plans')],
    [Markup.button.callback('⚙️ Free Key Config', 'oadm_free_config')],
    [Markup.button.callback('📊 Keys ကြည့်ရန်', 'oadm_all_keys')],
  ]);
}

function serversKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Server ထည့်ရန်', 'oadm_srv_add')],
    [Markup.button.callback('📋 Server များ ကြည့်ရန်', 'oadm_srv_list')],
    [Markup.button.callback('🗑 Server ဖျက်ရန်', 'oadm_srv_del_select')],
    [Markup.button.callback('🔙 နောက်သို့', 'oadm_menu')],
  ]);
}

function plansKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Plan ထည့်ရန်', 'oadm_plan_add')],
    [Markup.button.callback('📋 Plan များ ကြည့်ရန်', 'oadm_plan_list')],
    [Markup.button.callback('🗑 Plan ဖျက်ရန်', 'oadm_plan_del_select')],
    [Markup.button.callback('🔙 နောက်သို့', 'oadm_menu')],
  ]);
}

function cancelKeyboard(backCallback = 'oadm_menu') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ ပယ်ဖျက်', backCallback)],
  ]);
}

// ── Register ─────────────────────────────────────────────────────────────────

module.exports = function register(bot) {
  // ── Entry via admin keyboard ─────────────────────────────────────────────
  bot.hears('🔑 Outline VPN', adminOnly(), async (ctx) => {
    clearWizard(ctx);
    await ctx.reply(
      '🔑 *Outline VPN — Admin Panel*\n\nဘာလုပ်လိုပါသလဲ?',
      { parse_mode: 'Markdown', ...adminMainKeyboard() }
    );
  });

  // ── Main menu ────────────────────────────────────────────────────────────
  bot.action('oadm_menu', adminOnly(), async (ctx) => {
    clearWizard(ctx);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🔑 *Outline VPN — Admin Panel*\n\nဘာလုပ်လိုပါသလဲ?',
      { parse_mode: 'Markdown', ...adminMainKeyboard() }
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  SERVERS
  // ════════════════════════════════════════════════════════════════════════════

  bot.action('oadm_servers', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🖥️ *Server စီမံခန့်ခွဲမှု*',
      { parse_mode: 'Markdown', ...serversKeyboard() }
    );
  });

  // ── Server list ──────────────────────────────────────────────────────────
  bot.action('oadm_srv_list', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const servers = await OutlineServer.find().sort({ createdAt: 1 });
    if (!servers.length) {
      return ctx.editMessageText('📭 Server မရှိသေးပါ။', serversKeyboard());
    }
    const lines = servers.map((s, i) => {
      const status = s.isActive ? '🟢' : '🔴';
      const host = s.apiUrl.split('/').slice(0, 3).join('/');
      return `${i + 1}. ${status} *${esc(s.name)}*\n   \`${host}\``;
    });
    await ctx.editMessageText(
      `🖥️ *Server များ (${servers.length})*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown', ...serversKeyboard() }
    );
  });

  // ── Add Server wizard ────────────────────────────────────────────────────
  bot.action('oadm_srv_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    setWizard(ctx, 'srv_name');
    await ctx.reply(
      '🖥️ *Server ထည့်ရန် — အဆင့် 1/3*\n\nServer အမည် ရိုက်ထည့်ပါ:\n_(ဥပမာ: SG-01)_\n\n/cancel — ပယ်ဖျက်ရန်',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Delete Server: select ────────────────────────────────────────────────
  bot.action('oadm_srv_del_select', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const servers = await OutlineServer.find({ isActive: true }).sort({ createdAt: 1 });
    if (!servers.length) {
      return ctx.editMessageText('📭 ဖျက်ရန် Server မရှိပါ။', serversKeyboard());
    }
    const buttons = servers.map((s) => [
      Markup.button.callback(`🗑 ${s.name}`, `oadm_srv_del:${s._id}`),
    ]);
    buttons.push([Markup.button.callback('🔙 နောက်သို့', 'oadm_servers')]);
    await ctx.editMessageText('🗑 ဖျက်မည့် Server ကို ရွေးပါ:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^oadm_srv_del:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const srvId = ctx.match[1];
    const server = await OutlineServer.findById(srvId);
    if (!server) return ctx.editMessageText('⚠️ Server မတွေ့ပါ။', serversKeyboard());
    await ctx.editMessageText(
      `⚠️ *${esc(server.name)}* ကို ဖျက်မည် — သေချာပါသလား?\n\n_(ဤ action သည် DB record ကိုသာ ဖျက်သည်\\. Outline server ပေါ်ရှိ key များ မဖျက်ပါ\\.)_`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ ဖျက်မည်', `oadm_srv_del_ok:${srvId}`)],
          [Markup.button.callback('❌ မဖျက်တော့ပါ', 'oadm_servers')],
        ]),
      }
    );
  });

  bot.action(/^oadm_srv_del_ok:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const srvId = ctx.match[1];
    const server = await OutlineServer.findById(srvId);
    const name = server?.name || srvId;
    await OutlineServer.findByIdAndUpdate(srvId, { isActive: false });
    auditLog(ctx, `Outline Server disabled: ${name}`);
    await ctx.editMessageText(`✅ *${esc(name)}* ကို ရပ်နားထားလိုက်ပါပြီ။`, {
      parse_mode: 'Markdown',
      ...serversKeyboard(),
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  PLANS
  // ════════════════════════════════════════════════════════════════════════════

  bot.action('oadm_plans', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('📋 *Plan စီမံခန့်ခွဲမှု*', {
      parse_mode: 'Markdown',
      ...plansKeyboard(),
    });
  });

  // ── Plan list ────────────────────────────────────────────────────────────
  bot.action('oadm_plan_list', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const plans = await OutlinePlan.find().sort({ displayOrder: 1, priceKs: 1 });
    if (!plans.length) {
      return ctx.editMessageText('📭 Plan မရှိသေးပါ။', plansKeyboard());
    }
    const lines = plans.map((p, i) => {
      const status = p.isActive ? '🟢' : '🔴';
      return (
        `${i + 1}. ${status} *${esc(p.name)}*\n` +
        `   ဈေးနှုန်း: ${p.priceKs.toLocaleString()} KS\n` +
        `   Data: ${fmtGb(p.dataLimitGb)}  |  သက်တမ်း: ${fmtDays(p.durationDays)}`
      );
    });
    await ctx.editMessageText(
      `📋 *Plans (${plans.length})*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown', ...plansKeyboard() }
    );
  });

  // ── Add Plan wizard ──────────────────────────────────────────────────────
  bot.action('oadm_plan_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    setWizard(ctx, 'plan_name');
    await ctx.reply(
      '📋 *Plan ထည့်ရန် — အဆင့် 1/4*\n\nPlan အမည် ရိုက်ထည့်ပါ:\n_(ဥပမာ: Basic 30Days)_\n\n/cancel — ပယ်ဖျက်ရန်',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Delete Plan: select ──────────────────────────────────────────────────
  bot.action('oadm_plan_del_select', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const plans = await OutlinePlan.find({ isActive: true }).sort({ displayOrder: 1 });
    if (!plans.length) {
      return ctx.editMessageText('📭 ဖျက်ရန် Plan မရှိပါ။', plansKeyboard());
    }
    const buttons = plans.map((p) => [
      Markup.button.callback(
        `🗑 ${p.name} (${p.priceKs.toLocaleString()} KS)`,
        `oadm_plan_del:${p._id}`
      ),
    ]);
    buttons.push([Markup.button.callback('🔙 နောက်သို့', 'oadm_plans')]);
    await ctx.editMessageText('🗑 ဖျက်မည့် Plan ကို ရွေးပါ:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^oadm_plan_del:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const planId = ctx.match[1];
    const plan = await OutlinePlan.findById(planId);
    if (!plan) return ctx.editMessageText('⚠️ Plan မတွေ့ပါ။', plansKeyboard());
    await OutlinePlan.findByIdAndUpdate(planId, { isActive: false });
    auditLog(ctx, `Outline Plan disabled: ${plan.name}`);
    await ctx.editMessageText(
      `✅ Plan *${esc(plan.name)}* ကို ရပ်နားထားလိုက်ပါပြီ။`,
      { parse_mode: 'Markdown', ...plansKeyboard() }
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  FREE CONFIG
  // ════════════════════════════════════════════════════════════════════════════

  bot.action('oadm_free_config', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await OutlineFreeConfig.get();
    const text =
      `⚙️ *Free Key Config*\n\n` +
      `• အခြေအနေ: ${cfg.enabled ? '🟢 ဖွင့်ထားသည်' : '🔴 ပိတ်ထားသည်'}\n` +
      `• Data: ${fmtGb(cfg.dataLimitGb)}\n` +
      `• သက်တမ်း: ${fmtDays(cfg.durationDays)}\n` +
      `• User တစ်ယောက်အများဆုံး: ${cfg.maxKeysPerUser} keys\n` +
      `• Cooldown: ${cfg.cooldownHours ? cfg.cooldownHours + ' နာရီ' : 'မရှိ'}`;

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(
          cfg.enabled ? '🔴 ပိတ်မည်' : '🟢 ဖွင့်မည်',
          'oadm_free_toggle'
        )],
        [Markup.button.callback('✏️ Config ပြောင်းရန်', 'oadm_free_edit')],
        [Markup.button.callback('🔙 နောက်သို့', 'oadm_menu')],
      ]),
    });
  });

  bot.action('oadm_free_toggle', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cfg = await OutlineFreeConfig.get();
    cfg.enabled = !cfg.enabled;
    await cfg.save();
    auditLog(ctx, `Outline Free Key ${cfg.enabled ? 'enabled' : 'disabled'}`);
    await ctx.editMessageText(
      `✅ Free Key ကို *${cfg.enabled ? 'ဖွင့်' : 'ပိတ်'}*လိုက်ပါပြီ။`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Config', 'oadm_free_config')]]) }
    );
  });

  bot.action('oadm_free_edit', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    setWizard(ctx, 'free_data_gb');
    await ctx.reply(
      '⚙️ *Free Config ပြင်ဆင်ရန် — အဆင့် 1/4*\n\n' +
      'Data ကန့်သတ်ချက် (GB) ရိုက်ပါ:\n_(ကန့်သတ်မချင်ရင် `0` ရိုက်ပါ)_\n\n/cancel — ပယ်ဖျက်ရန်',
      { parse_mode: 'Markdown' }
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  ALL KEYS
  // ════════════════════════════════════════════════════════════════════════════

  bot.action('oadm_all_keys', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const servers = await OutlineServer.find({ isActive: true }).sort({ createdAt: 1 });
    if (!servers.length) {
      return ctx.editMessageText('📭 Server မရှိသေးပါ။', adminMainKeyboard());
    }
    const buttons = servers.map((s) => [
      Markup.button.callback(`🖥️ ${s.name}`, `oadm_keys_srv:${s._id}`),
    ]);
    buttons.push([Markup.button.callback('🔙 နောက်သို့', 'oadm_menu')]);
    await ctx.editMessageText('📊 Server ကို ရွေးပါ:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^oadm_keys_srv:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const srvId = ctx.match[1];
    const [server, keys] = await Promise.all([
      OutlineServer.findById(srvId),
      OutlineKey.find({ serverId: srvId }).populate('planId').sort({ createdAt: -1 }).limit(30),
    ]);
    if (!server) return ctx.editMessageText('⚠️ Server မတွေ့ပါ။');

    if (!keys.length) {
      return ctx.editMessageText(
        `📊 *${esc(server.name)}* — Key မရှိသေးပါ။`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 နောက်သို့', 'oadm_all_keys')]]),
        }
      );
    }

    // Fetch live usage
    let usageMap = {};
    try {
      const { ok, usage } = await OutlineService.getUsage(server.apiUrl);
      if (ok) usageMap = usage;
    } catch {}

    const lines = keys.map((k, i) => {
      const status = k.isDisabled ? '🔴' : '🟢';
      const plan = k.isFree ? 'Free' : (k.planId?.name || '—');
      const used = usageMap[String(k.keyId)];
      const usedFmt = used != null ? OutlineService.formatBytes(used) : '—';
      const exp = k.expiresAt ? new Date(k.expiresAt).toLocaleDateString('en-GB') : '∞';
      return `${i + 1}. ${status} \`${k.telegramId}\` — ${esc(plan)}\n   Used: ${usedFmt}  |  Exp: ${exp}`;
    });

    // Telegram message length guard: split if too long
    const header = `📊 *${esc(server.name)}* — Keys (${keys.length})\n\n`;
    const body = lines.join('\n\n');
    const full = header + body;
    const chunks = full.length > 3800
      ? [full.slice(0, 3800) + '\n…(truncated)']
      : [full];

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const opts = {
        parse_mode: 'Markdown',
        ...(isLast
          ? Markup.inlineKeyboard([[Markup.button.callback('🔙 နောက်သို့', 'oadm_all_keys')]])
          : {}),
      };
      if (i === 0) {
        await ctx.editMessageText(chunks[i], opts);
      } else {
        await ctx.reply(chunks[i], opts);
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  TEXT WIZARD HANDLER  (must be before ambient.js)
  // ════════════════════════════════════════════════════════════════════════════

  bot.on('text', adminOnly(), async (ctx, next) => {
    const wizard = getWizard(ctx);
    if (!wizard) return next();

    const text = ctx.message.text.trim();

    // Cancel command
    if (text === '/cancel') {
      clearWizard(ctx);
      return ctx.reply('❌ ပယ်ဖျက်ပြီးပါပြီ။');
    }

    const { step, data } = wizard;

    // ── Server wizard ────────────────────────────────────────────────────
    if (step === 'srv_name') {
      setWizard(ctx, 'srv_api_url', { name: text });
      return ctx.reply(
        '🖥️ *Server ထည့်ရန် — အဆင့် 2/3*\n\nOutline API URL ရိုက်ထည့်ပါ:\n_(ဥပမာ: https://1.2.3.4:8080/xxxxxxxx)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'srv_api_url') {
      if (!text.startsWith('http')) {
        return ctx.reply('⚠️ URL မှားနေပါသည် — https:// ဖြင့် စတင်ရမည်');
      }
      setWizard(ctx, 'srv_cert', { ...data, apiUrl: text });
      return ctx.reply(
        '🖥️ *Server ထည့်ရန် — အဆင့် 3/3*\n\nCert SHA256 fingerprint ရိုက်ထည့်ပါ:\n_(ဥပမာ: abc123def456...)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'srv_cert') {
      const { name, apiUrl } = data;
      const certSha256 = text;

      await ctx.reply('⏳ Server ကို စစ်ဆေးနေသည်...');
      const { ok, error } = await OutlineService.testConnection(apiUrl);
      if (!ok) {
        clearWizard(ctx);
        return ctx.reply(
          `❌ Server ချိတ်ဆက်မအောင်မြင်ပါ:\n\`${error}\`\n\nပြန်ကြိုးစားရန် /oadm_srv_add`,
          { parse_mode: 'Markdown' }
        );
      }

      await OutlineServer.create({ name, apiUrl, certSha256 });
      auditLog(ctx, `Outline Server added: ${name}`);
      clearWizard(ctx);
      return ctx.reply(
        `✅ *${name}* ကို ထည့်ပြီးပါပြီ\\!`,
        { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('🖥️ Servers', 'oadm_servers')]]) }
      );
    }

    // ── Plan wizard ──────────────────────────────────────────────────────
    if (step === 'plan_name') {
      setWizard(ctx, 'plan_price', { name: text });
      return ctx.reply(
        '📋 *Plan ထည့်ရန် — အဆင့် 2/4*\n\nဈေးနှုန်း (KS) ရိုက်ပါ:\n_(ဥပမာ: 5000)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'plan_price') {
      const price = parseInt(text, 10);
      if (isNaN(price) || price < 0) {
        return ctx.reply('⚠️ မှန်ကန်သော ကိန်းဂဏာန်း ရိုက်ပါ (ဥပမာ: 5000)');
      }
      setWizard(ctx, 'plan_data_gb', { ...data, priceKs: price });
      return ctx.reply(
        '📋 *Plan ထည့်ရန် — အဆင့် 3/4*\n\nData ကန့်သတ်ချက် (GB) ရိုက်ပါ:\n_(ကန့်သတ်မချင်ရင် `0` ရိုက်ပါ)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'plan_data_gb') {
      const gb = parseFloat(text);
      if (isNaN(gb) || gb < 0) {
        return ctx.reply('⚠️ မှန်ကန်သော ကိန်းဂဏာန်း ရိုက်ပါ (ဥပမာ: 10 သို့မဟုတ် 0)');
      }
      setWizard(ctx, 'plan_days', { ...data, dataLimitGb: gb > 0 ? gb : null });
      return ctx.reply(
        '📋 *Plan ထည့်ရန် — အဆင့် 4/4*\n\nသက်တမ်း (ရက်) ရိုက်ပါ:\n_(သတ်မှတ်မချင်ရင် `0` ရိုက်ပါ)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'plan_days') {
      const days = parseInt(text, 10);
      if (isNaN(days) || days < 0) {
        return ctx.reply('⚠️ မှန်ကန်သော ကိန်းဂဏာန်း ရိုက်ပါ (ဥပမာ: 30 သို့မဟုတ် 0)');
      }
      const { name, priceKs, dataLimitGb } = data;
      await OutlinePlan.create({
        name,
        priceKs,
        dataLimitGb,
        durationDays: days > 0 ? days : null,
      });
      auditLog(ctx, `Outline Plan created: ${name} (${priceKs} KS)`);
      clearWizard(ctx);
      return ctx.reply(
        `✅ Plan *${name}* ထည့်ပြီးပါပြီ\\!\n\n• ဈေးနှုန်း: ${priceKs.toLocaleString()} KS\n• Data: ${fmtGb(dataLimitGb)}\n• သက်တမ်း: ${fmtDays(days > 0 ? days : null)}`,
        { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('📋 Plans', 'oadm_plans')]]) }
      );
    }

    // ── Free Config wizard ───────────────────────────────────────────────
    if (step === 'free_data_gb') {
      const gb = parseFloat(text);
      if (isNaN(gb) || gb < 0) {
        return ctx.reply('⚠️ မှန်ကန်သော ကိန်းဂဏာန်း ရိုက်ပါ');
      }
      setWizard(ctx, 'free_days', { dataLimitGb: gb > 0 ? gb : null });
      return ctx.reply(
        '⚙️ *Free Config — အဆင့် 2/4*\n\nသက်တမ်း (ရက်) ရိုက်ပါ:\n_(0 = သတ်မှတ်ချက်မရှိ)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'free_days') {
      const days = parseInt(text, 10);
      if (isNaN(days) || days < 0) {
        return ctx.reply('⚠️ မှန်ကန်သော ကိန်းဂဏာန်း ရိုက်ပါ');
      }
      setWizard(ctx, 'free_max_keys', { ...data, durationDays: days > 0 ? days : null });
      return ctx.reply(
        '⚙️ *Free Config — အဆင့် 3/4*\n\nUser တစ်ယောက် ကိုင်နိုင်သော Key အများဆုံး ရိုက်ပါ:\n_(ဥပမာ: 1)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'free_max_keys') {
      const max = parseInt(text, 10);
      if (isNaN(max) || max < 1) {
        return ctx.reply('⚠️ 1 နှင့် အထက် ရိုက်ပါ');
      }
      setWizard(ctx, 'free_cooldown', { ...data, maxKeysPerUser: max });
      return ctx.reply(
        '⚙️ *Free Config — အဆင့် 4/4*\n\nCooldown (နာရီ) ရိုက်ပါ:\n_(0 = cooldown မရှိ)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (step === 'free_cooldown') {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 0) {
        return ctx.reply('⚠️ 0 နှင့် အထက် ရိုက်ပါ');
      }
      const { dataLimitGb, durationDays, maxKeysPerUser } = data;
      const cfg = await OutlineFreeConfig.get();
      cfg.dataLimitGb = dataLimitGb;
      cfg.durationDays = durationDays;
      cfg.maxKeysPerUser = maxKeysPerUser;
      cfg.cooldownHours = hours;
      await cfg.save();
      auditLog(ctx, 'Outline Free Config updated');
      clearWizard(ctx);
      return ctx.reply(
        `✅ *Free Config ပြင်ဆင်ပြီးပါပြီ\\!*\n\n• Data: ${fmtGb(dataLimitGb)}\n• သက်တမ်း: ${fmtDays(durationDays)}\n• Max: ${maxKeysPerUser} keys\n• Cooldown: ${hours ? hours + ' နာရီ' : 'မရှိ'}`,
        { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ Free Config', 'oadm_free_config')]]) }
      );
    }

    // Not our wizard step
    return next();
  });
};
