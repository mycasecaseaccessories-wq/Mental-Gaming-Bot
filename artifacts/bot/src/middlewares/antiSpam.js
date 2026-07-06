/**
 * AntiSpam Middleware
 *
 * Sliding-window rate limiter (per user, per minute).
 * Tracks spam strike count — on warningThreshold consecutive violations,
 * automatically issues a warning via UserManagementService.
 *
 * Owner + all admins (any role) are always exempt.
 * Admin status is cached in-memory for 5 minutes to avoid per-message DB hits.
 */

const { config } = require('../../config/settings');

// { userId → { count, windowStart, strikes, lastWarned } }
const requestMap = new Map();

// Admin exemption cache: Map<userId, { isAdmin: boolean, cachedAt: number }>
const adminCache = new Map();
const ADMIN_CACHE_TTL = 5 * 60_000; // 5 minutes

async function isAdminUser(userId) {
  if (userId === config.bot.adminId) return true;

  const now = Date.now();
  const cached = adminCache.get(userId);
  if (cached && now - cached.cachedAt < ADMIN_CACHE_TTL) {
    return cached.isAdmin;
  }

  try {
    const { isAnyAdmin } = require('./adminCheck');
    const result = await isAnyAdmin(userId);
    adminCache.set(userId, { isAdmin: result, cachedAt: now });
    return result;
  } catch {
    return false;
  }
}

function antiSpam() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    // Owner is always exempt (sync, no cache needed)
    if (userId === config.bot.adminId) return next();

    const now      = Date.now();
    const windowMs = 60_000;
    const maxReq   = config.antiSpam.maxRequestsPerMinute;
    const maxStrikes = config.antiSpam.warningThreshold;

    const rec = requestMap.get(userId);

    // Check if within limit first (fast path — no DB call needed)
    const withinLimit = !rec || now - rec.windowStart > windowMs || rec.count < maxReq;

    if (!withinLimit) {
      // Over limit — check if admin before blocking
      const exempt = await isAdminUser(userId);
      if (exempt) return next();

      // Not an admin — apply rate limit
      if (!requestMap.has(userId)) requestMap.set(userId, { count: 1, windowStart: now, strikes: 0, lastWarned: 0 });
      const r = requestMap.get(userId);
      r.strikes += 1;

      if (r.strikes >= maxStrikes && now - r.lastWarned > 5 * 60_000) {
        r.lastWarned = now;
        r.strikes    = 0;

        setImmediate(async () => {
          try {
            const { warnUser } = require('../services/UserManagementService');
            const result = await warnUser(userId, config.bot.adminId, 'Auto: excessive message rate');

            if (result.autoBanned) {
              await ctx.telegram.sendMessage(
                userId,
                '🚫 *Your account has been suspended* due to repeated spam violations.\n_Contact support to appeal._',
                { parse_mode: 'Markdown' }
              ).catch(() => {});
            } else {
              await ctx.telegram.sendMessage(
                userId,
                `⚠️ *Spam Warning (${result.user.warningsCount}/3)*\n\nYou are sending messages too quickly.\n_${3 - result.user.warningsCount} more warning(s) will result in a ban._`,
                { parse_mode: 'Markdown' }
              ).catch(() => {});
            }

            await ctx.telegram.sendMessage(
              config.bot.adminId,
              `🤖 *Auto Spam Warning Issued*\n\nUser: \`${userId}\`\nWarnings: ${result.user.warningsCount}/3`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          } catch {}
        });
      }

      console.warn(`[AntiSpam] User ${userId} rate limited (${r.count}/${maxReq}, strikes: ${r.strikes})`);
      return ctx.reply('🚫 Slow down! You are sending messages too fast.').catch(() => {});
    }

    // Within limit — update counter
    if (!requestMap.has(userId)) {
      requestMap.set(userId, { count: 1, windowStart: now, strikes: 0, lastWarned: 0 });
    } else {
      const r = requestMap.get(userId);
      if (now - r.windowStart > windowMs) {
        r.count       = 1;
        r.windowStart = now;
        r.strikes     = 0;
      } else {
        r.count += 1;
      }
    }

    return next();
  };
}

// Cleanup stale records every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [uid, rec] of requestMap.entries()) {
    if (now - rec.windowStart > 120_000) requestMap.delete(uid);
  }
  for (const [uid, rec] of adminCache.entries()) {
    if (now - rec.cachedAt > ADMIN_CACHE_TTL) adminCache.delete(uid);
  }
}, 120_000);

module.exports = { antiSpam };
