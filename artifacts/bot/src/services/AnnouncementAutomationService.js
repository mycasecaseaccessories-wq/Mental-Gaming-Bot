const crypto = require('crypto');
const AnnouncementSchedule = require('../models/AnnouncementSchedule');
const AnnouncementRun = require('../models/AnnouncementRun');
const AnnouncementDelivery = require('../models/AnnouncementDelivery');
const Product = require('../models/Product');
const Catalog = require('../models/Catalog');
const AccountProduct = require('../models/AccountProduct');
const BroadcastService = require('./BroadcastService');

const MMT_TIME_ZONE = 'Asia/Rangoon';
const CLAIM_STALE_MS = 15 * 60 * 1000;

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MMT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((out, p) => ({ ...out, [p.type]: p.value }), {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute),
  };
}

function nextRunAt(schedule, from = new Date()) {
  if (schedule.frequency === 'once') return schedule.runAt || null;
  const local = localParts(from);
  const offsetMs = 6.5 * 60 * 60_000;
  if (schedule.frequency === 'daily' || schedule.frequency === 'weekly' || schedule.frequency === 'monthly') {
    const candidate = new Date(Date.UTC(local.year, local.month - 1, local.day, Number(schedule.localHour ?? 9), Number(schedule.localMinute || 0)));
    const maxDays = schedule.frequency === 'monthly' ? 370 : 8;
    for (let days = 0; days <= maxDays; days += 1) {
      const weekday = candidate.getUTCDay();
      const weekdayOk = schedule.frequency !== 'weekly'
        || !Array.isArray(schedule.weekdays) || !schedule.weekdays.length || schedule.weekdays.includes(weekday);
      const monthDayOk = schedule.frequency !== 'monthly'
        || candidate.getUTCDate() === Number(schedule.monthDay || 1);
      if (weekdayOk && monthDayOk && candidate.getTime() > Date.now() + offsetMs) return new Date(candidate.getTime() - offsetMs);
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
  }
  const minuteStep = schedule.frequency === 'hourly' ? 60
    : schedule.frequency === 'every_6_hours' ? 360
      : Math.max(60, schedule.intervalMinutes || 60);
  return new Date(from.getTime() + minuteStep * 60_000);
}

async function resolveTargets(schedule) {
  if (schedule.targetType === 'product') return Product.find({ _id: { $in: schedule.productIds || [] }, isActive: true });
  if (schedule.targetType === 'account') return AccountProduct.find({ _id: { $in: schedule.accountProductIds || [] }, isActive: true });
  if (schedule.targetType === 'category') {
    const requested = (Array.isArray(schedule.categories) && schedule.categories.length)
      ? schedule.categories.filter(Boolean)
      : [schedule.category].filter(Boolean);
    const catalogs = await Catalog.find({ isActive: true, name: { $in: requested } }).select('_id name').lean();
    const catalogIds = new Set(catalogs.map((c) => String(c._id)));
    const catalogNames = new Set(requested);
    let frontier = [...catalogIds];
    while (frontier.length) {
      const children = await Catalog.find({ isActive: true, parentCategory: { $in: frontier } }).select('_id name').lean();
      frontier = [];
      for (const child of children) {
        const id = String(child._id);
        if (!catalogIds.has(id)) {
          catalogIds.add(id);
          catalogNames.add(child.name);
          frontier.push(id);
        }
      }
    }
    return Product.find({
      isActive: true,
      $or: [
        { catalogId: { $in: [...catalogIds] } },
        { category: { $in: [...catalogNames] } },
      ],
    }).sort({ updatedAt: -1 });
  }
  const [products, accounts] = await Promise.all([
    Product.find({ isActive: true }).sort({ updatedAt: -1 }),
    AccountProduct.find({ isActive: true }).sort({ displayOrder: 1, serviceName: 1 }),
  ]);
  return [...products, ...accounts];
}

function targetType(doc) {
  return doc.serviceName != null ? 'account' : 'shop';
}

function fingerprint(schedule, targets) {
  const snapshot = targets.map((doc) => ({
    type: targetType(doc), id: String(doc._id), price: doc.finalPrice ?? doc.price,
    stock: doc.stockCount ?? null, updatedAt: doc.updatedAt,
  }));
  return crypto.createHash('sha256').update(JSON.stringify({ schedule: String(schedule._id), style: schedule.style, snapshot })).digest('hex');
}

async function claimSchedule(schedule) {
  const token = crypto.randomUUID();
  const staleAt = new Date(Date.now() - CLAIM_STALE_MS);
  const now = new Date();
  const claimed = await AnnouncementSchedule.findOneAndUpdate(
    {
      _id: schedule._id,
      isActive: true,
      $or: [
        { nextRunAt: { $lte: now, $ne: null } },
        { nextRunAt: null, frequency: { $ne: 'once' } },
        { nextRunAt: { $exists: false }, frequency: { $ne: 'once' } },
      ],
      $and: [{ $or: [{ claimedAt: null }, { claimedAt: { $lt: staleAt } }] }],
    },
    { $set: { claimedAt: new Date(), claimToken: token } },
    { new: true }
  );
  return claimed ? { schedule: claimed, token } : null;
}

async function releaseSchedule(id, token, patch = {}) {
  await AnnouncementSchedule.updateOne({ _id: id, claimToken: token }, { $set: patch, $unset: { claimedAt: 1, claimToken: 1 } });
}

async function runSchedule(schedule, token, telegram) {
  const targets = await resolveTargets(schedule);
  const fp = fingerprint(schedule, targets);
  if (schedule.lastFingerprint === fp && schedule.style !== 'restock') {
    await AnnouncementRun.create({ scheduleId: schedule._id, trigger: 'scheduled', fingerprint: fp, status: 'skipped_duplicate', selectedCount: targets.length, completedAt: new Date() });
    const next = schedule.frequency === 'once' ? null : nextRunAt(schedule);
    await releaseSchedule(schedule._id, token, { lastRunAt: new Date(), nextRunAt: next, lastFingerprint: fp });
    return { skipped: true, selected: targets.length };
  }

  const run = await AnnouncementRun.create({ scheduleId: schedule._id, trigger: 'scheduled', fingerprint: fp, selectedCount: targets.length });
  let channelSent = 0, userSent = 0, failed = 0;
  try {
    if (schedule.targetType === 'category') {
      const result = await BroadcastService.announceProductsEverywhere(targets, schedule.style === 'flash' ? 'flash' : 'new', telegram, {
        scheduleId: schedule._id, runId: run._id, retentionSeconds: schedule.retentionSeconds, destination: schedule.destination,
      });
      channelSent += result.channelOk ? 1 : 0;
      userSent += result.sent || 0;
      failed += result.failed || (result.channelOk ? 0 : 1);
    } else for (const target of targets) {
      try {
        if (targetType(target) === 'account') {
          const result = await BroadcastService.announceAccountProductEverywhere(target, telegram, {
            scheduleId: schedule._id, runId: run._id, retentionSeconds: schedule.retentionSeconds, destination: schedule.destination,
          });
          channelSent += result.channelOk ? 1 : 0; userSent += result.sent || 0; failed += result.failed || 0;
        } else {
          const result = await BroadcastService.announceProductEverywhere(target, schedule.style === 'flash' ? 'flash' : 'new', telegram, {
            scheduleId: schedule._id, runId: run._id, retentionSeconds: schedule.retentionSeconds, destination: schedule.destination,
          });
          channelSent += result.channelOk ? 1 : 0; userSent += result.sent || 0; failed += result.failed || 0;
        }
      } catch (err) { failed += 1; console.error('[AnnouncementAutomation] target failed:', err.message); }
    }
    await AnnouncementRun.updateOne({ _id: run._id }, { $set: { status: 'completed', completedAt: new Date(), channelSent, userSent, failed } });
    await AnnouncementSchedule.updateOne(
      { _id: schedule._id, claimToken: token },
      {
        $set: {
          lastRunAt: new Date(),
          nextRunAt: schedule.frequency === 'once' ? null : nextRunAt(schedule),
          lastFingerprint: fp,
        },
        $inc: { sendCount: userSent, failedCount: failed },
        $unset: { claimedAt: 1, claimToken: 1 },
      }
    );
    return { selected: targets.length, channelSent, userSent, failed };
  } catch (err) {
    await AnnouncementRun.updateOne({ _id: run._id }, { $set: { status: 'failed', completedAt: new Date(), error: err.message, channelSent, userSent, failed } });
    await releaseSchedule(schedule._id, token, { failedCount: (schedule.failedCount || 0) + 1, nextRunAt: nextRunAt(schedule) });
    throw err;
  }
}

async function runDueSchedules(telegram) {
  const now = new Date();
  const candidates = await AnnouncementSchedule.find({
    isActive: true,
    $or: [
      { nextRunAt: { $lte: now, $ne: null } },
      { nextRunAt: null, frequency: { $ne: 'once' } },
      { nextRunAt: { $exists: false }, frequency: { $ne: 'once' } },
    ],
  }).limit(50).lean();
  const summary = { considered: candidates.length, completed: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    const claimed = await claimSchedule(candidate);
    if (!claimed) continue;
    try {
      const result = await runSchedule(claimed.schedule, claimed.token, telegram);
      if (result.skipped) summary.skipped += 1; else summary.completed += 1;
    } catch (err) { summary.failed += 1; console.error('[AnnouncementAutomation] schedule failed:', err.message); }
  }
  return summary;
}

async function cleanupDeliveries(telegram) {
  const now = new Date();
  // Only user messages are auto-deleted by schedule retention. Channel posts
  // are intentionally preserved, matching the admin setting semantics.
  const due = await AnnouncementDelivery.find({
    destination: 'user',
    status: { $in: ['sent', 'failed'] },
    deleteAt: { $ne: null, $lte: now },
  }).sort({ deleteAt: 1 }).limit(500);
  let deleted = 0, alreadyGone = 0, failed = 0;
  for (const delivery of due) {
    try {
      await telegram.deleteMessage(delivery.chatId, delivery.messageId);
      await AnnouncementDelivery.updateOne(
        { _id: delivery._id },
        { $set: { status: 'deleted', lastError: null }, $inc: { attempts: 1 } }
      );
      deleted += 1;
    } catch (err) {
      const code = err.response?.error_code ?? err.code;
      const description = String(err.response?.description || err.message || '').toLowerCase();
      // Telegram returns 400 when a user already deleted the message or when
      // it is no longer available. Treat that as successful cleanup.
      if (code === 400 && /message to delete not found|message can't be deleted|message not found|chat not found/.test(description)) {
        await AnnouncementDelivery.updateOne(
          { _id: delivery._id },
          { $set: { status: 'deleted', lastError: null }, $inc: { attempts: 1 } }
        );
        alreadyGone += 1;
      } else {
        failed += 1;
        await AnnouncementDelivery.updateOne(
          { _id: delivery._id },
          { $set: { status: 'failed', lastError: String(err.message || err) }, $inc: { attempts: 1 } }
        );
      }
    }
  }
  if (due.length || failed) {
    console.log(`[AnnouncementAutomation] cleanup due=${due.length} deleted=${deleted} alreadyGone=${alreadyGone} failed=${failed}`);
  }
  return { considered: due.length, deleted: deleted + alreadyGone, failed };
}

module.exports = { localParts, nextRunAt, resolveTargets, runDueSchedules, cleanupDeliveries };
