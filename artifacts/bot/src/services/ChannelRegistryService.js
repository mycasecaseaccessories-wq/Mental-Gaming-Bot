/**
 * ChannelRegistryService
 * Central registry + unified role management for /channels.
 */

const SOURCE_LABELS = {
  saved: '💾 သိမ်းထားတဲ့',
  autopost: '📅 Auto-post',
  joinbonus: '📣 Join Bonus',
  announce: '📢 ကြေညာချက်',
  backup: '🔐 Backup',
  review: '⭐ Review',
  game: '🎮 Game Update',
  faq: '📖 FAQ',
  livefeed: '📡 Live Feed',
};

const SIMPLE_ROLES = ['saved', 'announce', 'backup', 'review', 'game', 'faq', 'livefeed'];
const ALL_ROLES = [...SIMPLE_ROLES, 'autopost', 'joinbonus'];

async function getKnownChannels() {
  const SystemStatus = require('../models/SystemStatus');
  const ChannelAutoPost = require('../models/ChannelAutoPost');
  const JoinReward = require('../models/JoinReward');

  const st = await SystemStatus.get();
  const aliases = new Map((st.channelRegistryAliases || []).map((a) => [String(a.chatId), a.title]));
  const map = new Map();
  const add = (chatId, title, source, link = '') => {
    if (!chatId) return;
    const key = String(chatId).trim();
    if (!key) return;
    if (!map.has(key)) map.set(key, { chatId: key, title: title || key, link: link || '', sources: [] });
    const entry = map.get(key);
    if (!entry.sources.includes(source)) entry.sources.push(source);
    if ((!entry.title || entry.title === entry.chatId) && title) entry.title = title;
    if (!entry.link && link) entry.link = link;
  };

  (st.couponAnnounceChannels || []).forEach((c) => add(c.chatId, c.title, 'saved'));
  if (st.announcementChannelId) add(st.announcementChannelId, 'ကြေညာချက် Channel', 'announce');
  if (st.backupChannelId) add(st.backupChannelId, 'Backup Channel', 'backup');
  if (st.feedbackChannelId) add(st.feedbackChannelId, 'Review Channel', 'review');
  if (st.gameNewsChannelId) add(st.gameNewsChannelId, 'Game Update Channel', 'game');
  if (st.faqChannelId) add(st.faqChannelId, 'FAQ Channel', 'faq');
  if (st.liveFeedChannelId) add(st.liveFeedChannelId, 'Live Feed Channel', 'livefeed');
  (st.liveFeedChannels || []).forEach((c) => add(c.chatId, c.title || 'Live Feed Channel', 'livefeed', c.link));

  const [posts, rewards] = await Promise.all([
    ChannelAutoPost.find({}, 'channelId channelLabel title').lean().catch(() => []),
    JoinReward.find({}, 'channelId title channelLink').lean().catch(() => []),
  ]);
  posts.forEach((p) => add(p.channelId, p.channelLabel || p.title, 'autopost'));
  rewards.forEach((r) => add(r.channelId, r.title, 'joinbonus', r.channelLink));

  for (const entry of map.values()) {
    const alias = aliases.get(entry.chatId);
    if (alias) entry.title = alias;
  }
  return [...map.values()];
}

async function getKnownChannel(chatId) {
  return (await getKnownChannels()).find((c) => String(c.chatId) === String(chatId)) || null;
}

async function saveChannel(chat, byTelegramId) {
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const chatIdStr = String(chat.id);
  await SystemStatus.updateOne(
    { _id: st._id, 'couponAnnounceChannels.chatId': { $ne: chatIdStr } },
    { $push: { couponAnnounceChannels: { chatId: chatIdStr, title: chat.title || chatIdStr } }, $set: { updatedBy: byTelegramId } }
  );
  return { chatId: chatIdStr, title: chat.title || chatIdStr };
}

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

async function setChannelAlias(chatId, title, byTelegramId) {
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const id = String(chatId);
  const clean = String(title || '').trim();
  await SystemStatus.updateOne({ _id: st._id }, { $pull: { channelRegistryAliases: { chatId: id } } });
  if (clean) {
    await SystemStatus.updateOne(
      { _id: st._id },
      { $push: { channelRegistryAliases: { chatId: id, title: clean } }, $set: { updatedBy: byTelegramId } }
    );
  } else {
    await SystemStatus.updateOne({ _id: st._id }, { $set: { updatedBy: byTelegramId } });
  }
  return clean;
}

