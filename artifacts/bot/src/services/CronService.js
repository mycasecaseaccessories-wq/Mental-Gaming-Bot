/**
 * CronService — Automated maintenance jobs using node-cron.
 *
 * Schedule (all times = Myanmar Time UTC+6:30, stored as UTC in cron):
 *   03:00 MMT — Archive orders older than 6 months
 *   03:05 MMT — Purge/deactivate expired promo codes
 *   03:10 MMT — Log stale screenshot URLs for cleanup
 *   03:20 MMT — Flush in-memory cache (force fresh DB reads at dawn)
 *   06:00 MMT — Trigger encrypted database backup
 *
 * MMT (UTC+6:30) → UTC offset: subtract 6h 30m
 *   03:00 MMT = 20:30 UTC (previous day) → cron '30 20 * * *'
 *   03:05 MMT = 20:35 UTC                → cron '35 20 * * *'
 *   03:10 MMT = 20:40 UTC                → cron '40 20 * * *'
 *   03:20 MMT = 20:50 UTC                → cron '50 20 * * *'
 *   06:00 MMT = 23:30 UTC                → cron '30 23 * * *'
 *
 * All jobs send a compact summary to the OWNER after completion.
 */

const cron   = require('node-cron');
const Order          = require('../models/Order');
const OrderArchive   = require('../models/OrderArchive');
const Promo          = require('../models/Promo');
const Transaction    = require('../models/Transaction');
const CacheService   = require('./CacheService');
const ChannelAutoPostService = require('./ChannelAutoPostService');
const PromoPerksService = require('./PromoPerksService');
const { config }     = require('../../config/settings');

const ARCHIVE_CUTOFF_MONTHS = 6;
const ADMIN_ID = () => config.bot.adminId;

// ── Job helpers ───────────────────────────────────────────────────────────────

async function safeSend(telegram, text) {
  try {
    await telegram.sendMessage(ADMIN_ID(), text, { parse_mode: 'Markdown' });
  } catch {}
}

function getCutoffDate() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_CUTOFF_MONTHS);
  return cutoff;
}

// ── Job 1: Archive old orders ─────────────────────────────────────────────────

async function archiveOldOrders(telegram) {
  const label = 'Order Archive';
  console.log(`[CronService] 🗂 ${label} starting…`);

  try {
    const cutoff = getCutoffDate();

    const oldOrders = await Order.find({
      status:    { $in: ['Success', 'Cancelled', 'Refunded'] },
      timestamp: { $lt: cutoff },
    }).lean();

    if (!oldOrders.length) {
      console.log(`[CronService] ${label}: Nothing to archive`);
      return { archived: 0 };
    }

    const archiveDocs = oldOrders.map((o) => ({
      ...o,
      _id:              o._id,
      archivedAt:       new Date(),
      originalCreatedAt: o.createdAt,
      originalUpdatedAt: o.updatedAt,
    }));

    await OrderArchive.insertMany(archiveDocs, { ordered: false, rawResult: false });
    const deleted = await Order.deleteMany({ _id: { $in: oldOrders.map((o) => o._id) } });

    // Invalidate product cache since stock counters may be stale
    CacheService.invalidateProducts();

    console.log(`[CronService] ✅ ${label}: Archived ${oldOrders.length} orders`);
    await safeSend(telegram,
      `🗂 *Cron: Order Archive*\n✅ Moved *${oldOrders.length}* orders (>${ARCHIVE_CUTOFF_MONTHS}mo) to archive\n🗑 Deleted from main collection: ${deleted.deletedCount}`
    );
    return { archived: oldOrders.length };
  } catch (err) {
    console.error(`[CronService] ❌ ${label}:`, err.message);
    await safeSend(telegram, `❌ *Cron: ${label} FAILED*\n\`${err.message}\``);
    return { archived: 0, error: err.message };
  }
}

// ── Job 2: Purge expired promo codes ─────────────────────────────────────────

