/**
 * Feature Gate Admin — Control which reward features are live.
 *
 * How it works:
 *   - When `featureGateEnabled = true` (default), reward features are locked
 *     until the user count reaches `unlockTargetUsers` (default 500).
 *   - Once the target is reached, all gated features auto-unlock.
 *   - Owner/Manager can manually force-unlock or force-lock individual features
 *     regardless of user count.
 *   - `/togglegatemaster` turns the entire gate system on/off.
 *
 * Commands (Owner only unless noted):
 *   /featuregate                — show gate dashboard
 *   /setgatetarget <n>          — change user count target
 *   /unlockfeature <id>         — force-unlock one feature (Owner)
 *   /lockfeature <id>           — force-lock one feature (Owner)
 *   /resetfeature <id>          — remove manual override (Owner)
 *
 * Callback actions:
 *   fg_toggle:<id>              — toggle manual lock/unlock
 *   fg_reset:<id>               — reset to auto
 *   fg_master                   — toggle featureGateEnabled
 *   fg_refresh                  — refresh dashboard
 */

const { Markup } = require('telegraf');
const { adminOnly, requireRole } = require('../middlewares/adminCheck');
const SystemStatus = require('../models/SystemStatus');
const User = require('../models/User');

// ── Gated feature definitions ─────────────────────────────────────────────────

const GATED_FEATURES = [
  { id: 'referral',        label: '🤝 Referral Program',     desc: 'User referral & commissions' },
  { id: 'tier',            label: '🏆 Loyalty Tiers',         desc: 'Bronze → Diamond tier system' },
  { id: 'mental_coin',     label: '🪙 Mental Coins (earn)',   desc: 'MC earning from orders/check-ins' },
  { id: 'mc_exchange',     label: '💱 MC Exchange',           desc: 'Redeem MC as KS discount' },
  { id: 'lucky_spin',      label: '🎰 Lucky Spin',            desc: 'Daily spin wheel' },
  { id: 'leaderboard',     label: '📊 Leaderboard',           desc: 'Global user rankings' },
  { id: 'achievements',    label: '🏅 Achievements',          desc: 'User achievement badges' },
  { id: 'daily_missions',  label: '📅 Daily Missions',        desc: 'Daily task challenges' },
  { id: 'weekly_missions', label: '📆 Weekly Missions',       desc: 'Weekly task challenges' },
  { id: 'yearly_rewards',  label: '🎁 Yearly Rewards',        desc: 'Annual loyalty rewards' },
];

function featureById(id) {
  return GATED_FEATURES.find((f) => f.id === id) ?? { id, label: id, desc: '' };
}

// ── Resolve gate status ───────────────────────────────────────────────────────

async function resolveGateStatus() {
  const status = await SystemStatus.getStatus();
  const totalUsers = await User.countDocuments({});

  const gateEnabled   = status.featureGateEnabled ?? true;
  const target        = status.unlockTargetUsers   ?? 500;
  const unlocked      = status.manuallyUnlockedFeatures ?? [];
  const locked        = status.manuallyLockedFeatures   ?? [];
  const allAutoUnlocked = !gateEnabled || totalUsers >= target;

  const features = GATED_FEATURES.map((f) => {
    let state;
    if (locked.includes(f.id))   state = 'locked';
    else if (unlocked.includes(f.id)) state = 'unlocked';
    else state = allAutoUnlocked ? 'auto_unlocked' : 'auto_locked';

    return { ...f, state };
  });

  return { gateEnabled, target, totalUsers, allAutoUnlocked, features, unlocked, locked };
}

// ── Dashboard text ────────────────────────────────────────────────────────────

