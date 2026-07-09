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
    ctx.session.adminChannelMgr = { step: 'awaiting_channel' };
    await ctx.reply(
      `➕ *Channel ထည့်မယ်*\n\n` +
        `Channel ရဲ့ \`@username\` (သို့) channel ID (ဥပမာ \`-1001234567890\`) ကို ရိုက်ပါ:\n` +
        `_(Bot ကို အဲဒီ channel မှာ admin အရင်ထည့်ထားရပါမယ်။ မလုပ်တော့ရင် \`cancel\` ရိုက်ပါ)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
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
    if (!state || ctx.from.id !== config.bot.adminId) return next();
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

      const saved = await saveChannel(chat, ctx.from.id);
      ctx.session.adminChannelMgr = null;
      await ctx.reply(
        `✅ *${escMd(saved.title)}* ကို channel စာရင်းထဲ ထည့်လိုက်ပါပြီ! 💾\n\n` +
          `Coupon ကြေညာတဲ့အခါ ဒီ channel က ခလုတ်နဲ့ အလိုအလျောက် ပေါ်လာပါမယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
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