async function purgeExpiredPromos(telegram) {
  const label = 'Promo Purge';
  console.log(`[CronService] 🎟 ${label} starting…`);

  try {
    const now = new Date();

    // Expire overused codes
    const expiredByDate = await Promo.updateMany(
      {
        isActive:   true,
        expiryDate: { $ne: null, $lt: now },
      },
      { $set: { isActive: false } }
    );

    // Expire fully-used codes
    const expiredByUses = await Promo.updateMany(
      {
        isActive: true,
        maxUses:  { $ne: null },
        $expr:    { $gte: ['$currentUses', '$maxUses'] },
      },
      { $set: { isActive: false } }
    );

    const total = expiredByDate.modifiedCount + expiredByUses.modifiedCount;

    console.log(`[CronService] ✅ ${label}: Deactivated ${total} promos`);
    if (total > 0) {
      await safeSend(telegram,
        `🎟 *Cron: Promo Purge*\n✅ Deactivated *${total}* expired/exhausted promo codes\n  (by date: ${expiredByDate.modifiedCount}, by uses: ${expiredByUses.modifiedCount})`
      );
    }
    return { deactivated: total };
  } catch (err) {
    console.error(`[CronService] ❌ ${label}:`, err.message);
    await safeSend(telegram, `❌ *Cron: ${label} FAILED*\n\`${err.message}\``);
    return { deactivated: 0, error: err.message };
  }
}

// ── Job 3: Screenshot URL cleanup log ────────────────────────────────────────

async function logStaleScreenshots(telegram) {
  const label = 'Screenshot Audit';
  console.log(`[CronService] 📸 ${label} starting…`);

  try {
    const THIRTY_DAYS = new Date(Date.now() - 30 * 86_400_000);

    // Screenshots on rejected/expired transactions older than 30 days
    const stale = await Transaction.find({
      screenshotUrl: { $ne: null },
      status:        'Rejected',
      timestamp:     { $lt: THIRTY_DAYS },
    }).select('_id screenshotUrl timestamp').lean();

    console.log(`[CronService] ✅ ${label}: ${stale.length} stale screenshots identified`);

    if (stale.length > 0) {
      const preview = stale.slice(0, 5).map((t) =>
        `  • \`${t._id.toString().slice(-8)}\` — \`${t.screenshotUrl?.slice(0, 30)}…\``
      ).join('\n');

      await safeSend(telegram,
        `📸 *Cron: Screenshot Audit*\n` +
        `⚠️ *${stale.length}* stale screenshots on rejected transactions (>30 days)\n\n` +
        `${preview}${stale.length > 5 ? `\n  _…and ${stale.length - 5} more_` : ''}\n\n` +
        `_These are Telegram file_ids. They expire automatically on Telegram's servers._`
      );
    }

    return { stale: stale.length };
  } catch (err) {
    console.error(`[CronService] ❌ ${label}:`, err.message);
    return { stale: 0, error: err.message };
  }
}

// ── Job 4: Cache flush ────────────────────────────────────────────────────────

async function flushCache(telegram) {
  const label = 'Cache Flush';
  console.log(`[CronService] 🧹 ${label} starting…`);

  try {
    const stats = CacheService.getStats();
    CacheService.flushAll();
    console.log(`[CronService] ✅ ${label}: Cleared ${stats.keys} keys`);
    return { clearedKeys: stats.keys };
  } catch (err) {
    console.error(`[CronService] ❌ ${label}:`, err.message);
    return { clearedKeys: 0, error: err.message };
  }
}

// ── Job 5: Database backup ────────────────────────────────────────────────────

async function triggerBackup(telegram) {
  const label = 'DB Backup';
  console.log(`[CronService] 🗄 ${label} starting…`);

  try {
    const { runBackup } = require('./BackupService');
    await runBackup(telegram);
    return { success: true };
  } catch (err) {
    console.error(`[CronService] ❌ ${label}:`, err.message);
    await safeSend(telegram, `❌ *Cron: ${label} FAILED*\n\`${err.message}\``);
    return { success: false, error: err.message };
  }
}

// ── Job 6: Channel auto-post tick (every 10 min) ─────────────────────────────

async function tickChannelAutoPosts(telegram) {
  try {
    const res = await ChannelAutoPostService.runDuePosts(telegram);
    if (res.sent > 0 || res.failed > 0) {
      console.log(`[CronService] 📣 ChannelAutoPost: sent=${res.sent} failed=${res.failed}`);
    }
    if (res.failed > 0) {
      await safeSend(telegram, `📣 *Cron: ChannelAutoPost*\n⚠️ ${res.failed} post(s) failed to send. Check logs.`);
    }
    return res;
  } catch (err) {
    console.error('[CronService] ❌ ChannelAutoPost tick:', err.message);
    return { sent: 0, failed: 0, error: err.message };
  }
}

