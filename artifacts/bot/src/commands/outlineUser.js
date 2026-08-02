/**
 * outlineUser.js — Outline VPN user-facing commands.
 *
 * User မီနူး:
 *   🌐 Outline VPN  →  inline keyboard
 *     🔑 ကျွန်ုပ်၏ Key     — active keys list + access URLs
 *     🆓 Free Key ရယူရန်  — eligibility check → create
 *     💰 Key ဝယ်ရန်       — plan list → confirm → debit KS → create
 */

const { Markup } = require('telegraf');
const { debitKS } = require('../services/WalletService');
const OutlineServer = require('../models/OutlineServer');
const OutlineKey = require('../models/OutlineKey');
const OutlinePlan = require('../models/OutlinePlan');
const OutlineFreeConfig = require('../models/OutlineFreeConfig');
const OutlineService = require('../services/OutlineService');
const User = require('../models/User');

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[_*`[\]()~>#+=|{}.!-]/g, '\\$1');
}

function ks(n) {
  return `${Number(n || 0).toLocaleString()} KS`;
}

function fmtDate(d) {
  if (!d) return 'သတ်မှတ်ချက် မရှိ';
  return new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Rangoon' });
}

function fmtGb(gb) {
  if (gb == null) return 'ကန့်သတ်မထားပါ';
  return `${gb} GB`;
}

// Pick the first active server for key creation
async function pickServer() {
  const servers = await OutlineServer.getActive();
  if (!servers.length) return null;
  return servers[0];
}

// Build a descriptive key info block
function keyInfoText(k) {
  const plan = k.planId?.name || (k.isFree ? 'Free' : '—');
  const limit = fmtGb(k.dataLimitGb);
  const exp = fmtDate(k.expiresAt);
  const status = k.isDisabled ? '🔴 ပိတ်ထားသည်' : '🟢 အသုံးပြုနိုင်သည်';
  return (
    `🔑 *${esc(k.name || k.keyId)}*\n` +
    `   Plan: ${esc(plan)}\n` +
    `   Data: ${limit}\n` +
    `   သက်တမ်း: ${exp}\n` +
    `   အခြေအနေ: ${status}\n` +
    `\`\`\`\n${k.accessUrl || '(URL မရရှိပါ)'}\n\`\`\``
  );
}

// ── Main user menu ────────────────────────────────────────────────────────────

function userMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔑 ကျွန်ုပ်၏ Key', 'ol_my_keys')],
    [Markup.button.callback('🆓 Free Key ရယူရန်', 'ol_free_key')],
    [Markup.button.callback('💰 Key ဝယ်ရန်', 'ol_buy_key')],
  ]);
}

// ── Register ─────────────────────────────────────────────────────────────────