function dashboardText({ gateEnabled, target, totalUsers, allAutoUnlocked, features }) {
  const masterStatus = gateEnabled ? '🔒 Gate ON' : '🔓 Gate OFF (all unlocked)';
  const progress = gateEnabled
    ? `${totalUsers.toLocaleString()} / ${target.toLocaleString()} users`
    : `${totalUsers.toLocaleString()} users (gate disabled)`;

  const STATE_ICON = {
    locked:        '🔴',
    unlocked:      '🟢',
    auto_unlocked: '✅',
    auto_locked:   '⏳',
  };
  const STATE_LABEL = {
    locked:        'Force Locked',
    unlocked:      'Force Unlocked',
    auto_unlocked: 'Auto Unlocked',
    auto_locked:   'Waiting',
  };

  const featureLines = features
    .map((f) => `${STATE_ICON[f.state]} *${f.label}*  _${STATE_LABEL[f.state]}_`)
    .join('\n');

  return (
    `🎛 *Feature Gate Dashboard*\n\n` +
    `Master: *${masterStatus}*\n` +
    `Progress: ${progress}${allAutoUnlocked && gateEnabled ? ' ✅ Target reached!' : ''}\n\n` +
    `*Features:*\n${featureLines}\n\n` +
    `Legend:\n` +
    `✅ Auto-unlocked  ⏳ Waiting for target\n` +
    `🟢 Force-unlocked  🔴 Force-locked`
  );
}

// ── Dashboard inline keyboard ─────────────────────────────────────────────────

