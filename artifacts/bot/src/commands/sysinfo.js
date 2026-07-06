/**
 * sysinfo — System resource monitoring command.
 *
 * /sysinfo       — Full system snapshot (Manager+)
 * /runbackup     — Manually trigger DB backup (Owner only)
 * /runcron       — Manually run all cron maintenance jobs (Owner only)
 * /flushcache    — Flush in-memory cache (Manager+)
 * /setbackupchan — Set backup Telegram channel (Owner only)
 */

const { Markup }      = require('telegraf');
const { requireRole, adminOnly } = require('../middlewares/adminCheck');
const CacheService    = require('../services/CacheService');
const BackupService   = require('../services/BackupService');
const SystemStatus    = require('../models/SystemStatus');
const Order           = require('../models/Order');
const { config }      = require('../../config/settings');

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600)  / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function loadBar(pct, width = 10) {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const icon = pct >= 85 ? '🔴' : pct >= 60 ? '🟡' : '🟢';
  return `${icon} \`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\` ${pct}%`;
}

function gatewayIcon(s) {
  return s === 'Online' ? '🟢' : s === 'Busy' ? '🟡' : '🔴';
}

// ── Main info builder ─────────────────────────────────────────────────────────

async function buildSysInfo() {
  const mongoose = require('mongoose');
  const os       = require('os');

  const [status, pendingOrders, recentPending] = await Promise.all([
    SystemStatus.get(),
    Order.countDocuments({ status: 'Pending' }),
    Order.find({ status: 'Pending' })
      .populate('userId', 'username telegramId')
      .populate('productId', 'name')
      .sort({ timestamp: -1 })
      .limit(5)
      .lean(),
  ]);

  // ── Process metrics ─────────────────────────────────────────────────────────
  const mem      = process.memoryUsage();
  const heapPct  = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const rssMB    = fmtMB(mem.rss);
  const heapUsed = fmtMB(mem.heapUsed);
  const heapMax  = fmtMB(mem.heapTotal);
  const extMB    = fmtMB(mem.external);

  const cpus     = os.cpus();
  const load     = os.loadavg(); // [1, 5, 15 min]
  const loadPct  = Math.round((load[0] / cpus.length) * 100);

  // ── Database ────────────────────────────────────────────────────────────────
  const dbStateNames = ['Disconnected', 'Connected', 'Connecting', 'Disconnecting'];
  const dbState      = mongoose.connection.readyState;
  const dbIcon       = dbState === 1 ? '🟢' : dbState === 2 ? '🟡' : '🔴';
  const dbStatus     = dbStateNames[dbState] || 'Unknown';

  // ── Cache ───────────────────────────────────────────────────────────────────
  const cache    = CacheService.getStats();

  // ── Backup metadata ─────────────────────────────────────────────────────────
  const { lastBackupAt, lastBackupSize } = BackupService.getLastBackupInfo();

  const backupLine = lastBackupAt
    ? `🗄 Last Backup: *${new Date(lastBackupAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT* (${lastBackupSize})`
    : `🗄 Last Backup: _None this session_`;

  // ── Stuck users (pending orders > 30 min) ──────────────────────────────────
  const stuckCutoff = new Date(Date.now() - 30 * 60_000);
  const stuckCount  = await Order.countDocuments({
    status:    'Pending',
    timestamp: { $lt: stuckCutoff },
  });

  const pendingLines = recentPending.slice(0, 4).map((o) => {
    const user = o.userId?.username ? `@${o.userId.username}` : `ID:${o.userId?.telegramId}`;
    const mins = Math.round((Date.now() - new Date(o.timestamp).getTime()) / 60_000);
    return `  • ${user} — ${o.productId?.name?.slice(0, 20) || 'Unknown'} (${mins}m ago)`;
  }).join('\n');

  // ── Gateway statuses ────────────────────────────────────────────────────────
  const gwLine = [
    `${gatewayIcon(status.kpayStatus)} KBZ`,
    `${gatewayIcon(status.waveStatus)} Wave`,
    `${gatewayIcon(status.ayaStatus)} AYA`,
    `${gatewayIcon(status.cbStatus)} CB`,
  ].join('  ');

  return (
    `🖥 *System Info*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +

    `⏱ *Process*\n` +
    `  Uptime: *${fmtUptime(Math.floor(process.uptime()))}*\n` +
    `  Node: ${process.version} | PID: ${process.pid}\n\n` +

    `💾 *Memory*\n` +
    `  Heap: ${loadBar(heapPct)} (${heapUsed}/${heapMax})\n` +
    `  RSS: ${rssMB} | External: ${extMB}\n\n` +

    `🔢 *CPU Load* (${cpus.length} cores)\n` +
    `  ${loadBar(Math.min(loadPct, 100))} (1min avg)\n` +
    `  1m: ${load[0].toFixed(2)} | 5m: ${load[1].toFixed(2)} | 15m: ${load[2].toFixed(2)}\n\n` +

    `${dbIcon} *Database*: ${dbStatus}\n\n` +

    `🗃 *Cache*\n` +
    `  Keys: ${cache.keys} | Hits: ${cache.hits.toLocaleString()} | Misses: ${cache.misses.toLocaleString()}\n` +
    `  Hit Rate: *${cache.hitRate}%*\n\n` +

    `${backupLine}\n\n` +

    `📦 *Orders*\n` +
    `  🟡 Pending: *${pendingOrders}*` +
    (stuckCount ? ` | ⚠️ Stuck >30m: *${stuckCount}*` : '') + '\n' +
    (pendingLines ? `${pendingLines}\n` : '') + '\n' +

    `💳 *Payment Gateways*\n` +
    `  ${gwLine}\n` +
    (status.gatewayNote ? `  📝 _${status.gatewayNote}_\n` : '') + '\n' +

    `🕐 _${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT_\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\``
  );
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerSysInfo(bot) {

  bot.command('sysinfo', requireRole('MANAGER'), async (ctx) => {
    const wait = await ctx.reply('⏳ Gathering system info…');
    try {
      const text = await buildSysInfo();
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Refresh',     'sysinfo_refresh'),
            Markup.button.callback('🗃 Flush Cache',  'sysinfo_flush_cache'),
          ],
          [
            Markup.button.callback('🗄 Run Backup',   'sysinfo_backup'),
            Markup.button.callback('🔧 Run Cron',     'sysinfo_cron'),
          ],
        ]),
      });
    } catch (err) {
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ ${err.message}`);
    }
  });

  bot.action('sysinfo_refresh', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Refreshing…');
    try {
      const text = await buildSysInfo();
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Refresh',     'sysinfo_refresh'),
            Markup.button.callback('🗃 Flush Cache',  'sysinfo_flush_cache'),
          ],
          [
            Markup.button.callback('🗄 Run Backup',   'sysinfo_backup'),
            Markup.button.callback('🔧 Run Cron',     'sysinfo_cron'),
          ],
        ]),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action('sysinfo_flush_cache', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Flushing cache…');
    const stats = CacheService.getStats();
    CacheService.flushAll();
    await ctx.reply(`🗃 Cache flushed — *${stats.keys}* keys cleared.\n_Next request to shop/rates will fetch from DB._`, { parse_mode: 'Markdown' });
  });

  bot.action('sysinfo_backup', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Starting backup…');
    const wait = await ctx.reply('🗄 _Running database backup… this may take 10-30 seconds._', { parse_mode: 'Markdown' });
    try {
      const { runBackup } = require('../services/BackupService');
      const { filename, sizeMB, totalDocs } = await runBackup(ctx.telegram);
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(`✅ Backup complete: *${filename}* (${sizeMB} MB, ${totalDocs.toLocaleString()} docs)`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ Backup failed: ${err.message}`);
    }
  });

  bot.action('sysinfo_cron', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Running maintenance jobs…');
    const wait = await ctx.reply('🔧 _Running cron maintenance jobs…_', { parse_mode: 'Markdown' });
    try {
      const CronService = require('../services/CronService');
      const [archive, promos, screens, cacheFlush] = await Promise.all([
        CronService.manualArchive(ctx.telegram),
        CronService.manualPromo(ctx.telegram),
        CronService.manualScreens(ctx.telegram),
        CronService.manualCache(ctx.telegram),
      ]);
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(
        `✅ *Cron jobs complete*\n\n` +
        `🗂 Archived: ${archive.archived} orders\n` +
        `🎟 Promos deactivated: ${promos.deactivated}\n` +
        `📸 Stale screenshots: ${screens.stale}\n` +
        `🗃 Cache keys flushed: ${cacheFlush.clearedKeys}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ Cron error: ${err.message}`);
    }
  });

  // ── /runbackup (direct command) ─────────────────────────────────────────────

  bot.command('runbackup', adminOnly(), async (ctx) => {
    const wait = await ctx.reply('🗄 _Starting database backup…_', { parse_mode: 'Markdown' });
    try {
      const { runBackup } = require('../services/BackupService');
      const { filename, sizeMB, totalDocs, duration } = await runBackup(ctx.telegram);
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(
        `✅ *Backup complete*\n` +
        `📄 File: \`${filename}\`\n` +
        `📦 Size: *${sizeMB} MB* | Docs: *${totalDocs.toLocaleString()}* | Time: ${duration}s`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ Backup failed: ${err.message}`);
    }
  });

  // ── /runcron (direct command) ────────────────────────────────────────────────

  bot.command('runcron', adminOnly(), async (ctx) => {
    const wait = await ctx.reply('🔧 _Running all maintenance jobs…_', { parse_mode: 'Markdown' });
    try {
      const CronService = require('../services/CronService');
      const [archive, promos, screens] = await Promise.all([
        CronService.manualArchive(ctx.telegram),
        CronService.manualPromo(ctx.telegram),
        CronService.manualScreens(ctx.telegram),
      ]);
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(
        `🔧 *Maintenance Complete*\n\n` +
        `🗂 Orders archived: *${archive.archived}*\n` +
        `🎟 Promos deactivated: *${promos.deactivated}*\n` +
        `📸 Stale screenshots: *${screens.stale}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ ${err.message}`);
    }
  });

  // ── /flushcache ───────────────────────────────────────────────────────────────

  bot.command('flushcache', requireRole('MANAGER'), async (ctx) => {
    const stats = CacheService.getStats();
    CacheService.flushAll();
    await ctx.reply(
      `🗃 *Cache Flushed*\n\n` +
      `Cleared *${stats.keys}* keys\n` +
      `Previous hit rate: *${stats.hitRate}%* (${stats.hits.toLocaleString()} hits / ${stats.misses.toLocaleString()} misses)\n\n` +
      `_Products and rates will be freshly fetched from DB on next request._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setbackupchan ────────────────────────────────────────────────────────────

  bot.command('setbackupchan', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      const status = await SystemStatus.get();
      return ctx.reply(
        `🗄 *Backup Channel*\n\n` +
        `Current: \`${status.backupChannelId || 'Not set (backups go to your DM)'}\`\n\n` +
        `Usage: \`/setbackupchan @channelname\` or \`/setbackupchan -100xxxxx\`\n` +
        `Clear: \`/setbackupchan clear\``,
        { parse_mode: 'Markdown' }
      );
    }

    const val = args[0] === 'clear' ? null : args[0];
    await SystemStatus.set({ backupChannelId: val }, ctx.from.id);
    await ctx.reply(
      val
        ? `✅ Backup channel set to \`${val}\`\n_Encrypted backups will be sent here at 06:00 MMT daily._`
        : `✅ Backup channel cleared. Backups will be sent to your DM.`,
      { parse_mode: 'Markdown' }
    );
  });
};
