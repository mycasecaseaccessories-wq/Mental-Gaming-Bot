/**
 * Game News Capture (Owner) — knowledge base from the Game Update channel
 *
 * Every text/caption post in SystemStatus.gameNewsChannelId is stored into
 * GameNews and injected into the support AI prompt so game questions are
 * answered from the latest updates first.
 *
 *  - bot.on('channel_post') / bot.on('edited_channel_post') — capture/refresh posts
 *  - /gamenews (Owner) — status panel: channel, entry count, latest posts
 *
 * Channel is assigned via /channels → ➕ → 🎮 Game Update purpose.
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');

const MAX_ENTRIES = 300; // keep only the newest N posts

function escMd(s) {
  return String(s ?? '').replace(/([_*`\[\]])/g, '\\$1');
}

async function captureChannelPost(post) {
  if (!post || !post.chat) return;
  const text = (post.text || post.caption || '').trim();
  if (!text) return;

  const SystemStatus = require('../models/SystemStatus');
  const GameNews = require('../models/GameNews');

  const st = await SystemStatus.get();
  if (!st.gameNewsChannelId) return;
  if (String(post.chat.id) !== String(st.gameNewsChannelId)) return;

  const postedAt = post.date ? new Date(post.date * 1000) : new Date();

  await GameNews.updateOne(
    { chatId: String(post.chat.id), messageId: post.message_id },
    { $set: { text: text.slice(0, 4000), postedAt } },
    { upsert: true }
  );

  // Cap storage — drop oldest beyond MAX_ENTRIES
  const count = await GameNews.countDocuments({ chatId: String(post.chat.id) });
  if (count > MAX_ENTRIES) {
    const old = await GameNews.find({ chatId: String(post.chat.id) })
      .sort({ postedAt: -1 })
      .skip(MAX_ENTRIES)
      .select('_id')
      .lean();
    if (old.length) await GameNews.deleteMany({ _id: { $in: old.map((d) => d._id) } });
  }
}

module.exports = (bot) => {
  bot.on('channel_post', async (ctx, next) => {
    try {
      await captureChannelPost(ctx.channelPost);
    } catch (e) {
      console.error('[GameNews] capture error:', e.message);
    }
    return next();
  });

  bot.on('edited_channel_post', async (ctx, next) => {
    try {
      await captureChannelPost(ctx.editedChannelPost);
    } catch (e) {
      console.error('[GameNews] edit capture error:', e.message);
    }
    return next();
  });

  // ── Owner status panel ──────────────────────────────────────────────────────
  async function showPanel(ctx) {
    const SystemStatus = require('../models/SystemStatus');
    const GameNews = require('../models/GameNews');

    const st = await SystemStatus.get();
    if (!st.gameNewsChannelId) {
      return ctx.reply(
        `🎮 *Game Update Channel*\n\n` +
          `မသတ်မှတ်ရသေးပါဘူး။\n\n` +
          `သတ်မှတ်ရန်: /channels → ➕ Channel ထည့်မယ် → 🎮 *Game Update channel* ကို ရွေးပါ။`,
        { parse_mode: 'Markdown' }
      );
    }

    const [count, latest] = await Promise.all([
      GameNews.countDocuments({ chatId: String(st.gameNewsChannelId) }),
      GameNews.find({ chatId: String(st.gameNewsChannelId) })
        .sort({ postedAt: -1 })
        .limit(5)
        .lean(),
    ]);

    let body =
      `🎮 *Game Update Channel*\n\n` +
      `📡 Channel: \`${escMd(String(st.gameNewsChannelId))}\`\n` +
      `🗂 သိမ်းထားတဲ့ post: *${count}* ခု (နောက်ဆုံး ${MAX_ENTRIES} ခုအထိ)\n\n`;

    if (!latest.length) {
      body += `_Post မရှိသေးပါဘူး — channel ထဲ update တင်လိုက်တာနဲ့ bot က အလိုအလျောက် မှတ်ပါမယ်။_`;
    } else {
      body += `*နောက်ဆုံး post များ:*\n`;
      body += latest
        .map((n, i) => {
          const preview = n.text.length > 80 ? n.text.slice(0, 80) + '…' : n.text;
          const d = new Date(n.postedAt).toLocaleDateString('en-GB');
          return `${i + 1}. _(${d})_ ${escMd(preview)}`;
        })
        .join('\n');
      body += `\n\n_Customer support မှာ game မေးခွန်းလာရင် ဒီ post တွေထဲက ရှာပြီး AI က ဖြေပါမယ်။_`;
    }

    await ctx.reply(body, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'gamenews_refresh')]]),
    });
  }

  bot.command('gamenews', adminOnly(), (ctx) => showPanel(ctx));
  bot.action('gamenews_refresh', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await showPanel(ctx);
  });
};