// ── Job 7: Expire unpaid order reservations ────────────────────────────────────
async function expirePendingReservations(telegram) {
  if (!Number.isFinite(Number(process.env.ORDER_RESERVATION_MINUTES)) || Number(process.env.ORDER_RESERVATION_MINUTES) <= 0) {
    return { enabled: false, expired: 0, failed: 0, scanned: 0 };
  }
  try {
    const { expirePendingOrders } = require('./OrderService');
    const result = await expirePendingOrders({ limit: 100 });
    result.enabled = true;
    if (result.expired || result.failed) {
      console.log(`[CronService] ⏳ Reservation expiry: expired=${result.expired} failed=${result.failed}`);
    }
    if (result.failed > 0) {
      await safeSend(telegram, `⚠️ *Reservation expiry*
${result.failed} order(s) failed to release/refund. Check logs.`);
    }
    return result;
  } catch (err) {
    console.error('[CronService] ❌ Reservation expiry:', err.message);
    return { expired: 0, failed: 1, error: err.message };
  }
}

// ── Job 8: Scheduled announcements and bot-message cleanup ───────────────────
async function tickAnnouncementAutomation(telegram) {
  try {
    const service = require('./AnnouncementAutomationService');
    const schedules = await service.runDueSchedules(telegram);
    const deliveries = await service.cleanupDeliveries(telegram);
    if (schedules.completed || schedules.failed || deliveries.deleted || deliveries.failed) {
      console.log(`[CronService] 📣 AnnounceAutomation schedules=${JSON.stringify(schedules)} deliveries=${JSON.stringify(deliveries)}`);
    }
    return { schedules, deliveries };
  } catch (err) {
    console.error('[CronService] ❌ Announcement automation:', err.message);
    return { error: err.message };
  }
}

// ── Job 8: Giveaway expiry and announcement cleanup ──────────────────────────