async function addRole(chat, role, byTelegramId) {
  if (!SIMPLE_ROLES.includes(role)) throw new Error('This role needs its setup wizard');
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const id = String(chat.id || chat.chatId);
  const title = chat.title || id;
  const link = chat.link || (chat.username ? `https://t.me/${chat.username}` : '') || chat.invite_link || '';

  if (role === 'saved') return saveChannel({ id, title }, byTelegramId);
  const fieldMap = {
    announce: 'announcementChannelId', backup: 'backupChannelId', review: 'feedbackChannelId',
    game: 'gameNewsChannelId', faq: 'faqChannelId',
  };
  if (fieldMap[role]) {
    await SystemStatus.updateOne({ _id: st._id }, { $set: { [fieldMap[role]]: id, updatedBy: byTelegramId } });
    return { chatId: id, role };
  }
  if (role === 'livefeed') {
    const entry = { chatId: id, title, link };
    await SystemStatus.updateOne(
      { _id: st._id },
      { $set: { liveFeedChannelId: id, liveFeedEnabled: true, updatedBy: byTelegramId }, $pull: { liveFeedChannels: { chatId: id } } }
    );
    await SystemStatus.updateOne({ _id: st._id }, { $push: { liveFeedChannels: entry } });
    return { chatId: id, role };
  }
  return null;
}

async function removeLiveFeedChannel(chatId, byTelegramId) {
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const id = String(chatId);
  const wasConfigured = String(st.liveFeedChannelId || '') === id ||
    (st.liveFeedChannels || []).some((channel) => String(channel.chatId) === id);
  if (!wasConfigured) return null;
  const remaining = (st.liveFeedChannels || []).filter((channel) => String(channel.chatId) !== id);
  const nextPrimary = String(st.liveFeedChannelId || '') === id ? (remaining[0]?.chatId || null) : st.liveFeedChannelId;
  await SystemStatus.updateOne(
    { _id: st._id },
    { $pull: { liveFeedChannels: { chatId: id } }, $set: { liveFeedChannelId: nextPrimary, liveFeedEnabled: Boolean(nextPrimary || remaining.length), updatedBy: byTelegramId } }
  );
  return { chatId: id };
}

async function removeRole(chatId, role, byTelegramId) {
  const id = String(chatId);
  if (!ALL_ROLES.includes(role)) return false;
  if (role === 'saved') return Boolean(await removeChannel(id, byTelegramId));
  if (role === 'livefeed') return Boolean(await removeLiveFeedChannel(id, byTelegramId));

  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  const fieldMap = {
    announce: 'announcementChannelId', backup: 'backupChannelId', review: 'feedbackChannelId',
    game: 'gameNewsChannelId', faq: 'faqChannelId',
  };
  if (fieldMap[role]) {
    const field = fieldMap[role];
    if (String(st[field] || '') !== id) return false;
    await SystemStatus.updateOne({ _id: st._id }, { $set: { [field]: null, updatedBy: byTelegramId } });
    return true;
  }
  if (role === 'autopost') {
    const ChannelAutoPost = require('../models/ChannelAutoPost');
    const result = await ChannelAutoPost.deleteMany({ channelId: id });
    return result.deletedCount > 0;
  }
  if (role === 'joinbonus') {
    const JoinReward = require('../models/JoinReward');
    const result = await JoinReward.deleteMany({ channelId: id });
    return result.deletedCount > 0;
  }
  return false;
}

async function removeAllRoles(chatId, byTelegramId) {
  const channel = await getKnownChannel(chatId);
  if (!channel) return [];
  const removed = [];
  for (const role of [...channel.sources]) {
    if (await removeRole(chatId, role, byTelegramId)) removed.push(role);
  }
  const SystemStatus = require('../models/SystemStatus');
  const st = await SystemStatus.get();
  await SystemStatus.updateOne(
    { _id: st._id },
    { $pull: { channelRegistryAliases: { chatId: String(chatId) } }, $set: { updatedBy: byTelegramId } }
  );
  return removed;
}

module.exports = {
  getKnownChannels, getKnownChannel, saveChannel, removeChannel, setChannelAlias,
  addRole, removeRole, removeAllRoles, removeLiveFeedChannel, SOURCE_LABELS, SIMPLE_ROLES, ALL_ROLES,
};