module.exports = function register(bot) {
  // ── Entry point ──────────────────────────────────────────────────────────
  bot.hears('🌐 Outline VPN', async (ctx) => {
    await ctx.reply(
      '🌐 *Outline VPN*\n\nဘာလုပ်လိုပါသလဲ?',
      { parse_mode: 'Markdown', ...userMenuKeyboard() }
    );
  });

  // ── My Keys ─────────────────────────────────────────────────────────────
  bot.action('ol_my_keys', async (ctx) => {
    await ctx.answerCbQuery();
    const tgId = ctx.from.id;
    const keys = await OutlineKey.findActiveByUser(tgId);

    if (!keys.length) {
      return ctx.editMessageText(
        '📭 သင်တွင် ရရှိထားသော Outline Key မရှိသေးပါ\\.\\n\\nFree Key ရယူ သို့မဟုတ် Key ဝယ်ပါ။',
        { parse_mode: 'MarkdownV2', ...userMenuKeyboard() }
      );
    }

    // Show each key's info
    for (const k of keys) {
      try {
        // Refresh access URL from server
        const server = k.serverId;
        if (server?.apiUrl) {
          const { keys: liveKeys } = await OutlineService.listKeys(server.apiUrl);
          const live = liveKeys.find((lk) => String(lk.id) === String(k.keyId));
          if (live?.accessUrl) {
            k.accessUrl = live.accessUrl;
            await OutlineKey.findByIdAndUpdate(k._id, { accessUrl: live.accessUrl });
          }
        }
      } catch {}

      await ctx.reply(keyInfoText(k), {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', `ol_refresh_key:${k._id}`)],
        ]).reply_markup,
      });
    }

    await ctx.reply('🌐 *Outline VPN မီနူး*', {
      parse_mode: 'Markdown',
      ...userMenuKeyboard(),
    });
  });

  // ── Refresh single key ───────────────────────────────────────────────────
  bot.action(/^ol_refresh_key:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('🔄 ပြန်စစ်နေသည်...');
    const keyDocId = ctx.match[1];
    try {
      const k = await OutlineKey.findById(keyDocId).populate('serverId').populate('planId');
      if (!k || k.telegramId !== ctx.from.id) {
        return ctx.reply('⚠️ Key ကို မတွေ့ပါ။');
      }
      const server = k.serverId;
      if (server?.apiUrl) {
        const { keys: liveKeys } = await OutlineService.listKeys(server.apiUrl);
        const live = liveKeys.find((lk) => String(lk.id) === String(k.keyId));
        if (live?.accessUrl) {
          k.accessUrl = live.accessUrl;
          await OutlineKey.findByIdAndUpdate(k._id, { accessUrl: live.accessUrl });
        }
      }
      await ctx.editMessageText(keyInfoText(k), {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', `ol_refresh_key:${k._id}`)],
        ]).reply_markup,
      });
    } catch (err) {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  // ── Free Key ─────────────────────────────────────────────────────────────
  bot.action('ol_free_key', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const cfg = await OutlineFreeConfig.get();

      if (!cfg.enabled) {
        return ctx.editMessageText(
          '🚫 Free Key ဝန်ဆောင်မှု ယာယီရပ်နားထားပါသည်။',
          { ...userMenuKeyboard() }
        );
      }

      const tgId = ctx.from.id;
      const activeCount = await OutlineKey.countActiveFreeByUser(tgId);
      if (activeCount >= cfg.maxKeysPerUser) {
        return ctx.editMessageText(
          `⚠️ Free Key ${cfg.maxKeysPerUser} ခု အမြင့်ဆုံး ကိုင်ထားနိုင်ပါသည်\\.\\n` +
          `သင်တွင် ယခု ${activeCount} ခု ရှိပြီးပါပြီ။`,
          { parse_mode: 'MarkdownV2', ...userMenuKeyboard() }
        );
      }

      const server = await pickServer();
      if (!server) {
        return ctx.editMessageText(
          '🚫 ယခုအခိုက် ရရှိနိုင်သော Server မရှိပါ။ နောက်မှ ပြန်လာပါ။',
          { ...userMenuKeyboard() }
        );
      }

      const text =
        `🆓 *Free Key အသေးစိတ်*\n\n` +
        `• Data: ${fmtGb(cfg.dataLimitGb)}\n` +
        `• သက်တမ်း: ${cfg.durationDays ? cfg.durationDays + ' ရက်' : 'သတ်မှတ်ချက် မရှိ'}\n\n` +
        `Free Key ရယူမည်လား?`;

      return ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ ရယူမည်', 'ol_free_confirm')],
          [Markup.button.callback('🔙 နောက်သို့', 'ol_back_menu')],
        ]),
      });
    } catch (err) {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  // ── Free Key Confirm ─────────────────────────────────────────────────────
  bot.action('ol_free_confirm', async (ctx) => {
    await ctx.answerCbQuery('⏳ Key ဖန်တီးနေသည်...');
    try {
      const cfg = await OutlineFreeConfig.get();
      if (!cfg.enabled) {
        return ctx.editMessageText('🚫 Free Key ဝန်ဆောင်မှု ရပ်နားထားပါသည်။', userMenuKeyboard());
      }

      const tgId = ctx.from.id;
      const activeCount = await OutlineKey.countActiveFreeByUser(tgId);
      if (activeCount >= cfg.maxKeysPerUser) {
        return ctx.editMessageText(
          `⚠️ Free Key ကန့်သတ်ချက် ပြည့်သွားပါပြီ (${activeCount}/${cfg.maxKeysPerUser})`,
          userMenuKeyboard()
        );
      }

      const server = await pickServer();
      if (!server) {
        return ctx.editMessageText('🚫 Server မရှိပါ။', userMenuKeyboard());
      }

      const user = await User.findOne({ telegramId: tgId });
      const keyName = `Free-${ctx.from.first_name || tgId}`;
      const { ok, key, error } = await OutlineService.createKey(
        server.apiUrl,
        keyName,
        cfg.dataLimitGb
      );

      if (!ok || !key) {
        return ctx.editMessageText(`❌ Key ဖန်တီး မအောင်မြင်ပါ: ${error}`, userMenuKeyboard());
      }

      const expiresAt = cfg.durationDays
        ? new Date(Date.now() + cfg.durationDays * 86400000)
        : null;

      const keyDoc = await OutlineKey.create({
        serverId: server._id,
        keyId: String(key.id),
        name: keyName,
        telegramId: tgId,
        userId: user?._id || null,
        isFree: true,
        dataLimitGb: cfg.dataLimitGb,
        expiresAt,
        accessUrl: key.accessUrl || '',
      });

      await ctx.editMessageText(
        `✅ *Free Key ရရှိပြီပါပြီ\\!*\n\n` +
        `• Data: ${fmtGb(cfg.dataLimitGb)}\n` +
        `• သက်တမ်း: ${fmtDate(expiresAt)}\n\n` +
        `*Access URL \\(Outline app ထဲ ကူးထည့်ပါ\\):*\n\`${key.accessUrl || ''}\``,
        { parse_mode: 'MarkdownV2', ...userMenuKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  // ── Buy Key — Plan List ───────────────────────────────────────────────────
  bot.action('ol_buy_key', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const plans = await OutlinePlan.getActive();
      if (!plans.length) {
        return ctx.editMessageText(
          '📭 ယခုအခိုက် ဝယ်ယူနိုင်သော Plan မရှိသေးပါ။',
          { ...userMenuKeyboard() }
        );
      }

      const buttons = plans.map((p) => {
        const data = p.dataLimitGb ? `${p.dataLimitGb}GB` : '∞';
        const dur = p.durationDays ? `${p.durationDays}ရက်` : '∞';
        return [
          Markup.button.callback(
            `${p.name} — ${ks(p.priceKs)} (${data} / ${dur})`,
            `ol_plan:${p._id}`
          ),
        ];
      });
      buttons.push([Markup.button.callback('🔙 နောက်သို့', 'ol_back_menu')]);

      return ctx.editMessageText('💰 *Plan ရွေးချယ်ပါ:*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (err) {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  // ── Buy Key — Plan Detail / Confirm ──────────────────────────────────────
  bot.action(/^ol_plan:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const planId = ctx.match[1];
    try {
      const plan = await OutlinePlan.findById(planId);
      if (!plan || !plan.isActive) {
        return ctx.editMessageText('⚠️ Plan ကို မတွေ့ပါ သို့မဟုတ် ရပ်နားထားပါသည်။', userMenuKeyboard());
      }

      const user = await User.findOne({ telegramId: ctx.from.id });
      const balance = user?.balanceKS || 0;
      const canAfford = balance >= plan.priceKs;

      const text =
        `💰 *${esc(plan.name)}*\n\n` +
        `• ဈေးနှုန်း: ${ks(plan.priceKs)}\n` +
        `• Data: ${fmtGb(plan.dataLimitGb)}\n` +
        `• သက်တမ်း: ${plan.durationDays ? plan.durationDays + ' ရက်' : 'သတ်မှတ်ချက် မရှိ'}\n\n` +
        `သင်၏ KS Balance: ${ks(balance)}\n` +
        (canAfford ? '✅ Balance လုံလောက်ပါသည်' : '❌ Balance မလုံလောက်ပါ — ငွေဖြည့်ပါ');

      return ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...(canAfford
            ? [[Markup.button.callback('✅ ဝယ်ယူမည်', `ol_buy_confirm:${plan._id}`)]]
            : [[Markup.button.callback('💳 ငွေဖြည့်ရန်', 'start_topup')]]),
          [Markup.button.callback('🔙 Plan များ', 'ol_buy_key')],
        ]),
      });
    } catch (err) {
      await ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  // ── Buy Key — Execute Purchase ────────────────────────────────────────────
  bot.action(/^ol_buy_confirm:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('⏳ ဝယ်ယူနေသည်...');
    const planId = ctx.match[1];
    try {
      const plan = await OutlinePlan.findById(planId);
      if (!plan || !plan.isActive) {
        return ctx.editMessageText('⚠️ Plan ကို မတွေ့ပါ။', userMenuKeyboard());
      }

      const server = await pickServer();
      if (!server) {
        return ctx.editMessageText('🚫 Server မရှိပါ။', userMenuKeyboard());
      }

      const tgId = ctx.from.id;
      const user = await User.findOne({ telegramId: tgId });
      if (!user) return ctx.editMessageText('⚠️ User မတွေ့ပါ။', userMenuKeyboard());

      // Debit wallet first
      await debitKS(user._id, plan.priceKs, {
        type: 'Purchase',
        note: `Outline VPN Key — ${plan.name}`,
      });

      // Create key on server
      const keyName = `${ctx.from.first_name || tgId}-${plan.name}`;
      const { ok, key, error } = await OutlineService.createKey(
        server.apiUrl,
        keyName,
        plan.dataLimitGb
      );

      if (!ok || !key) {
        // Refund on failure
        const { creditKS } = require('../services/WalletService');
        await creditKS(user._id, plan.priceKs, {
          type: 'Refund',
          note: `Outline Key ဖန်တီး မအောင်မြင်သဖြင့် ပြန်အမ်း: ${error}`,
        });
        return ctx.editMessageText(
          `❌ Key ဖန်တီး မအောင်မြင်ပါ — ${plan.priceKs.toLocaleString()} KS ပြန်အမ်းပြီးပါပြီ`,
          userMenuKeyboard()
        );
      }

      const expiresAt = plan.durationDays
        ? new Date(Date.now() + plan.durationDays * 86400000)
        : null;

      await OutlineKey.create({
        serverId: server._id,
        keyId: String(key.id),
        name: keyName,
        telegramId: tgId,
        userId: user._id,
        planId: plan._id,
        isFree: false,
        dataLimitGb: plan.dataLimitGb,
        expiresAt,
        accessUrl: key.accessUrl || '',
      });

      await ctx.editMessageText(
        `✅ *Key ဝယ်ယူမှု အောင်မြင်ပါသည်\\!*\n\n` +
        `• Plan: ${esc(plan.name)}\n` +
        `• Data: ${fmtGb(plan.dataLimitGb)}\n` +
        `• သက်တမ်း: ${fmtDate(expiresAt)}\n` +
        `• ကျသင့်ငွေ: ${ks(plan.priceKs)}\n\n` +
        `*Access URL \\(Outline app ထဲ ကူးထည့်ပါ\\):*\n\`${key.accessUrl || ''}\``,
        { parse_mode: 'MarkdownV2', ...userMenuKeyboard() }
      );
    } catch (err) {
      if (err.message?.includes('Insufficient')) {
        return ctx.editMessageText(
          `❌ KS Balance မလုံလောက်ပါ\\. ငွေဖြည့်ပြီး ပြန်လာပါ။`,
          { parse_mode: 'MarkdownV2', ...userMenuKeyboard() }
        );
      }
      await ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  // ── Back to menu ─────────────────────────────────────────────────────────
  bot.action('ol_back_menu', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.editMessageText('🌐 *Outline VPN*\n\nဘာလုပ်လိုပါသလဲ?', {
      parse_mode: 'Markdown',
      ...userMenuKeyboard(),
    });
  });
};
