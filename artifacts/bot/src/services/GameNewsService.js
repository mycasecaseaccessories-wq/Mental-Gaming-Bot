/**
 * GameNewsService — direct (no-AI) lookup of knowledge channel posts.
 *
 * Covers TWO knowledge channels:
 *   - Game Update channel (SystemStatus.gameNewsChannelId) — 90-day fresh only
 *   - FAQ channel (SystemStatus.faqChannelId) — evergreen, no age cutoff
 *
 * Used as a zero-cost fallback so the bot can answer questions even when the
 * AI is disabled or out of quota: the matching post's text is sent as the
 * answer, with a link back to the original channel post as reference.
 */

const RETENTION_DAYS = 90;

async function findPosts(query, limit = 3) {
  const GameNews = require('../models/GameNews');
  const SystemStatus = require('../models/SystemStatus');

  const q = (query || '').trim();
  if (!q) return [];

  const st = await SystemStatus.get();

  // Game news posts: only fresh ones (90 days). FAQ posts: evergreen (no cutoff).
  const scopes = [];
  if (st.gameNewsChannelId) {
    scopes.push({
      chatId: String(st.gameNewsChannelId),
      postedAt: { $gte: new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000) },
    });
  }
  if (st.faqChannelId) {
    scopes.push({ chatId: String(st.faqChannelId) });
  }
  if (!scopes.length) return [];

  const fresh = scopes.length === 1 ? scopes[0] : { $or: scopes };

  // 1) Mongo text search (relevance-ranked)
  let entries = [];
  try {
    entries = await GameNews.find(
      { ...fresh, $text: { $search: q.slice(0, 200) } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
  } catch {
    entries = [];
  }

  // 2) Keyword regex fallback (latin/digit words — Burmese has no word breaks,
  //    so $text tokenization often misses; game names are usually latin)
  if (!entries.length) {
    const words = (q.match(/[A-Za-z0-9]{3,}/g) || []).slice(0, 5);
    if (words.length) {
      const rx = words
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      entries = await GameNews.find({
        ...fresh,
        text: { $regex: rx, $options: 'i' },
      })
        .sort({ postedAt: -1 })
        .limit(limit)
        .lean();
    }
  }

  return entries;
}

// Cache channel info (username/title) so we don't hit getChat on every answer
const CHAT_INFO_TTL = 10 * 60 * 1000;
const chatInfoCache = new Map(); // chatId -> { username, title, at }

async function getChatInfo(telegram, chatId) {
  const cid = String(chatId);
  const cached = chatInfoCache.get(cid);
  if (cached && Date.now() - cached.at < CHAT_INFO_TTL) return cached;
  let info = { username: null, title: '', at: Date.now() };
  try {
    const chat = await telegram.getChat(cid);
    info = { username: chat.username || null, title: chat.title || '', at: Date.now() };
  } catch (e) {
    console.error(`[GameNews] getChat failed (${cid}):`, e.message);
    if (cached) return cached; // stale is better than nothing
  }
  chatInfoCache.set(cid, info);
  return info;
}

function buildPostLink(chatId, messageId, username) {
  if (username) return `https://t.me/${username}/${messageId}`;
  const cid = String(chatId);
  if (cid.startsWith('-100')) return `https://t.me/c/${cid.slice(4)}/${messageId}`;
  return null;
}

/**
 * Answer the user directly with the stored post text, attaching the original
 * channel post as a "reference" link button (instead of forwarding the whole
 * post). Public channels get a t.me/<username>/<id> link; private channels
 * get a t.me/c/... link (opens only for channel members).
 * Returns true if at least one answer was delivered.
 */
async function sendPostsAsAnswers(ctx, posts) {
  if (!posts || !posts.length) return false;

  let delivered = 0;

  for (const p of posts) {
    try {
      const info = await getChatInfo(ctx.telegram, p.chatId);
      const url = buildPostLink(p.chatId, p.messageId, info.username);

      const d = new Date(p.postedAt).toLocaleDateString('en-GB');
      const header = `${info.title ? `📢 ${info.title}` : '📢 Channel'} · 📅 ${d}`;
      const t = String(p.text || '').trim();
      const body = t.length > 3500 ? `${t.slice(0, 3500)}…` : t;

      const extra = { disable_web_page_preview: true };
      if (url) {
        extra.reply_markup = {
          inline_keyboard: [[{ text: '🔗 မူရင်း post ကြည့်ရန်', url }]],
        };
      }

      // Plain text (no parse_mode) — stored channel content may contain
      // characters that would break Markdown parsing
      await ctx.reply(`${header}\n\n${body}`, extra);
      delivered++;
    } catch (e) {
      console.error(`[GameNews] answer reply failed (${p.chatId}/${p.messageId}):`, e.message);
    }
  }

  return delivered > 0;
}

module.exports = { findPosts, sendPostsAsAnswers, RETENTION_DAYS };
