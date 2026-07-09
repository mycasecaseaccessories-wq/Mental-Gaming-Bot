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

const RETENTION_DAYS = 90; // keep posts from the last 3 months

async function captureChannelPost(post, telegram) {
  if (!post || !post.chat) return;

  const SystemStatus = require('../models/SystemStatus');
  const GameNews = require('../models/GameNews');

  const st = await SystemStatus.get();
  if (!st.gameNewsChannelId) return;
  if (String(post.chat.id) !== String(st.gameNewsChannelId)) return;

  let text = (post.text || post.caption || '').trim();

  // Photo post → read text/dates inside the image with Gemini vision
  if (Array.isArray(post.photo) && post.photo.length && telegram) {
    try {
      const axios = require('axios');
      const { extractImageText } = require('../services/aiService');

      const largest = post.photo[post.photo.length - 1];
      const link = await telegram.getFileLink(largest.file_id);
      const resp = await axios.get(String(link), {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 10 * 1024 * 1024,
      });
      const extracted = await extractImageText(
        Buffer.from(resp.data).toString('base64'),
        'image/jpeg'
      );
      if (extracted) {
        text = text ? `${text}\n[From image] ${extracted}` : `[From image] ${extracted}`;
      }
    } catch (e) {
      console.error('[GameNews] photo extract failed:', e.message);
    }
  }

  if (!text) return;

  const chatId = String(post.chat.id);
  const postedAt = post.date ? new Date(post.date * 1000) : new Date();

  await GameNews.updateOne(
    { chatId, messageId: post.message_id },
    { $set: { text: text.slice(0, 4000), postedAt } },
    { upsert: true }
  );
  console.log(`[GameNews] 📝 saved post ${post.message_id} from ${chatId} (${text.length} chars)`);

  // Retention — drop posts older than 3 months
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
  await GameNews.deleteMany({ chatId, postedAt: { $lt: cutoff } });

  // Cap storage — drop oldest beyond MAX_ENTRIES
  const count = await GameNews.countDocuments({ chatId });
  if (count > MAX_ENTRIES) {
    const old = await GameNews.find({ chatId })
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
      await captureChannelPost(ctx.channelPost, ctx.telegram);
    } catch (e) {
      console.error('[GameNews] capture error:', e.message);
    }
    return next();
  });

  bot.on('edited_channel_post', async (ctx, next) => {
    try {
      await captureChannelPost(ctx.editedChannelPost, ctx.telegram);
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
      `🗂 သိမ်းထားတဲ့ post: *${count}* ခု (နောက်ဆုံး ၃ လအတွင်း၊ အများဆုံး ${MAX_ENTRIES} ခု)\n` +
      `🖼 ပုံပါ post ဆိုရင် ပုံထဲက စာ/ရက်စွဲကိုပါ AI နဲ့ ဖတ်ပြီး သိမ်းပါတယ်\n\n`;

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
      body += `\n\n_Customer က game မေးခွန်းမေးရင် ကိုက်ညီတဲ့ post ကို channel နာမည်ပေါ်အောင် တိုက်ရိုက် forward လုပ်ပြီး ဖြေပေးပါမယ်။_`;
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
