/**
 * GameNewsService — direct (no-AI) lookup of game update channel posts.
 *
 * Used as a zero-cost fallback so the bot can answer game update questions
 * even when the AI is disabled or out of quota: matching posts are returned
 * verbatim instead of an AI-generated answer.
 */

const RETENTION_DAYS = 90;

async function findPosts(query, limit = 3) {
  const GameNews = require('../models/GameNews');
  const SystemStatus = require('../models/SystemStatus');

  const q = (query || '').trim();
  if (!q) return [];

  const st = await SystemStatus.get();
  if (!st.gameNewsChannelId) return [];
  const chatId = String(st.gameNewsChannelId);

  const fresh = {
    chatId,
    postedAt: { $gte: new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000) },
  };

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

/**
 * Forward the original channel posts to the user (keeps the channel name —
 * real forward, not a copy). Falls back to a plain-text excerpt if a forward
 * fails (e.g. post deleted from the channel).
 * Returns true if at least one post was delivered.
 */
async function sendPostsAsForwards(ctx, posts) {
  if (!posts || !posts.length) return false;

  let delivered = 0;
  const fallbacks = [];

  for (const p of posts) {
    try {
      await ctx.telegram.forwardMessage(ctx.chat.id, p.chatId, p.messageId);
      delivered++;
    } catch (e) {
      console.error(`[GameNews] forward failed (${p.chatId}/${p.messageId}):`, e.message);
      fallbacks.push(p);
    }
  }

  // Text fallback for posts that could not be forwarded
  if (fallbacks.length) {
    const chunks = fallbacks.map((p) => {
      const d = new Date(p.postedAt).toLocaleDateString('en-GB');
      const t = String(p.text || '');
      return `📅 ${d}\n${t.length > 600 ? `${t.slice(0, 600)}…` : t}`;
    });
    try {
      await ctx.reply(chunks.join('\n\n──────────\n\n'));
      delivered += fallbacks.length;
    } catch (e) {
      console.error('[GameNews] fallback text reply failed:', e.message);
    }
  }

  return delivered > 0;
}

module.exports = { findPosts, sendPostsAsForwards, RETENTION_DAYS };
