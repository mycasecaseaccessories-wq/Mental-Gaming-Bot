/**
 * ChannelAutoPostService
 *
 * Sends configured promotional posts to Telegram channels at scheduled MMT
 * slots. Driven by CronService (10-minute tick).
 *
 * A post fires when:
 *   - isActive === true
 *   - current MMT time HH:MM is within [scheduledHH:scheduledMM,
 *     scheduledHH:scheduledMM + 9 min] (covers the 10-min cron window)
 *   - lastSentDate !== today (MST)
 */

const crypto = require('crypto');
const ChannelAutoPost = require('../models/ChannelAutoPost');

const MMT_OFFSET_MIN = 6 * 60 + 30; // UTC+6:30

function nowInMMT() {
  const now = new Date();
  const mmt = new Date(now.getTime() + MMT_OFFSET_MIN * 60_000);
  return {
    date: mmt.toISOString().slice(0, 10), // YYYY-MM-DD in MMT
    hour: mmt.getUTCHours(),
    min:  mmt.getUTCMinutes(),
  };
}

function isWithinWindow({ scheduledHour, scheduledMinute }, { hour, min }) {
  const MIN_PER_DAY = 24 * 60;
  const startTotal = scheduledHour * 60 + scheduledMinute;
  const nowTotal   = hour * 60 + min;
  // Modulo-day arithmetic so a schedule like 23:55 still fires on the 00:00 tick.
  const diff = (nowTotal - startTotal + MIN_PER_DAY) % MIN_PER_DAY;
  return diff < 10; // 10-minute send window
}

function buildText(post) {
  const head = post.title ? `*${post.title}*\n\n` : '';
  return head + post.body;
}

async function claimPost(postId, date) {
  const token = crypto.randomUUID();
  const staleAt = new Date(Date.now() - 15 * 60_000);
  const post = await ChannelAutoPost.findOneAndUpdate(
    {
      _id: postId,
      isActive: true,
      lastSentDate: { $ne: date },
      $or: [{ sendClaimedAt: null }, { sendClaimedAt: { $lt: staleAt } }],
    },
    { $set: { sendClaimedAt: new Date(), sendClaimToken: token } },
    { new: true },
  ).lean();
  return post ? { post, token } : null;
}

async function releaseClaim(postId, token) {
  await ChannelAutoPost.updateOne(
    { _id: postId, sendClaimToken: token },
    { $unset: { sendClaimedAt: 1, sendClaimToken: 1 } },
  );
}

async function completeClaim(postId, token, date) {
  await ChannelAutoPost.updateOne(
    { _id: postId, sendClaimToken: token },
    {
      $set: { lastSentDate: date, lastSentAt: new Date() },
      $inc: { sendCount: 1 },
      $unset: { sendClaimedAt: 1, sendClaimToken: 1 },
    },
  );
}

async function runDuePosts(telegram) {
  const t = nowInMMT();
  const candidates = await ChannelAutoPost.find({ isActive: true }).lean();

  let sent = 0, failed = 0;
  for (const candidate of candidates) {
    if (!isWithinWindow(candidate, t)) continue;
    const claimed = await claimPost(candidate._id, t.date);
    if (!claimed) continue; // another worker owns this scheduled post

    try {
      await telegram.sendMessage(claimed.post.channelId, buildText(claimed.post), {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      await completeClaim(claimed.post._id, claimed.token, t.date);
      sent += 1;
      console.log(`[ChannelAutoPost] ✅ Sent to ${claimed.post.channelId} (${claimed.post.channelLabel || 'unlabeled'})`);
    } catch (err) {
      await releaseClaim(claimed.post._id, claimed.token);
      failed += 1;
      console.error(`[ChannelAutoPost] ❌ Failed for ${claimed.post.channelId}:`, err.message);
    }
  }

  return { sent, failed, considered: candidates.length };
}

async function sendOneNow(telegram, postId) {
  const post = await ChannelAutoPost.findById(postId);
  if (!post) throw new Error('Post not found');
  await telegram.sendMessage(post.channelId, buildText(post), { parse_mode: 'Markdown' });
  post.lastSentAt = new Date();
  post.lastSentDate = nowInMMT().date;
  post.sendCount += 1;
  await post.save();
  return post;
}

module.exports = { runDuePosts, sendOneNow, nowInMMT, isWithinWindow, buildText };
