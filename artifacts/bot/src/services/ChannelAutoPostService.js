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

async function runDuePosts(telegram) {
  const t = nowInMMT();
  const candidates = await ChannelAutoPost.find({ isActive: true }).lean();

  let sent = 0, failed = 0;
  for (const post of candidates) {
    if (!isWithinWindow(post, t)) continue;
    if (post.lastSentDate === t.date) continue;

    try {
      await telegram.sendMessage(post.channelId, buildText(post), {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      await ChannelAutoPost.updateOne(
        { _id: post._id },
        {
          $set: { lastSentDate: t.date, lastSentAt: new Date() },
          $inc: { sendCount: 1 },
        }
      );
      sent += 1;
      console.log(`[ChannelAutoPost] ✅ Sent to ${post.channelId} (${post.channelLabel || 'unlabeled'})`);
    } catch (err) {
      failed += 1;
      console.error(`[ChannelAutoPost] ❌ Failed for ${post.channelId}:`, err.message);
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

module.exports = { runDuePosts, sendOneNow, nowInMMT };