function dashboardKeyboard({ gateEnabled, features }) {
  const rows = [];

  // Master toggle
  rows.push([
    Markup.button.callback(
      gateEnabled ? '🔓 Disable Gate System' : '🔒 Enable Gate System',
      'fg_master'
    ),
  ]);

  // Feature rows (2 per row: toggle + reset)
  for (const f of features) {
    const isManualLocked   = f.state === 'locked';
    const isManualUnlocked = f.state === 'unlocked';
    const toggleLabel = isManualLocked   ? `🟢 Unlock ${f.id}`
                      : isManualUnlocked ? `🔴 Lock ${f.id}`
                      : f.state === 'auto_locked' ? `🟢 Force-unlock ${f.id}`
                      : `🔴 Force-lock ${f.id}`;
    const btn = [Markup.button.callback(toggleLabel, `fg_toggle:${f.id}`)];
    if (isManualLocked || isManualUnlocked) {
      btn.push(Markup.button.callback(`↩ Reset ${f.id}`, `fg_reset:${f.id}`));
    }
    rows.push(btn);
  }

  rows.push([Markup.button.callback('🔄 Refresh', 'fg_refresh')]);

  return Markup.inlineKeyboard(rows);
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerFeatureGate(bot) {

  // ── /featuregate ──────────────────────────────────────────────────────────

  bot.command('featuregate', requireRole('MANAGER'), async (ctx) => {
    const data = await resolveGateStatus();
    await ctx.reply(dashboardText(data), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(data),
    });
  });

  // ── /setgatetarget <n> ────────────────────────────────────────────────────

  bot.command('setgatetarget', adminOnly(), async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1];
    const n = parseInt(arg, 10);
    if (!n || n < 1 || n > 1_000_000) {
      return ctx.reply('❌ Usage: `/setgatetarget <number>`\nExample: `/setgatetarget 500`', {
        parse_mode: 'Markdown',
      });
    }
    await SystemStatus.findOneAndUpdate(
      {},
      { $set: { unlockTargetUsers: n } },
      { upsert: true }
    );
    const totalUsers = await User.countDocuments({});
    const reached = totalUsers >= n;
    await ctx.reply(
      `✅ Unlock target set to *${n.toLocaleString()} users*.\n` +
      `Current users: ${totalUsers.toLocaleString()}${reached ? ' — 🎉 Target already reached!' : ''}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /unlockfeature <id> ───────────────────────────────────────────────────

  bot.command('unlockfeature', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (!id) {
      return ctx.reply(
        `❌ Usage: \`/unlockfeature <id>\`\n\nFeature IDs:\n${GATED_FEATURES.map((f) => `• \`${f.id}\``).join('\n')}`,
        { parse_mode: 'Markdown' }
      );
    }
    const feature = featureById(id);
    await SystemStatus.findOneAndUpdate(
      {},
      { $addToSet: { manuallyUnlockedFeatures: id }, $pull: { manuallyLockedFeatures: id } },
      { upsert: true }
    );
    await ctx.reply(`🟢 *${feature.label}* is now force-unlocked.`, { parse_mode: 'Markdown' });
  });

  // ── /lockfeature <id> ─────────────────────────────────────────────────────

  bot.command('lockfeature', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (!id) {
      return ctx.reply(
        `❌ Usage: \`/lockfeature <id>\`\n\nFeature IDs:\n${GATED_FEATURES.map((f) => `• \`${f.id}\``).join('\n')}`,
        { parse_mode: 'Markdown' }
      );
    }
    const feature = featureById(id);
    await SystemStatus.findOneAndUpdate(
      {},
      { $addToSet: { manuallyLockedFeatures: id }, $pull: { manuallyUnlockedFeatures: id } },
      { upsert: true }
    );
    await ctx.reply(`🔴 *${feature.label}* is now force-locked.`, { parse_mode: 'Markdown' });
  });

  // ── /resetfeature <id> ────────────────────────────────────────────────────

  bot.command('resetfeature', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (!id) {
      return ctx.reply('Usage: `/resetfeature <id>`', { parse_mode: 'Markdown' });
    }
    const feature = featureById(id);
    await SystemStatus.findOneAndUpdate(
      {},
      { $pull: { manuallyUnlockedFeatures: id, manuallyLockedFeatures: id } },
      { upsert: true }
    );
    await ctx.reply(
      `↩ *${feature.label}* override removed — now follows auto gate rules.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Callback: fg_master ───────────────────────────────────────────────────

  bot.action('fg_master', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const status = await SystemStatus.getStatus();
    const newVal = !(status.featureGateEnabled ?? true);
    await SystemStatus.findOneAndUpdate(
      {},
      { $set: { featureGateEnabled: newVal } },
      { upsert: true }
    );
    const data = await resolveGateStatus();
    await ctx.editMessageText(dashboardText(data), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(data),
    });
  });

  // ── Callback: fg_toggle:<id> ─────────────────────────────────────────────

  bot.action(/^fg_toggle:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const status = await SystemStatus.getStatus();
    const unlocked = status.manuallyUnlockedFeatures ?? [];
    const locked   = status.manuallyLockedFeatures   ?? [];

    if (locked.includes(id)) {
      // Was force-locked → unlock it
      await SystemStatus.findOneAndUpdate(
        {},
        { $pull: { manuallyLockedFeatures: id }, $addToSet: { manuallyUnlockedFeatures: id } },
        { upsert: true }
      );
    } else if (unlocked.includes(id)) {
      // Was force-unlocked → lock it
      await SystemStatus.findOneAndUpdate(
        {},
        { $pull: { manuallyUnlockedFeatures: id }, $addToSet: { manuallyLockedFeatures: id } },
        { upsert: true }
      );
    } else {
      // Auto state — check if currently unlocked or locked
      const totalUsers = await User.countDocuments({});
      const gateEnabled = status.featureGateEnabled ?? true;
      const target = status.unlockTargetUsers ?? 500;
      const isCurrentlyUnlocked = !gateEnabled || totalUsers >= target;
      if (isCurrentlyUnlocked) {
        // Auto-unlocked → force lock
        await SystemStatus.findOneAndUpdate(
          {},
          { $addToSet: { manuallyLockedFeatures: id } },
          { upsert: true }
        );
      } else {
        // Auto-locked → force unlock
        await SystemStatus.findOneAndUpdate(
          {},
          { $addToSet: { manuallyUnlockedFeatures: id } },
          { upsert: true }
        );
      }
    }

    const data = await resolveGateStatus();
    await ctx.editMessageText(dashboardText(data), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(data),
    });
  });

  // ── Callback: fg_reset:<id> ──────────────────────────────────────────────

  bot.action(/^fg_reset:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Override removed');
    const id = ctx.match[1];
    await SystemStatus.findOneAndUpdate(
      {},
      { $pull: { manuallyUnlockedFeatures: id, manuallyLockedFeatures: id } },
      { upsert: true }
    );
    const data = await resolveGateStatus();
    await ctx.editMessageText(dashboardText(data), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(data),
    });
  });

  // ── Callback: fg_refresh ─────────────────────────────────────────────────

  bot.action('fg_refresh', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Refreshed');
    const data = await resolveGateStatus();
    await ctx.editMessageText(dashboardText(data), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(data),
    });
  });
};
