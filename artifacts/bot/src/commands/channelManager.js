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
  removeLiveFeedChannel,
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
    for (const channel of channels) {
      const cb = `chmgr_view:${channel.chatId}`;
      if (cb.length <= 64) rows.push([Markup.button.callback(`⚙️ ${channel.title || channel.chatId}`, cb)]);
    }
    const liveFeedChannels = channels.filter((channel) => channel.sources.includes('livefeed'));
    for (const channel of liveFeedChannels) {
      if (channel.link && /^https:\/\/t\.me\//.test(channel.link)) {
        rows.push([Markup.button.url(`🔗 Open ${channel.title}`, channel.link)]);
      }
      if (`chmgr_testlivefeed:${channel.chatId}`.length <= 64) {
        rows.push([Markup.button.callback(`🧪 Test ${channel.title}`, `chmgr_testlivefeed:${channel.chatId}`)]);
      }
      if (`chmgr_remlivefeed:${channel.chatId}`.length <= 64) {
        rows.push([Markup.button.callback(`🔕 Remove Live Feed: ${channel.title}`, `chmgr_remlivefeed:${channel.chatId}`)]);
      }
    }
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


  bot.action(/^chmgr_view:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const channel = (await getKnownChannels()).find((c) => String(c.chatId) === String(id));
    if (!channel) return ctx.reply('❌ Channel မတွေ့တော့ပါ။');
    const tags = channel.sources.map((x) => SOURCE_LABELS[x] || x).join(', ');
    const rows = [
      [Markup.button.callback('🔍 Check', `chmgr_check:${id}`), Markup.button.callback('✏️ Add/Edit Role', `chmgr_edit:${id}`)],
      [Markup.button.callback('🧪 Test Message', `chmgr_test:${id}`)],
    ];
    if (channel.sources.includes('saved')) rows.push([Markup.button.callback('🗑 Remove Saved Role', `chmgr_delask:${id}`)]);
    if (channel.sources.includes('livefeed')) rows.push([Markup.button.callback('🔕 Remove Live Feed Role', `chmgr_remlivefeed:${id}`)]);
    rows.push([Markup.button.callback('🔙 Channel List', 'chmgr_refresh')]);
    return ctx.reply(`📡 *Channel Detail*

*${escMd(channel.title)}*
ID: \`${escMd(id)}\`
Roles: ${escMd(tags)}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  });

  bot.action(/^chmgr_check:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Checking…'); const id = ctx.match[1];
    try {
      const chat = await ctx.telegram.getChat(id); const me = await ctx.telegram.getMe();
      let member = null; try { member = await ctx.telegram.getChatMember(id, me.id); } catch (_) {}
      const status = member?.status || 'unknown';
      return ctx.reply(`✅ *Channel Check*

Name: *${escMd(chat.title || id)}*
ID: \`${escMd(id)}\`
Type: ${chat.type}
Bot status: *${escMd(status)}*
Username: ${chat.username ? '@' + escMd(chat.username) : '—'}`, { parse_mode:'Markdown' });
    } catch(e) { return ctx.reply(`❌ Channel check failed: ${escMd(e.message)}`, {parse_mode:'Markdown'}); }
  });

  bot.action(/^chmgr_test:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Sending…');
    try { await ctx.telegram.sendMessage(ctx.match[1], '🧪 Mental Gaming Bot — Channel Manager test message.'); return ctx.reply('✅ Test message ပို့ပြီးပါပြီ။'); }
    catch(e) { return ctx.reply(`❌ Test မအောင်မြင်ပါ: ${e.message}`); }
  });

  bot.action(/^chmgr_edit:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const chat = await ctx.telegram.getChat(ctx.match[1]);
      ctx.session.adminChannelMgr = { step:'purpose', chat:{ id:String(chat.id), title:chat.title || String(chat.id), username:chat.username || '', invite_link:chat.invite_link || '' } };
      return ctx.reply('✏️ ဒီ channel အတွက် ထည့်/ပြောင်းချင်တဲ့ role ကိုရွေးပါ:', { ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Auto-post', 'chmgr_purpose:autopost'), Markup.button.callback('📣 Join Bonus', 'chmgr_purpose:joinbonus')],
        [Markup.button.callback('📢 Announcement', 'chmgr_purpose:announce'), Markup.button.callback('🔐 Backup', 'chmgr_purpose:backup')],
        [Markup.button.callback('⭐ Review', 'chmgr_purpose:review'), Markup.button.callback('🎮 Game Update', 'chmgr_purpose:game')],
        [Markup.button.callback('📖 FAQ', 'chmgr_purpose:faq'), Markup.button.callback('📡 Live Feed', 'chmgr_purpose:livefeed')],
        [Markup.button.callback('💾 Saved', 'chmgr_purpose:saved'), Markup.button.callback('❌ Cancel', 'chmgr_purpose:cancel')],
      ]) });
    } catch(e) { return ctx.reply(`❌ ${e.message}`); }
  });

  bot.action(/^chmgr_delask:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery(); const id=ctx.match[1];
    return ctx.reply('⚠️ Saved role ကို ဖယ်မှာသေချာလား?', { ...Markup.inlineKeyboard([[Markup.button.callback('✅ Remove', `chmgr_del:${id}`), Markup.button.callback('❌ Cancel', `chmgr_view:${id}`)]]) });
  });

  bot.action(/^chmgr_testlivefeed:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Testing Live Feed…');
    const LiveFeedService = require('../services/LiveFeedService');
    const result = await LiveFeedService.sendTest(ctx.telegram, ctx.match[1]);
    await ctx.reply(
      `🧪 Live Feed test ပြီးပါပြီ။\n✅ Sent: ${result.sent}\n❌ Failed: ${result.failed}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/^chmgr_remlivefeed:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const removed = await removeLiveFeedChannel(ctx.match[1], ctx.from.id);
    if (!removed) return ctx.reply('❌ ဒီ channel ကို Live Feed အဖြစ် မသတ်မှတ်ထားတော့ပါ။');
    await ctx.reply(
      `✅ *${escMd(removed.chatId)}* ကို Live Feed စာရင်းက ဖယ်လိုက်ပါပြီ။`,
      { parse_mode: 'Markdown' }
    );
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
  bot.action(/^chmgr_purpose:(autopost|joinbonus|announce|backup|review|game|faq|livefeed|saved|cancel)$/, adminOnly(), async (ctx) => {
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
          `ဒီ channel မှာ တင်တဲ့ FAQ post တိုင်းကို bot က မှတ်ထားပြီး — customer က မေးခွန်းမေးလာရင် *post ထဲက စာကို တိုက်ရိုက် ဖြေပေးပြီး မူရင်း post link ကို 🔗 reference ခလုတ်နဲ့ တွဲပေးပါမယ်*။\n\n` +
          `📌 FAQ post တွေက သက်တမ်းမကုန်ပါဘူး (game update လို ၃ လအကန့်အသတ် မရှိပါ)။ ပုံပါ post ဆိုရင် caption မှာ စာရေးပေးပါ။ \`/gamenews\` နဲ့ သိမ်းထားတာတွေ စစ်လို့ရပါတယ်။`,
        { parse_mode: 'Markdown' }
      );
      return showPanel(ctx);
    }

    if (purpose === 'livefeed') {
      const st = await SystemStatus.get();
      const entry = {
        chatId: String(chat.id),
        title: chat.title || String(chat.id),
        link: chat.username ? `https://t.me/${chat.username}` : (chat.invite_link || ''),
      };
      await SystemStatus.updateOne(
        { _id: st._id },
        {
          $set: { liveFeedChannelId: String(chat.id), liveFeedEnabled: true, updatedBy: ctx.from.id },
          $addToSet: { liveFeedChannels: entry },
        }
      );
      await ctx.reply(
        `✅ *${escMd(chat.title)}* ကို 📡 *Live Feed channel* အဖြစ် သတ်မှတ်လိုက်ပါပြီ!\n\n` +
          `Customer တွေ product ဝယ်တာ၊ ပိုက်ဆံ ထည့်တာ၊ giveaway ယူတာတွေကို ဒီ channel မှာ ကြေညာပါမယ်။\n\n` +
          `_/setlivefeed နဲ့ toggle on/off လုပ်နိုင်ပါတယ်။_`,
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
    if (!state || state.step !== 'awaiting_channel') return next();
    const { isAnyAdmin } = require('../middlewares/adminCheck');
    if (!(await isAnyAdmin(ctx.from.id))) return next();
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
            [Markup.button.callback('📡 Live Feed (ဝယ်တာ/ထည့်တာ/ရယူတာ ကြေညာ)', 'chmgr_purpose:livefeed')],
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
