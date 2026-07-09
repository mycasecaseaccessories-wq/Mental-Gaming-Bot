/**
 * Channel Manager (Owner) — /channels
 * Standalone panel to manage the bot's channel registry, independent of coupons.
 *  - Lists ALL channels the bot knows (saved + auto-post + join bonus + announcement)
 *  - ➕ Add a channel directly (getChat-validated, saved to registry)
 *  - 🗑 Remove saved channels (channels from other features are managed in their own panels)
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { config } = require('../../config/settings');
const {
  getKnownChannels,
  saveChannel,
  removeChannel,
  SOURCE_LABELS,
} = require('../services/ChannelRegistryService');

function escMd(s) {
  return String(s ?? '').replace(/([_*`\[\]])/g, '\\$1');
}

module.exports = (bot) => {
  async function showPanel(ctx) {
    const channels = await getKnownChannels();
    const savedCount = channels.filter((c) => c.sources.includes('saved')).length;

    let body = `📡 *Channel စာရင်း*\n\n`;
    if (!channels.length) {
      body += `Channel မရှိသေးပါဘူး — *➕ Channel ထည့်မယ်* ကို နှိပ်ပြီး ထည့်နိုင်ပါတယ်။`;
    } else {
      body += channels
        .map((c, i) => {
          const tags = c.sources.map((s) => SOURCE_LABELS[s] || s).join(', ');
          return `${i + 1}. *${escMd(c.title)}*\n   \`${escMd(c.chatId)}\` — ${tags}`;
        })
        .join('\n');
      body += `\n\n_ဒီစာရင်းက coupon ကြေညာတဲ့အခါ ခလုတ်တွေအဖြစ် အလိုအလျောက် ပေါ်ပါမယ်။_`;
    }

    const rows = [[Markup.button.callback('➕ Channel ထည့်မယ်', 'chmgr_add')]];
    if (savedCount) rows.push([Markup.button.callback('🗑 သိမ်းထားတဲ့ channel ဖျက်မယ်', 'chmgr_delmenu')]);
    rows.push([Markup.button.callback('🔄 Refresh', 'chmgr_refresh')]);

    await ctx.reply(body, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  bot.command('channels', adminOnly(), (ctx) => showPanel(ctx));
  bot.hears('📡 Channels', adminOnly(), (ctx) => showPanel(ctx));

  bot.action('chmgr_refresh', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await showPanel(ctx);
  });

  bot.action('chmgr_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    // Ensure no other text wizard swallows the input
    ctx.session.awaitingPromoCode = false;
    ctx.session.adminCreatePromo = null;
    ctx.session.adminGenCoupon = null;
    ctx.session.adminCouponAnnounce = null;
    ctx.session.cap = null;
    ctx.session.jbAdmin = null;
    ctx.session.adminChannelMgr = { step: 'awaiting_channel' };
    await ctx.reply(
      `➕ *Channel ထည့်မယ်*\n\n` +
        `Channel ရဲ့ \`@username\` (သို့) channel ID (ဥပမာ \`-1001234567890\`) ကို ရိုက်ပါ:\n` +
        `_(Bot ကို အဲဒီ channel မှာ admin အရင်ထည့်ထားရပါမယ်။ မလုပ်တော့ရင် \`cancel\` ရိုက်ပါ)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // Purpose picker — decide what the freshly validated channel is for
  bot.action(/^chmgr_purpose:(autopost|joinbonus|announce|backup|review|game|faq|saved|cancel)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const purpose = ctx.match[1];
    const state = ctx.session?.adminChannelMgr;
    ctx.session.adminChannelMgr = null;

    if (purpose === 'cancel') return ctx.reply('👌 ပယ်ဖျက်လိုက်ပါပြီ။');

    const chat = state?.chat;
    if (!state || state.step !== 'purpose' || !chat) {
      return ctx.reply('❌ Session ကုန်သွားပါပြီ — ➕ Channel ထည့်မယ် ကို ပြန်နှိပ်ပြီး ထပ်စမ်းပါ။');
    }

    const SystemStatus = require('../models/SystemStatus');

    if (purpose === 'saved') {
      const saved = await saveChannel({ id: chat.id, title: chat.title }, ctx.from.id);
      await ctx.reply(
        `✅ *${escMd(saved.title)}* ကို channel စာရင်းထဲ သိမ်းလိုက်ပါပြီ! 💾\n\n` +
          `Coupon ကြေညာတဲ့အခါ ဒီ channel က ခလုတ်နဲ့ အလိုအလျောက် ပေါ်လာပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'announce') {
      const st = await SystemStatus.get();
      await SystemStatus.updateOne(
        { _id: st._id },
        { $set: { announcementChannelId: chat.id, updatedBy: ctx.from.id } }
      );
      await ctx.reply(
        `✅ *${escMd(chat.title)}* ကို 📢 *ကြေညာချက် channel* အဖြစ် သတ်မှတ်လိုက်ပါပြီ!\n\n` +
          `Product/flash sale ကြေညာချက်တွေ ဒီ channel ကို ပို့ပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'backup') {
      const st = await SystemStatus.get();
      await SystemStatus.updateOne(
        { _id: st._id },
        { $set: { backupChannelId: chat.id, updatedBy: ctx.from.id } }
      );
      await ctx.reply(
        `✅ *${escMd(chat.title)}* ကို 🔐 *Backup channel* အဖြစ် သတ်မှတ်လိုက်ပါပြီ!\n\n` +
          `နေ့စဉ် encrypt လုပ်ထားတဲ့ database backup ဖိုင်တွေ ဒီ channel ကို ပို့ပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'review') {
      const st = await SystemStatus.get();
      await SystemStatus.updateOne(
        { _id: st._id },
        { $set: { feedbackChannelId: chat.id, updatedBy: ctx.from.id } }
      );
      await ctx.reply(
        `✅ *${escMd(chat.title)}* ကို ⭐ *Review channel* အဖြစ် သတ်မှတ်လိုက်ပါပြီ!\n\n` +
          `Customer တွေရဲ့ ⭐4–5 review (comment ပါတဲ့) တွေကို ဒီ channel ကို အလိုအလျောက် တင်ပေးပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'game') {
      const st = await SystemStatus.get();
      await SystemStatus.updateOne(
        { _id: st._id },
        { $set: { gameNewsChannelId: chat.id, updatedBy: ctx.from.id } }
      );
      await ctx.reply(
        `✅ *${escMd(chat.title)}* ကို 🎮 *Game Update channel* အဖြစ် သတ်မှတ်လိုက်ပါပြီ!\n\n` +
          `ဒီ channel မှာ တင်တဲ့ post တိုင်းကို bot က မှတ်ထားပြီး — customer support မှာ game နဲ့ပတ်သက်တာ လာမေးရင် *ဒီထဲက အချက်အလက်တွေကို အရင်ရှာပြီး* ဖြေပေးပါမယ်။\n\n` +
          `📌 Update အသစ်တွေကို channel ထဲ တင်ရုံပါပဲ — bot က အလိုအလျောက် သိမ်းပါမယ်။ \`/gamenews\` နဲ့ သိမ်းထားတာတွေ စစ်လို့ရပါတယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'faq') {
      const st = await SystemStatus.get();
      await SystemStatus.updateOne(
        { _id: st._id },
        { $set: { faqChannelId: chat.id, updatedBy: ctx.from.id } }
      );
      await ctx.reply(
        `✅ *${escMd(chat.title)}* ကို 📖 *FAQ channel* အဖြစ် သတ်မှတ်လိုက်ပါပြီ!\n\n` +
          `ဒီ channel မှာ တင်တဲ့ FAQ post တိုင်းကို bot က မှတ်ထားပြီး — customer က မေးခွန်းမေးလာရင် ကိုက်ညီတဲ့ post ကို *channel နာမည်ပေါ်အောင် တိုက်ရိုက် forward* လုပ်ပြီး ဖြေပေးပါမယ်။\n\n` +
          `📌 FAQ post တွေက သက်တမ်းမကုန်ပါဘူး (game update လို ၃ လအကန့်အသတ် မရှိပါ)။ ပုံပါ post ဆိုရင် caption မှာ စာရေးပေးပါ။ \`/gamenews\` နဲ့ သိမ်းထားတာတွေ စစ်လို့ရပါတယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'autopost') {
      // Hand off to the existing /addchannelpost wizard with channel prefilled (label step next)
      ctx.session.cap = { step: 'label', channelId: chat.id };
      return ctx.reply(
        `📅 *Auto-post အတွက် သတ်မှတ်မယ်*\n\n` +
          `✅ Channel: *${escMd(chat.title)}*\n\n` +
          `Step 2/5: Admin စာရင်းမှာ ပြမယ့် *နာမည်တို* ရိုက်ပါ (မထည့်ချင်ရင် \`skip\`):`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    }

    if (purpose === 'joinbonus') {
      // Hand off to the existing Join Bonus wizard with channel prefilled (title step next)
      ctx.session.jbAdmin = {
        step: 'title',
        channelId: chat.id,
        chatTitle: chat.title,
        channelLink: chat.username ? `https://t.me/${chat.username}` : (chat.invite_link || ''),
      };
      return ctx.reply(
        `📣 *Join Bonus အတွက် သတ်မှတ်မယ်*\n\n` +
          `✅ Channel: *${escMd(chat.title)}*\n\n` +
          `Step 2/3: *ပြသမယ့် နာမည်* ရိုက်ပါ:\n_(ဥပမာ "MGS News Channel")_`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    }
  });

  bot.action('chmgr_delmenu', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const channels = await getKnownChannels();
    const saved = channels.filter((c) => c.sources.includes('saved'));
    if (!saved.length) return ctx.reply('သိမ်းထားတဲ့ channel မရှိပါ။');
    await ctx.reply(
      `🗑 *ဘယ် channel ကို စာရင်းက ဖျက်မလဲ?*\n_(channel ထဲက ပို့ပြီးသား စာတွေတော့ မပျက်ပါဘူး။ Auto-post / Join Bonus channel တွေကတော့ သူ့ panel မှာပဲ ဖျက်လို့ရပါတယ်)_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(
          saved
            .filter((c) => `chmgr_del:${c.chatId}`.length <= 64)
            .map((c) => [Markup.button.callback(`🗑 ${c.title || c.chatId}`, `chmgr_del:${c.chatId}`)])
        ),
      }
    );
  });

  bot.action(/^chmgr_del:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const removed = await removeChannel(ctx.match[1], ctx.from.id);
    if (!removed) return ctx.reply('❌ ဒီ channel က စာရင်းထဲမှာ မရှိတော့ပါဘူး။');
    await ctx.reply(`✅ *${escMd(removed.title || removed.chatId)}* ကို စာရင်းက ဖျက်လိုက်ပါပြီ။`, {
      parse_mode: 'Markdown',
    });
    await showPanel(ctx);
  });

  // Text input: channel @username/ID for the add wizard
  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminChannelMgr;
    if (!state || state.step !== 'awaiting_channel' || ctx.from.id !== config.bot.adminId) return next();
    const input = ctx.message.text.trim();
    if (input.startsWith('/')) { ctx.session.adminChannelMgr = null; return next(); }
    if (/^cancel$/i.test(input)) {
      ctx.session.adminChannelMgr = null;
      return ctx.reply('👌 ပယ်ဖျက်လိုက်ပါပြီ။');
    }

    try {
      const chat = await ctx.telegram.getChat(input);
      if (chat.type !== 'channel') {
        return ctx.reply(
          `❌ ဒါက channel မဟုတ်ပါဘူး (${chat.type})။ Channel ရဲ့ @username (သို့) ID ကိုပဲ ရိုက်ပါ (သို့) \`cancel\` ရိုက်ပါ:`,
          { parse_mode: 'Markdown' }
        );
      }

      // Channel validated — now ask what it's for
      ctx.session.adminChannelMgr = {
        step: 'purpose',
        chat: {
          id: String(chat.id),
          title: chat.title || input,
          username: chat.username || '',
          invite_link: chat.invite_link || '',
        },
      };
      return ctx.reply(
        `✅ Channel တွေ့ပါပြီ: *${escMd(chat.title || input)}*\n\n` +
          `ဒီ channel ကို *ဘာအတွက်* သုံးမလဲ? 👇`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📅 Auto-post (နေ့စဉ် ကြော်ငြာတင်)', 'chmgr_purpose:autopost')],
            [Markup.button.callback('📣 Join Bonus (join ရင် MC ပေး)', 'chmgr_purpose:joinbonus')],
            [Markup.button.callback('📢 ကြေညာချက် channel အဖြစ်သတ်မှတ်', 'chmgr_purpose:announce')],
            [Markup.button.callback('🔐 Backup channel အဖြစ်သတ်မှတ်', 'chmgr_purpose:backup')],
            [Markup.button.callback('⭐ Review channel (⭐4-5 review တင်)', 'chmgr_purpose:review')],
            [Markup.button.callback('🎮 Game Update channel (မေးရင် ဖြေဖို့)', 'chmgr_purpose:game')],
            [Markup.button.callback('📖 FAQ channel (အမြဲတမ်း မေးခွန်းတွေ)', 'chmgr_purpose:faq')],
            [Markup.button.callback('💾 ရိုးရိုး စာရင်းထဲ သိမ်းမယ်', 'chmgr_purpose:saved')],
            [Markup.button.callback('❌ မလုပ်တော့ပါ', 'chmgr_purpose:cancel')],
          ]),
        }
      );
    } catch (e) {
      console.error('[ChannelManager] add channel error:', e.message);
      return ctx.reply(
        `❌ မထည့်လို့ရပါ — ${escMd(e.message)}\n\n` +
          `စစ်ရန်: ① channel ID/@username မှန်လား ② bot ကို channel မှာ admin ထည့်ထားလား\n` +
          `ထပ်ရိုက်ကြည့်ပါ (သို့) \`cancel\` ရိုက်ပါ:`,
        { parse_mode: 'Markdown' }
      );
    }
  });
};
