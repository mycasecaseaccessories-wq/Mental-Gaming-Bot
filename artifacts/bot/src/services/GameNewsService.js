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

module.exports = { findPosts, RETENTION_DAYS };
