/**
 * Channel Join Bonus — opt-in "join channel → get MC" offers (NOT force-join).
 * Bot must be admin in the channel so membership can be verified.
 */
const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { creditCoin } = require('../services/WalletService');
const { auditLog } = require('../services/logger');
const JoinReward = require('../models/JoinReward');
const JoinRewardClaim = require('../models/JoinRewardClaim');
const User = require('../models/User');
const SystemStatus = require('../models/SystemStatus');
const { config } = require('../../config/settings');

function esc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}
function linkOf(r) {
  if (r.channelLink) return r.channelLink;
  if (r.channelId.startsWith('@')) return `https://t.me/${r.channelId.slice(1)}`;
  return null;
}

// ── User view ────────────────────────────────────────────────────────────────

async function showJoinBonuses(ctx) {
  const rewards = await JoinReward.find({ isActive: true }).sort({ createdAt: -1 });
  if (!rewards.length) {
    return ctx.reply(`📣 *Channel Join Bonus*\n\n_လက်ရှိ join bonus မရှိသေးပါ။_`, { parse_mode: 'Markdown' });
  }
  const claims = await JoinRewardClaim.find({ telegramId: ctx.from.id });
  const claimedIds = new Set(claims.map((c) => c.rewardId.toString()));

  let text = `📣 *Channel Join Bonus*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\nChannel ဝင်ပြီး *Claim* နှိပ်ရင် MC ချက်ချင်း ရပါမယ်! (တစ်ခါပဲ ရပါတယ်)\n\n`;
  const rows = [];
  for (const r of rewards) {
    const done = claimedIds.has(r._id.toString());
    text += `${done ? '✅' : '🪙'} *${esc(r.title)}* — ${r.mcReward} MC${done ? ' (ရပြီး)' : ''}\n`;
    if (!done) {
      const url = linkOf(r);
      const row = [];
      if (url) row.push(Markup.button.url(`↗️ ${r.title} ဝင်မယ်`, url));
      row.push(Markup.button.callback(`✅ Claim ${r.mcReward} MC`, `jb_claim:${r._id}`));
      rows.push(row);
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

module.exports = function registerJoinReward(bot) {
  // ══ USER ═══════════════════════════════════════════════════════════════════
  bot.command('joinbonus', showJoinBonuses);
  bot.hears(['📣 Join Bonus', '📣 ချန်နယ်ဆု'], showJoinBonuses);

  bot.action(/^jb_claim:(.+)$/, async (ctx) => {
    const r = await JoinReward.findById(ctx.match[1]);
    if (!r || !r.isActive) return ctx.answerCbQuery('❌ ဒီ bonus မရှိတော့ပါ', { show_alert: true });

    const already = await JoinRewardClaim.findOne({ rewardId: r._id, telegramId: ctx.from.id });
    if (already) return ctx.answerCbQuery('✅ ရပြီးသားပါ', { show_alert: true });

    // Verify membership
    let member;
    try {
      member = await ctx.telegram.getChatMember(r.channelId, ctx.from.id);
    } catch (err) {
      console.error('[JoinBonus] getChatMember failed:', err.message);
      return ctx.answerCbQuery('⚠️ စစ်လို့မရပါ — bot က channel မှာ admin ဖြစ်ရပါမယ်။ Admin ကို အကြောင်းကြားပေးပါ။', { show_alert: true });
    }
    if (!['member', 'administrator', 'creator'].includes(member.status)) {
      return ctx.answerCbQuery('❌ Channel အရင်ဝင်ပြီးမှ Claim နှိပ်ပါ။', { show_alert: true });
    }

    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.answerCbQuery('❌ /start အရင်နှိပ်ပါ', { show_alert: true });

    // Record claim first (unique index blocks double-claim races)
    try {
      await JoinRewardClaim.create({ rewardId: r._id, telegramId: ctx.from.id, mcGiven: r.mcReward });
    } catch (err) {
      return ctx.answerCbQuery('✅ ရပြီးသားပါ', { show_alert: true });
    }
    await creditCoin(user._id, r.mcReward, { type: 'Bonus', note: `Join bonus: ${r.title}` });
    await JoinReward.updateOne({ _id: r._id }, { $inc: { claimCount: 1 } });
    await auditLog(ctx.from.id, 'JOIN_BONUS_CLAIMED', r._id.toString(), 'System', { mc: r.mcReward });

    await ctx.answerCbQuery(`🎉 ${r.mcReward} MC ရပါပြီ!`, { show_alert: true });
    try {
      await ctx.reply(`🎉 *${esc(r.title)}* ဝင်တဲ့အတွက် *${r.mcReward} MC* ရပါပြီ! 🪙\n\n💰 /wallet မှာ စစ်နိုင်ပါတယ်။`, { parse_mode: 'Markdown' });
    } catch {}
  });

  // ══ ADMIN (Owner) ══════════════════════════════════════════════════════════
  async function buildAdminPanel() {
    const rewards = await JoinReward.find().sort({ createdAt: -1 });
    let text = `📣 *Channel Join Bonus — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n`;
    text += rewards.length
      ? rewards.map((r) => `${r.isActive ? '🟢' : '🔴'} *${esc(r.title)}* — ${r.mcReward} MC  •  🙋 ${r.claimCount} ယောက်ယူပြီး\n   \`${esc(r.channelId)}\``).join('\n\n')
      : `_Join bonus မရှိသေးပါ။_`;
    text += `\n\n_⚠️ Bot ကို channel ထဲ admin အဖြစ် ထည့်ထားမှ member စစ်လို့ရပါမယ်။_`;
    const rows = rewards.map((r) => [
      Markup.button.callback(`${r.isActive ? '🟢' : '🔴'} ${r.title}`, `jba_toggle:${r._id}`),
      Markup.button.callback('📢', `jba_announce:${r._id}`),
      Markup.button.callback('🗑', `jba_del:${r._id}`),
    ]);
    rows.push([Markup.button.callback('➕ Add Channel Bonus', 'jba_add')]);
    rows.push([Markup.button.callback('🔄 Refresh', 'jba_panel')]);
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

  const adminPanel = async (ctx) => {
    const { text, keyboard } = await buildAdminPanel();
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  };
  bot.hears('📣 Join Bonus Admin', adminOnly(), adminPanel);
  bot.command('joinbonusadmin', adminOnly(), adminPanel);

  bot.action('jba_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action(/^jba_toggle:(.+)$/, adminOnly(), async (ctx) => {
    const r = await JoinReward.findById(ctx.match[1]);
    if (!r) return ctx.answerCbQuery('Not found', { show_alert: true });
    r.isActive = !r.isActive;
    await r.save();
    await ctx.answerCbQuery(r.isActive ? '🟢 ဖွင့်ပြီး' : '🔴 ပိတ်ပြီး');
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action(/^jba_del:(.+)$/, adminOnly(), async (ctx) => {
    const r = await JoinReward.findById(ctx.match[1]);
    if (!r) return ctx.answerCbQuery('Not found', { show_alert: true });
    await JoinReward.deleteOne({ _id: r._id });
    await auditLog(ctx.from.id, 'DELETE_JOIN_BONUS', ctx.match[1], 'System', { title: r.title });
    await ctx.answerCbQuery('🗑 ဖျက်ပြီး');
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  // 📢 Announce to all users + announcement channel (opt-in advert, not force-join)
  bot.action(/^jba_announce:(.+)$/, adminOnly(), async (ctx) => {
    const r = await JoinReward.findById(ctx.match[1]);
    if (!r || !r.isActive) return ctx.answerCbQuery('❌ ဖွင့်ထားမှ ကြေညာလို့ရပါမယ်', { show_alert: true });
    await ctx.answerCbQuery('📢 ကြေညာနေသည်...');
    const users = await User.find({ isBlocked: { $ne: true } }, 'telegramId').lean();
    const url = linkOf(r);

    // Post to announcement channel first (if configured)
    let channelOk = false;
    try {
      const st = await SystemStatus.get();
      if (st.announcementChannelId) {
        const botUsername = process.env.BOT_USERNAME || (await ctx.telegram.getMe()).username;
        await ctx.telegram.sendMessage(
          st.announcementChannelId,
          `📣 *Join Bonus ကြေညာချက်!*\n\n*${esc(r.title)}* channel ကို join ရင် *${r.mcReward} MC* အလကား ရပါမယ်! 🪙\n\n1️⃣ Channel ဝင်ပါ\n2️⃣ Bot ထဲက /joinbonus မှာ ✅ Claim နှိပ်ပါ`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              ...(url ? [[Markup.button.url('↗️ Channel ဝင်မယ်', url)]] : []),
              [Markup.button.url('🤖 Bot ထဲ Claim လုပ်ရန်', `https://t.me/${botUsername}`)],
            ]),
          }
        );
        channelOk = true;
      }
    } catch (e) {
      console.error('[JoinReward] Channel announce failed:', e.message);
    }

    let sent = 0, failed = 0;
    for (const u of users) {
      try {
        await ctx.telegram.sendMessage(
          u.telegramId,
          `📣 *ကြေညာချက်!*\n\n*${esc(r.title)}* channel ကို join ရင် *${r.mcReward} MC* အလကား ရပါမယ်! 🪙\n\n1️⃣ Channel ဝင်ပါ\n2️⃣ /joinbonus မှာ ✅ Claim နှိပ်ပါ\n\n_မဝင်ချင်လည်း ရပါတယ် — အတင်းအကျပ် မဟုတ်ပါ။_`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              ...(url ? [[Markup.button.url('↗️ Channel ဝင်မယ်', url)]] : []),
              [Markup.button.callback(`✅ Claim ${r.mcReward} MC`, `jb_claim:${r._id}`)],
            ]),
          }
        );
        sent++;
      } catch { failed++; }
      await new Promise((res) => setTimeout(res, 50)); // rate-limit safety
    }
    await auditLog(ctx.from.id, 'ANNOUNCE_JOIN_BONUS', r._id.toString(), 'System', { sent, failed, channelOk });
    await ctx.reply(
      `📢 ကြေညာပြီးပါပြီ!\n\n` +
        `📢 Channel: ${channelOk ? '✅ တင်ပြီး' : '⚠️ မတင်နိုင်ပါ (ကြေညာချက် channel မသတ်မှတ်ရသေး)'}\n` +
        `👥 Bot users: ✅ ${sent} ယောက် ရောက်ပြီး${failed ? ` / ❌ ${failed} ယောက် မရောက်` : ''}`
    );
  });

  bot.action('jba_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.jbAdmin = { step: 'channel' };
    await ctx.reply(
      `➕ *Join Bonus အသစ်*\n\nStep 1/3: *Channel* ရိုက်ပါ:\n_(ဥပမာ \`@mychannel\` သို့ \`-1001234567890\`)_\n\n⚠️ Bot ကို အဲ့ channel မှာ admin အရင် ထည့်ထားပါ။`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── Admin wizard text steps ─────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const st = ctx.session?.jbAdmin;
    if (!st || ctx.from.id !== config.bot.adminId) return next();
    const input = ctx.message.text.trim();

    if (st.step === 'channel') {
      if (!input.startsWith('@') && !/^-?\d+$/.test(input)) {
        return ctx.reply('❌ `@username` သို့ `-100...` ID ပုံစံ ရိုက်ပါ:', { parse_mode: 'Markdown', ...Markup.forceReply() });
      }
      // Verify bot can access the channel
      try {
        const chat = await ctx.telegram.getChat(input);
        st.channelId = input;
        st.chatTitle = chat.title || input;
        st.channelLink = chat.username ? `https://t.me/${chat.username}` : (chat.invite_link || '');
      } catch (err) {
        return ctx.reply(`❌ Channel ကို ရှာမတွေ့ပါ / bot ဝင်ခွင့်မရှိပါ။\n_Bot ကို channel မှာ admin ထည့်ပြီး ပြန်ရိုက်ပါ:_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
      }
      st.step = 'title';
      return ctx.reply(`Step 2/3: *ပြသမယ့် နာမည်* ရိုက်ပါ:\n_(ဥပမာ "MGS News Channel")_\nတွေ့ထားတဲ့ channel: ${st.chatTitle}`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'title') {
      st.title = input;
      st.step = 'mc';
      return ctx.reply(`Step 3/3: Join ရင် *MC ဘယ်လောက်* ပေးမလဲ? (ဥပမာ 50)`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (st.step === 'mc') {
      const n = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (!n || n < 1) return ctx.reply('❌ ကိန်းဂဏန်း ရိုက်ပါ (ဥပမာ 50):', Markup.forceReply());
      ctx.session.jbAdmin = null;
      const r = await JoinReward.create({
        channelId: st.channelId,
        channelLink: st.channelLink,
        title: st.title,
        mcReward: n,
        addedBy: ctx.from.id,
      });
      await auditLog(ctx.from.id, 'ADD_JOIN_BONUS', r._id.toString(), 'System', { title: r.title, mc: n });
      return ctx.reply(
        `✅ *ထည့်ပြီးပါပြီ!*\n\n📣 ${esc(r.title)} — join ရင် *${n} MC*\n\n_📢 button နဲ့ user အားလုံးဆီ ကြေညာနိုင်ပါတယ်။_`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📣 Panel', 'jba_panel')]]) }
      );
    }
    return next();
  });
};
