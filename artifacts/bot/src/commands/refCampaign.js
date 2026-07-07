/**
 * Referral Campaign — user progress view + owner admin panel.
 * "Invite N friends → get reward" with per-user & campaign-wide limits.
 */
const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { rewardText } = require('../services/RefCampaignService');
const RefCampaign = require('../models/RefCampaign');
const RefCampaignEntry = require('../models/RefCampaignEntry');
const { config } = require('../../config/settings');

function esc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}
function bar(cur, total, len = 10) {
  const filled = Math.min(len, Math.round((cur / total) * len));
  return '▰'.repeat(filled) + '▱'.repeat(len - filled);
}

// ── User view ────────────────────────────────────────────────────────────────

async function showUserCampaign(ctx) {
  const camp = await RefCampaign.getActive();
  if (!camp) {
    return ctx.reply(
      `🎯 *Referral Campaign*\n\n_လက်ရှိ campaign မရှိသေးပါ။ ကြေညာတဲ့အခါ ပြန်ကြည့်ပေးပါ။_\n\n👥 ပုံမှန် referral commission ကတော့ အမြဲရနေပါတယ် — /referral`,
      { parse_mode: 'Markdown' }
    );
  }
  const entry = await RefCampaignEntry.findOne({ campaignId: camp._id, telegramId: ctx.from.id });
  const counted = entry?.countedRefs || 0;
  const claimed = entry?.rewardsClaimed || 0;
  const totalRefs = entry?.totalRefs || 0;
  const quotaLeft = camp.totalRewardLimit > 0 ? camp.totalRewardLimit - camp.totalRewardsClaimed : null;

  let text =
    `🎯 *${esc(camp.title)}*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `🏆 ဆု: *${esc(rewardText(camp))}* (ref *${camp.requiredRefs} ယောက်* ပြည့်တိုင်း)\n\n` +
    `📊 သင့်တိုးတက်မှု: ${bar(counted, camp.requiredRefs)}  *${counted}/${camp.requiredRefs}*\n` +
    (claimed > 0 ? `🎁 ရပြီးသားဆု: *${claimed} ခု*\n` : '') +
    (camp.maxInvitesPerUser > 0 ? `👥 တစ်ယောက်လျှင် ref အများဆုံး: ${camp.maxInvitesPerUser} ယောက် (သုံးပြီး ${totalRefs})\n` : '') +
    (camp.maxRewardsPerUser > 0 ? `🎁 တစ်ယောက်လျှင် ဆု အများဆုံး: ${camp.maxRewardsPerUser} ခု\n` : '') +
    (quotaLeft !== null ? `⏳ ဆု လက်ကျန်: *${quotaLeft} ခု* (ကုန်ရင် campaign ပြီးမယ်)\n` : '') +
    `\n_မိတ်ဆွေက သင့် link နဲ့ဝင်ပြီး ပထမဆုံး ငွေဖြည့်ရင် 1 ref အဖြစ် တွက်ပါတယ်။_\n` +
    `🔗 သင့် link ကို /referral မှာ ယူပါ။`;

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('👥 My Referral Link', 'ref_refresh')]]),
  });
}

// ── Admin panel ──────────────────────────────────────────────────────────────

async function buildAdminPanel() {
  const camp = await RefCampaign.getActive();
  let text = `🎯 *Referral Campaign — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n`;
  const rows = [];
  if (camp) {
    const participants = await RefCampaignEntry.countDocuments({ campaignId: camp._id });
    text +=
      `🟢 *${esc(camp.title)}* (ဖွင့်ထား)\n\n` +
      `🏆 ဆု: ${esc(rewardText(camp))} / ref ${camp.requiredRefs} ယောက်\n` +
      `👥 Max ref per user: ${camp.maxInvitesPerUser || '∞'}\n` +
      `🎁 Max ဆု per user: ${camp.maxRewardsPerUser || '∞'}\n` +
      `📦 ဆုစုစုပေါင်း limit: ${camp.totalRewardLimit || '∞'} (ပေးပြီး ${camp.totalRewardsClaimed})\n` +
      `🙋 ပါဝင်သူ: ${participants} ယောက်\n\n` +
      `_Campaign ပိတ်ရင် မပြည့်သေးတဲ့ progress တွေ ပျက်မယ် — နောက် campaign မှာ အသစ်ပြန်စမယ်။_`;
    rows.push([Markup.button.callback('⏹ Campaign ပိတ်မယ်', 'rc_end')]);
    rows.push([Markup.button.callback('📊 Top ပါဝင်သူများ', 'rc_top')]);
  } else {
    const last = await RefCampaign.findOne({ isActive: false }).sort({ endedAt: -1 });
    text += `_လက်ရှိ ဖွင့်ထားတဲ့ campaign မရှိပါ။_\n`;
    if (last) text += `\nနောက်ဆုံး: "${esc(last.title)}" — ဆု ${last.totalRewardsClaimed} ခု ပေးခဲ့ (${last.endReason === 'quota_full' ? 'ဆုပြည့်လို့ပိတ်' : 'ကိုယ်တိုင်ပိတ်'})`;
    rows.push([Markup.button.callback('➕ Campaign အသစ် စမယ်', 'rc_new')]);
  }
  rows.push([Markup.button.callback('🔄 Refresh', 'rc_panel')]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

async function editOrReply(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (e) {
    if (String(e?.description || e?.message || '').includes('message is not modified')) return;
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

module.exports = function registerRefCampaign(bot) {
  // ══ USER ═══════════════════════════════════════════════════════════════════
  bot.command('campaign', showUserCampaign);
  bot.hears(['🎯 Campaign', '🎯 ကမ်ပိန်း'], showUserCampaign);
  bot.action('rc_user', async (ctx) => { await ctx.answerCbQuery(); return showUserCampaign(ctx); });

  // ══ ADMIN (Owner) ══════════════════════════════════════════════════════════
  const adminPanel = async (ctx) => {
    const { text, keyboard } = await buildAdminPanel();
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  };
  bot.hears('🎯 Ref Campaign', adminOnly(), adminPanel);
  bot.command('refcamp', adminOnly(), adminPanel);

  bot.action('rc_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action('rc_new', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const existing = await RefCampaign.getActive();
    if (existing) return ctx.reply('❌ Campaign တစ်ခု ဖွင့်ထားပြီးသားပါ။ အရင်ပိတ်ပြီးမှ အသစ်စပါ။');
    ctx.session.rcAdmin = { step: 'title' };
    await ctx.reply(
      `➕ *Campaign အသစ်*\n\nStep 1/8: *Campaign နာမည်* ရိုက်ပါ:\n_(ဥပမာ "မိတ်ဆွေ ၅ ယောက်ခေါ် VPN အလကားရ")_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.action('rc_end', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `⏹ Campaign ပိတ်မှာ သေချာလား?\n\n_မပြည့်သေးတဲ့ progress အားလုံး ပျက်သွားမယ်။ နောက် campaign စရင် အားလုံး 0 ကနေ ပြန်စမယ်။_`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ ပိတ်မယ်', 'rc_endyes')],
        [Markup.button.callback('❌ မပိတ်တော့ဘူး', 'rc_panel')],
      ])
    );
  });

  bot.action('rc_endyes', adminOnly(), async (ctx) => {
    const camp = await RefCampaign.getActive();
    if (!camp) return ctx.answerCbQuery('မရှိပါ', { show_alert: true });
    camp.isActive = false;
    camp.endedAt = new Date();
    camp.endReason = 'manual';
    await camp.save();
    await auditLog(ctx.from.id, 'END_REF_CAMPAIGN', camp._id.toString(), 'System', { title: camp.title });
    await ctx.answerCbQuery('⏹ ပိတ်ပြီးပါပြီ');
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action('rc_top', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const camp = await RefCampaign.getActive();
    if (!camp) return ctx.reply('❌ ဖွင့်ထားတဲ့ campaign မရှိပါ။');
    const top = await RefCampaignEntry.find({ campaignId: camp._id }).sort({ totalRefs: -1 }).limit(10);
    if (!top.length) return ctx.reply('🙋 ဘယ်သူမှ မပါဝင်သေးပါ။');
    const lines = top.map((e, i) => `${i + 1}. ID:${e.telegramId} — refs ${e.totalRefs}, ဆု ${e.rewardsClaimed} ခု`);
    await ctx.reply(`📊 *Top ပါဝင်သူများ — ${esc(camp.title)}*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  // ── Admin wizard text steps ─────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const st = ctx.session?.rcAdmin;
    if (!st || ctx.from.id !== config.bot.adminId) return next();
    const input = ctx.message.text.trim();

    if (st.step === 'title') {
      st.title = input;
      st.step = 'refs';
      return ctx.reply(`Step 2/8: ဆုတစ်ခုရဖို့ *ref ဘယ်နှစ်ယောက်* လိုမလဲ? (ဥပမာ 5)`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'refs') {
      const n = parseInt(input, 10);
      if (!n || n < 1) return ctx.reply('❌ ကိန်းဂဏန်း ရိုက်ပါ (ဥပမာ 5):', Markup.forceReply());
      st.requiredRefs = n;
      st.step = 'rtype';
      return ctx.reply(
        `Step 3/8: *ဆု အမျိုးအစား* ရွေးပါ:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🪙 MC (Mental Coins)', 'rcw_type:mc')],
          [Markup.button.callback('💵 KS (Wallet ငွေ)', 'rcw_type:ks')],
          [Markup.button.callback('📦 Product (ကိုယ်တိုင်ပို့)', 'rcw_type:product')],
        ])
      );
    }
    if (st.step === 'ramount') {
      const n = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (!n || n < 1) return ctx.reply('❌ ကိန်းဂဏန်း ရိုက်ပါ:', Markup.forceReply());
      st.rewardAmount = n;
      st.step = 'maxinv';
      return ctx.reply(`Step 5/8: တစ်ယောက်လျှင် *ref အများဆုံး ဘယ်နှစ်ယောက်* ထိ တွက်ပေးမလဲ?\n_(0 = ကန့်သတ်မထား)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'rlabel') {
      st.rewardLabel = input;
      st.step = 'maxinv';
      return ctx.reply(`Step 5/8: တစ်ယောက်လျှင် *ref အများဆုံး ဘယ်နှစ်ယောက်* ထိ တွက်ပေးမလဲ?\n_(0 = ကန့်သတ်မထား)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'maxinv') {
      const n = parseInt(input, 10);
      if (isNaN(n) || n < 0) return ctx.reply('❌ 0 သို့ ကိန်းဂဏန်း ရိုက်ပါ:', Markup.forceReply());
      st.maxInvitesPerUser = n;
      st.step = 'maxrew';
      return ctx.reply(`Step 6/8: တစ်ယောက်လျှင် *ဆု အများဆုံး ဘယ်နှစ်ခု* လဲရမလဲ?\n_(0 = ကန့်သတ်မထား၊ များသောအားဖြင့် 1)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'maxrew') {
      const n = parseInt(input, 10);
      if (isNaN(n) || n < 0) return ctx.reply('❌ 0 သို့ ကိန်းဂဏန်း ရိုက်ပါ:', Markup.forceReply());
      st.maxRewardsPerUser = n;
      st.step = 'quota';
      return ctx.reply(`Step 7/8: Campaign တစ်ခုလုံးမှာ *ဆု စုစုပေါင်း ဘယ်နှစ်ခု* ပေးမလဲ?\n_(ပြည့်တာနဲ့ campaign အလိုအလျောက် ပိတ်မယ်။ 0 = ကန့်သတ်မထား)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'quota') {
      const n = parseInt(input, 10);
      if (isNaN(n) || n < 0) return ctx.reply('❌ 0 သို့ ကိန်းဂဏန်း ရိုက်ပါ:', Markup.forceReply());
      ctx.session.rcAdmin = null;
      const camp = await RefCampaign.create({
        title: st.title,
        requiredRefs: st.requiredRefs,
        rewardType: st.rewardType,
        rewardAmount: st.rewardAmount || 0,
        rewardLabel: st.rewardLabel || '',
        maxInvitesPerUser: st.maxInvitesPerUser,
        maxRewardsPerUser: st.maxRewardsPerUser,
        totalRewardLimit: n,
      });
      await auditLog(ctx.from.id, 'CREATE_REF_CAMPAIGN', camp._id.toString(), 'System', { title: camp.title });
      return ctx.reply(
        `✅ *Campaign စတင်ပြီးပါပြီ!*\n\n🎯 ${esc(camp.title)}\n🏆 ${esc(rewardText(camp))} / ref ${camp.requiredRefs} ယောက်\n👥 Max ref/user: ${camp.maxInvitesPerUser || '∞'}  •  🎁 Max ဆု/user: ${camp.maxRewardsPerUser || '∞'}\n📦 ဆုစုစုပေါင်း: ${camp.totalRewardLimit || '∞'}\n\n_ဝယ်သူတွေကို /launchbroadcast နဲ့ ကြေညာပေးပါ — သူတို့က /campaign နဲ့ progress ကြည့်နိုင်ပါတယ်။_`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🎯 Panel', 'rc_panel')]]) }
      );
    }
    return next();
  });

  // Reward type selector (wizard step 3→4)
  bot.action(/^rcw_type:(mc|ks|product)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const st = ctx.session?.rcAdmin;
    if (!st || st.step !== 'rtype') return;
    st.rewardType = ctx.match[1];
    if (st.rewardType === 'product') {
      st.step = 'rlabel';
      return ctx.reply(`Step 4/8: *ဆု product နာမည်* ရိုက်ပါ:\n_(ဥပမာ "ExpressVPN 1 Month" — ဆုရသူကို admin က ကိုယ်တိုင် ပို့ရပါမယ်)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    st.step = 'ramount';
    return ctx.reply(`Step 4/8: *ဆု ပမာဏ* ရိုက်ပါ (${st.rewardType === 'mc' ? 'MC' : 'KS'}):`, { parse_mode: 'Markdown', ...Markup.forceReply() });
  });
};
