/**
 * maintenanceCheck — Bot-wide maintenance / holiday mode middleware.
 *
 * Maintenance Mode (full):
 *   All user commands are blocked. Shows countdown if maintenanceUntil is set.
 *   Admins bypass.
 *
 * Holiday Mode (light):
 *   Users can browse but cannot place orders or top up.
 *   The middleware injects ctx.holidayMode = true for order/topup handlers to check.
 *
 * Status is cached for CACHE_TTL_MS to avoid a DB hit on every message.
 */

const SystemStatus = require('../models/SystemStatus');
const { isAdmin } = require('../services/AdminService');

const CACHE_TTL_MS = 30_000; // refresh every 30 seconds

let _cache        = null;
let _cacheExpires = 0;

async function getCachedStatus() {
  if (_cache && Date.now() < _cacheExpires) return _cache;
  _cache        = await SystemStatus.get();
  _cacheExpires = Date.now() + CACHE_TTL_MS;
  return _cache;
}

/** Force-invalidate the cache (call after toggling maintenance/holiday). */
function invalidateCache() {
  _cache        = null;
  _cacheExpires = 0;
}

// ── Countdown formatter ────────────────────────────────────────────────────────
function formatCountdown(until) {
  if (!until) return null;
  const ms   = new Date(until).getTime() - Date.now();
  if (ms <= 0) return null;
  const h    = Math.floor(ms / 3_600_000);
  const m    = Math.floor((ms % 3_600_000) / 60_000);
  const s    = Math.floor((ms % 60_000) / 1_000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(' ') || '< 1m';
}

// ── Blocked actions in holiday mode ───────────────────────────────────────────
const HOLIDAY_BLOCKED_ACTIONS = new Set([
  'topup', 'order_scene', 'order_start', 'wallet_topup',
]);
const HOLIDAY_BLOCKED_COMMANDS = new Set(['topup', 'order']);

// ── Middleware ────────────────────────────────────────────────────────────────

function maintenanceCheck() {
  return async (ctx, next) => {
    const status = await getCachedStatus();

    // ── Maintenance Mode ────────────────────────────────────────────────────
    if (status.maintenanceMode) {
      // Auto-lift if maintenanceUntil has passed
      if (status.maintenanceUntil && new Date() > status.maintenanceUntil) {
        await SystemStatus.set({ maintenanceMode: false });
        invalidateCache();
        return next();
      }

      // Admins bypass
      const adminOk = await isAdmin(ctx.from?.id).catch(() => false);
      if (adminOk) return next();

      const countdown = formatCountdown(status.maintenanceUntil);
      const lines = [
        `🔧 *Scheduled Maintenance*`,
        ``,
        status.maintenanceMessage,
        countdown
          ? `\n⏳ *Estimated time remaining:* ${countdown}`
          : '',
        ``,
        `_We apologize for the inconvenience. Please try again shortly._`,
      ].filter((l) => l !== '');

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
      if (ctx.callbackQuery) await ctx.answerCbQuery('🔧 Maintenance in progress.').catch(() => {});
      return; // swallow update
    }

    // ── Holiday Mode ────────────────────────────────────────────────────────
    if (status.holidayMode) {
      // Auto-lift if holidayUntil has passed
      if (status.holidayUntil && new Date() > status.holidayUntil) {
        await SystemStatus.set({ holidayMode: false });
        invalidateCache();
        return next();
      }

      const adminOk = await isAdmin(ctx.from?.id).catch(() => false);
      if (!adminOk) {
        ctx.holidayMode    = true;
        ctx.holidayMessage = status.holidayMessage;
        ctx.holidayUntil   = status.holidayUntil;

        // Block order/topup commands immediately
        const cmd = ctx.message?.text?.split(/\s/)[0]?.replace('/', '').toLowerCase();
        const action = ctx.callbackQuery?.data?.split(':')[0];

        if (
          (cmd && HOLIDAY_BLOCKED_COMMANDS.has(cmd)) ||
          (action && HOLIDAY_BLOCKED_ACTIONS.has(action))
        ) {
          const until = status.holidayUntil
            ? `until *${new Date(status.holidayUntil).toLocaleDateString('en-GB')}*`
            : 'temporarily';
          await ctx.reply(
            `🎉 *Holiday Mode*\n\n${status.holidayMessage}\n\n` +
            `_Orders and top-ups are disabled ${until}._`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          if (ctx.callbackQuery) await ctx.answerCbQuery('🎉 Holiday mode — orders disabled.').catch(() => {});
          return;
        }
      }
    }

    return next();
  };
}

module.exports = { maintenanceCheck, invalidateCache };
