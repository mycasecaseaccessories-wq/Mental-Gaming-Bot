/**
 * ChannelRegistryService
 * Central place to list every channel the bot knows about:
 *  - saved list (SystemStatus.couponAnnounceChannels — the manually managed registry)
 *  - channel auto-post channels (ChannelAutoPost)
 *  - join bonus channels (JoinReward)
 *  - product announcement channel (SystemStatus.announcementChannelId)
 */

const SOURCE_LABELS = {
  saved: '💾 သိမ်းထားတဲ့',
  autopost: '📅 Auto-post',
  joinbonus: '📣 Join Bonus',
  announce: '📢 ကြေညာချက်',
};

/**
 * Returns deduped list: [{ chatId, title, sources: ['saved','autopost',...] }]
 * First-seen title wins; sources accumulate.
 */
async function getKnownChannels() {
  const SystemStatus = require('../models/SystemStatus');
  const ChannelAutoPost = require('../models/ChannelAutoPost');
  const JoinReward = require('../models/JoinReward');

  const st = await SystemStatus.get();
  const map = new Map();
  const add = (chatId, title, source) => {
    if (!chatId) return;
    const key = String(chatId).trim();
    if (!key) return;
    if (!map.has(key)) map.set(key, { chatId: key, title: title || key, sources: [] });
    const entry = map.get(key);
    if (!entry.sources.includes(source)) entry.sources.push(source);
    if ((!entry.title || entry.title === entry.chatId) && title) entry.title = title;
  };

  (st.couponAnnounceChannels || []).forEach((c) => add(c.chatId, c.title, 'saved'));
  if (st.announcementChannelId) add(st.announcementChannelId, 'ကြေညာချက် Channel', 'announce');

  const [posts, rewards] = await Promise.all([
    ChannelAutoPost.find({}, 'channelId title').lean().catch(() => []),
    JoinReward.find({}, 'channelId title').lean().catch(() => []),
  ]);
  posts.forEach((p) => add(p.channelId, p.title, 'autopost'));
  rewards.forEach((r) => add(r.channelId, r.title, 'joinbonus'));

  return [...map.values()];
}

/** Save a channel into the registry (atomic guarded push, dedup by chatId). */
async function saveChannel(chat, byTelegramId) {
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const chatIdStr = String(chat.id);
  await SystemStatus.updateOne(
    { _id: st._id, 'couponAnnounceChannels.chatId': { $ne: chatIdStr } },
    {
      $push: { couponAnnounceChannels: { chatId: chatIdStr, title: chat.title || chatIdStr } },
      $set: { updatedBy: byTelegramId },
    }
  );
  return { chatId: chatIdStr, title: chat.title || chatIdStr };
}

/** Remove a saved channel from the registry (atomic pull). Returns removed entry or null. */
async function removeChannel(chatId, byTelegramId) {
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const removed = (st.couponAnnounceChannels || []).find((c) => String(c.chatId) === String(chatId));
  if (!removed) return null;
  await SystemStatus.updateOne(
    { _id: st._id },
    { $pull: { couponAnnounceChannels: { chatId: String(chatId) } }, $set: { updatedBy: byTelegramId } }
  );
  return removed;
}

module.exports = { getKnownChannels, saveChannel, removeChannel, SOURCE_LABELS };