async function cleanupGiveaways(telegram) {
  const AccountGiveaway = require('../models/AccountGiveaway');
  const now = new Date();
  let expired = 0;
  let deleted = 0;

  const due = await AccountGiveaway.find({
    isActive: true,
    endAt: { $ne: null, $lte: now },
  }).limit(200);

  for (const giveaway of due) {
    const updated = await AccountGiveaway.findOneAndUpdate(
      { _id: giveaway._id, isActive: true, endAt: { $ne: null, $lte: now } },
      {
        $set: {
          isActive: false,
          ...(giveaway.deleteAfterSeconds > 0
            ? { deleteAt: new Date(now.getTime() + giveaway.deleteAfterSeconds * 1000) }
            : {}),
        },
      },
      { new: true }
    );
    if (!updated) continue;
    expired++;

    if (telegram && updated.announcementChannelId && updated.announcementMessageId) {
      try {
        const remaining = updated.maxClaims > 0
          ? Math.max(0, updated.maxClaims - updated.claimedCount)
          : '∞';
        await telegram.editMessageText(
          updated.announcementChannelId,
          updated.announcementMessageId,
          undefined,
          `${updated.announcementBody || '🎁 Giveaway'}\n\n👥 Claimed: *${updated.claimedCount}*` +
            (updated.maxClaims > 0 ? ` / ${updated.maxClaims}` : '') +
            `\n🔥 Remaining: *${remaining}*\n\n🔴 *Giveaway ended — claims are closed.*`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('[CronService] giveaway expiry update:', error.message);
      }
    }
  }

  const deletable = await AccountGiveaway.find({
    announcementChannelId: { $ne: null },
    announcementMessageId: { $ne: null },
    deleteAt: { $ne: null, $lte: now },
  }).limit(200);
  for (const giveaway of deletable) {
    try {
      if (telegram) {
        await telegram.deleteMessage(giveaway.announcementChannelId, giveaway.announcementMessageId);
      }
      await AccountGiveaway.updateOne(
        { _id: giveaway._id },
        { $set: { announcementMessageId: null, deleteAt: null } }
      );
      deleted++;
    } catch (error) {
      console.error('[CronService] giveaway announcement delete:', error.message);
    }
  }

  if (expired || deleted) {
    console.log(`[CronService] 🎁 Giveaways: expired=${expired} deleted=${deleted}`);
  }
  return { expired, deleted };
}

// ── Job 7: Premium account expiry reminders (daily 09:00 MMT) ────────────────

async function notifyExpiringAccounts(telegram) {
  try {
    const AccountCredential = require('../models/AccountCredential');
    const now = new Date();
    const in3d = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    let sent = 0;

    // Stock-date expiry: auto-remove unsold stock whose fixed shelf life ran out
    try {
      const retired = await AccountCredential.retireExpiredStock();
      const n = retired?.modifiedCount ?? retired?.nModified ?? 0;
      if (n > 0) console.log(`[Cron] ⌛ Retired ${n} expired account stock credential(s).`);
    } catch (err) {
      console.error('[Cron] retireExpiredStock failed:', err.message);
    }

    // Expiring within 3 days
    const expiring = await AccountCredential.find({
      status: 'sold', notified3d: false,
      expiresAt: { $gt: now, $lte: in3d },
      buyerTelegramId: { $ne: null },
    }).limit(200);
    for (const c of expiring) {
      const days = Math.ceil((c.expiresAt - now) / (24 * 60 * 60 * 1000));
      const name = String(c.serviceNameSnap || 'Account');
      const plan = String(c.planLabelSnap || '');
      try {
        await telegram.sendMessage(
          c.buyerTelegramId,
          `⏳ သတိပေးချက်\n\n🔐 ${name}${plan ? ` (${plan})` : ''} သက်တမ်း ${days} ရက်ပဲ ကျန်ပါတော့တယ်။\n\nအသစ် ပြန်ဝယ်ချင်ရင် /accounts ကို နှိပ်ပါ။`
        );
        sent++;
        c.notified3d = true;
        await c.save();
      } catch (err) {
        // User blocked bot / chat gone → mark so we don't retry forever
        if (err?.response?.error_code === 403 || err?.response?.error_code === 400) {
          c.notified3d = true;
          await c.save();
        }
      }
    }

    // Just expired
    const expired = await AccountCredential.find({
      status: 'sold', notifiedExpired: false,
      expiresAt: { $lte: now },
      buyerTelegramId: { $ne: null },
    }).limit(200);
    for (const c of expired) {
      const name = String(c.serviceNameSnap || 'Account');
      const plan = String(c.planLabelSnap || '');
      try {
        await telegram.sendMessage(
          c.buyerTelegramId,
          `🔴 သက်တမ်းကုန်ပါပြီ\n\n🔐 ${name}${plan ? ` (${plan})` : ''} သက်တမ်း ကုန်သွားပါပြီ။\n\nအသစ် ပြန်ဝယ်ချင်ရင် /accounts ကို နှိပ်ပါ။`
        );
        sent++;
        c.notifiedExpired = true;
        await c.save();
      } catch (err) {
        if (err?.response?.error_code === 403 || err?.response?.error_code === 400) {
          c.notifiedExpired = true;
          await c.save();
        }
      }
    }

    // ── Shared / invite slot purchases (AccountSlot) ──────────────────────────
    const AccountSlot = require('../models/AccountSlot');

    const slotExpiring = await AccountSlot.find({
      notified3d: false,
      expiresAt: { $gt: now, $lte: in3d },
      buyerTelegramId: { $ne: null },
    }).limit(200);
    for (const s of slotExpiring) {
      const days = Math.ceil((s.expiresAt - now) / (24 * 60 * 60 * 1000));
      const name = String(s.serviceNameSnap || 'Account');
      const plan = String(s.planLabelSnap || '');
      try {
        await telegram.sendMessage(
          s.buyerTelegramId,
          `⏳ သတိပေးချက်\n\n🔐 ${name}${plan ? ` (${plan})` : ''} သက်တမ်း ${days} ရက်ပဲ ကျန်ပါတော့တယ်။\n\nအသစ် ပြန်ဝယ်ချင်ရင် /accounts ကို နှိပ်ပါ။`
        );
        sent++;
        s.notified3d = true;
        await s.save();
      } catch (err) {
        if (err?.response?.error_code === 403 || err?.response?.error_code === 400) {
          s.notified3d = true;
          await s.save();
        }
      }
    }

    const slotExpired = await AccountSlot.find({
      notifiedExpired: false,
      expiresAt: { $lte: now },
      buyerTelegramId: { $ne: null },
    }).limit(200);
    for (const s of slotExpired) {
      const name = String(s.serviceNameSnap || 'Account');
      const plan = String(s.planLabelSnap || '');
      try {
        await telegram.sendMessage(
          s.buyerTelegramId,
          `🔴 သက်တမ်းကုန်ပါပြီ\n\n🔐 ${name}${plan ? ` (${plan})` : ''} သက်တမ်း ကုန်သွားပါပြီ။\n\nအသစ် ပြန်ဝယ်ချင်ရင် /accounts ကို နှိပ်ပါ။`
        );
        sent++;
        s.notifiedExpired = true;
        await s.save();
      } catch (err) {
        if (err?.response?.error_code === 403 || err?.response?.error_code === 400) {
          s.notifiedExpired = true;
          await s.save();
        }
      }
    }

    if (sent > 0) console.log(`[CronService] 🔐 Account expiry reminders sent: ${sent}`);
    return { success: true, sent };
  } catch (err) {
    console.error('[CronService] ❌ Account expiry reminders:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Monthly Revenue Auto-Report ───────────────────────────────────────────────

async function sendMonthlyRevenueReport(telegram) {
  const label = 'Monthly Revenue Report';
  console.log(`[CronService] 📊 ${label} starting…`);
  try {
    const AnalyticsService = require('./AnalyticsService');

    // Compute previous calendar month boundaries in MMT (UTC+6:30)
    const MMT_OFFSET_MS = 6.5 * 3_600_000;
    const now    = new Date();
    const mmtNow = new Date(now.getTime() + MMT_OFFSET_MS);
    const y      = mmtNow.getUTCFullYear();
    const m      = mmtNow.getUTCMonth(); // 0-based current month; prev = m-1

    // 00:00 MMT on the 1st of the previous month → UTC
    const prevStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - MMT_OFFSET_MS);
    // 23:59:59.999 MMT on the last day of the previous month → UTC
    const prevEnd   = new Date(Date.UTC(y, m,     1, 0, 0, 0) - MMT_OFFSET_MS - 1);

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const prevIdx   = (m - 1 + 12) % 12;
    const prevYear  = m === 0 ? y - 1 : y;
    const monthLabel = `${MONTHS[prevIdx]} ${prevYear}`;

    const report = await AnalyticsService.getFullReport('custom', prevStart, prevEnd);
    const { revenue, products, cancellation, users } = report;

    const fmt = (n) => Math.round(n || 0).toLocaleString();
    const top = products[0];
    const topLine = top
      ? `🏆 *Best Seller:* ${top.name.slice(0, 30)} (${top.count} orders — ${fmt(top.revenue)} KS)\n\n`
      : '';

    const text =
      `📊 *Monthly Revenue Report*\n` +
      `📅 _${monthLabel}_\n` +
      `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +

      `💰 *Revenue*\n` +
      `  Gross:   *${fmt(revenue.grossRevenue)} KS*\n` +
      `  Refunds: −${fmt(revenue.refunds.total)} KS (${revenue.refunds.count}×)\n` +
      `  Net:     *${fmt(revenue.netRevenue)} KS*\n` +
      `  Profit:  *~${fmt(revenue.netProfit)} KS* (${revenue.estimatedMarginPct}%)\n\n` +

      `📦 *Orders*\n` +
      `  ✅ Completed: *${revenue.orderCount}*\n` +
      `  ❌ Cancelled: ${cancellation.cancelled} (${cancellation.rate}% rate)\n` +
      `  💳 Top-ups:   ${revenue.topups.count}× — ${fmt(revenue.topups.total)} KS\n\n` +

      topLine +

      `👥 *Users*\n` +
      `  New:    *+${users.newUsers}*\n` +
      `  Active: *${users.activeUsers}*\n` +
      `  Total:  ${users.totalUsers}\n\n` +

      `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
      `_🤖 /analytics month — ပြည့်စုံတဲ့ dashboard ကြည့်ရန်_`;

    await safeSend(telegram, text);
    console.log(`[CronService] ✅ ${label} sent`);
    return { monthLabel, revenue, users };
  } catch (err) {
    console.error(`[CronService] ❌ ${label}:`, err.message);
    await safeSend(telegram, `❌ Monthly report generation failed: ${err.message}`);
    throw err;
  }
}

// ── Cron scheduler ────────────────────────────────────────────────────────────

let scheduledJobs = [];

function startCronJobs(telegram) {
  if (scheduledJobs.length) {
    console.warn('[CronService] Already started — skipping');
    return;
  }

  // 03:00 MMT = 20:30 UTC
  scheduledJobs.push(
    cron.schedule('30 20 * * *', () => archiveOldOrders(telegram), { timezone: 'UTC' })
  );

  // 03:05 MMT = 20:35 UTC
  scheduledJobs.push(
    cron.schedule('35 20 * * *', () => purgeExpiredPromos(telegram), { timezone: 'UTC' })
  );

  // 03:10 MMT = 20:40 UTC
  scheduledJobs.push(
    cron.schedule('40 20 * * *', () => logStaleScreenshots(telegram), { timezone: 'UTC' })
  );

  // 03:20 MMT = 20:50 UTC
  scheduledJobs.push(
    cron.schedule('50 20 * * *', () => flushCache(telegram), { timezone: 'UTC' })
  );

  // 06:00 MMT = 23:30 UTC
  scheduledJobs.push(
    cron.schedule('30 23 * * *', () => triggerBackup(telegram), { timezone: 'UTC' })
  );

  // Channel auto-posts: every 10 minutes
  scheduledJobs.push(
    cron.schedule('*/10 * * * *', () => tickChannelAutoPosts(telegram), { timezone: 'UTC' })
  );

  // Unpaid orders: release stock and refund wallet after reservation expiry.
  scheduledJobs.push(
    cron.schedule('*/5 * * * *', () => expirePendingReservations(telegram), { timezone: 'UTC' })
  );

  // Scheduled announcements + bot-user retention cleanup.
  scheduledJobs.push(
    cron.schedule('*/10 * * * *', () => tickAnnouncementAutomation(telegram), { timezone: 'UTC' })
  );

  // Giveaway expiry/cleanup: persisted timestamps make this restart-safe.
  scheduledJobs.push(
    cron.schedule('*/10 * * * *', () => cleanupGiveaways(telegram).catch((e) => console.error('[Cron] giveaways:', e.message)), { timezone: 'UTC' })
  );

  // 09:00 MMT = 02:30 UTC — premium account expiry reminders
  scheduledJobs.push(
    cron.schedule('30 2 * * *', () => notifyExpiringAccounts(telegram), { timezone: 'UTC' })
  );

  // 09:05 MMT = 02:35 UTC — birthday MC gifts
  scheduledJobs.push(
    cron.schedule('35 2 * * *', () => PromoPerksService.runBirthdayGifts(telegram).catch((e) => console.error('[Cron] birthday:', e.message)), { timezone: 'UTC' })
  );

  // 09:15 MMT = 02:45 UTC — win-back messages
  scheduledJobs.push(
    cron.schedule('45 2 * * *', () => PromoPerksService.runWinback(telegram).catch((e) => console.error('[Cron] winback:', e.message)), { timezone: 'UTC' })
  );

  // 09:30 MMT on the 1st = 03:00 UTC — monthly leaderboard prizes (previous month)
  scheduledJobs.push(
    cron.schedule('0 3 1 * *', () => PromoPerksService.awardMonthlyPrizes(telegram).catch((e) => console.error('[Cron] leaderboard:', e.message)), { timezone: 'UTC' })
  );

  // 09:20 MMT on the 1st = 02:50 UTC — monthly revenue auto-report to admin
  scheduledJobs.push(
    cron.schedule('50 2 1 * *', () => sendMonthlyRevenueReport(telegram), { timezone: 'UTC' })
  );

  console.log(`[CronService] ✅ 13 cron jobs scheduled (Archive/Promo/Screenshots/Cache/Backup/ChannelPosts/AnnounceAutomation/Giveaways/AccountExpiry/Birthday/Winback/Leaderboard/MonthlyReport)`);
}

function stopCronJobs() {
  scheduledJobs.forEach((j) => j.stop());
  scheduledJobs = [];
  console.log('[CronService] 🛑 All cron jobs stopped');
}

// ── Manual triggers (for admin testing) ──────────────────────────────────────

function getJobCount() {
  return scheduledJobs.length;
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  getJobCount,
  // Manual triggers exposed for admin commands
  manualArchive:         archiveOldOrders,
  manualPromo:           purgeExpiredPromos,
  manualScreens:         logStaleScreenshots,
  manualCache:           flushCache,
  manualBackup:          triggerBackup,
  manualChannelPosts:    tickChannelAutoPosts,
  manualGiveaways:       cleanupGiveaways,
  manualAnnouncementAutomation: tickAnnouncementAutomation,
  manualReservationExpiry: expirePendingReservations,
  manualMonthlyReport:   sendMonthlyRevenueReport,
};
