/**
 * StyleService — Seasonal / Event Theme Engine.
 *
 * Stores the active seasonal theme in SystemStatus.seasonalTheme.
 * Works alongside the per-user ThemeService (light/dark/auto) — this layer
 * adds event-specific decorations on top of the UI theme.
 *
 * Available themes:
 *   standard      — Default professional look
 *   thingyan      — 💦 Myanmar Thingyan Water Festival
 *   christmas     — 🎄 Christmas & New Year
 *   lunarnewyear  — 🧧 Lunar / Chinese New Year
 *   eid           — 🌙 Eid Mubarak
 *   custom        — Admin-configured with custom emoji and label
 *
 * Admin commands:  /setseason  /seasonlist  /previewseason
 */

const CacheService = require('./CacheService');

// ── Season definitions ────────────────────────────────────────────────────────

const SEASONS = {
  standard: {
    id:           'standard',
    label:        '🎮 Standard',
    headerEmoji:  '🎮',
    bannerTop:    `🎮 *Mental Gaming Store* 🎮`,
    eventLine:    null,
    greeting:     'Your go-to store for game credits, top-ups & gift cards.',
    footerTag:    'Mental Gaming Store',
    accent:       '🎯',
  },
  thingyan: {
    id:           'thingyan',
    label:        '💦 Thingyan Water Festival',
    headerEmoji:  '💦',
    bannerTop:    `💦🏮 *Mental Gaming Store* 🏮💦`,
    eventLine:    `🏮 *Happy Thingyan Water Festival!* ကြိုဆိုပါတယ် 🏮`,
    greeting:     'May the new year wash away all worries and bring you joy!',
    footerTag:    '🌊 Celebrate the New Year with us!',
    accent:       '💦',
  },
  christmas: {
    id:           'christmas',
    label:        '🎄 Christmas & New Year',
    headerEmoji:  '🎄',
    bannerTop:    `❄️🎄 *Mental Gaming Store* 🎄❄️`,
    eventLine:    `🎄 *Merry Christmas & Happy New Year!* 🎁`,
    greeting:     "Season's greetings — wishing you joy, gifts, and great games!",
    footerTag:    "🎅 Season's Greetings from the MGS Family",
    accent:       '⛄',
  },
  lunarnewyear: {
    id:           'lunarnewyear',
    label:        '🧧 Lunar New Year',
    headerEmoji:  '🧧',
    bannerTop:    `🧧🐉 *Mental Gaming Store* 🐉🧧`,
    eventLine:    `🧧 *Happy Lunar New Year!* 新年快乐 恭喜发财 🎆`,
    greeting:     'May this year bring you prosperity, luck, and epic wins!',
    footerTag:    '🎊 Wishing you wealth and happiness!',
    accent:       '🔴',
  },
  eid: {
    id:           'eid',
    label:        '🌙 Eid Mubarak',
    headerEmoji:  '🌙',
    bannerTop:    `🌙⭐ *Mental Gaming Store* ⭐🌙`,
    eventLine:    `🌙 *Eid Mubarak!* — عيد مبارك ⭐`,
    greeting:     'Wishing you and your family peace, blessings, and joyful celebrations.',
    footerTag:    '🌙 From all of us at Mental Gaming Store',
    accent:       '✨',
  },
  custom: {
    id:           'custom',
    label:        '🎉 Custom Event',
    headerEmoji:  '🎉',
    bannerTop:    `🎉✨ *Mental Gaming Store* ✨🎉`,
    eventLine:    `🎉 *Special Event is Live!* 🎊`,
    greeting:     'Something special is happening — join the celebration!',
    footerTag:    '✨ Mental Gaming Store — Special Edition',
    accent:       '🎊',
  },
};

// ── Cache key ─────────────────────────────────────────────────────────────────

const SEASON_CACHE_KEY = 'style:active_season';
const SEASON_CACHE_TTL = 120; // 2 minutes

// ── Theme fetcher ─────────────────────────────────────────────────────────────

/**
 * Returns the active seasonal theme config.
 * Reads from SystemStatus (with 2-min cache).
 */
async function getActiveSeason() {
  const cached = CacheService._cache.get(SEASON_CACHE_KEY);
  if (cached) return cached;

  const SystemStatus = require('../models/SystemStatus');
  const status = await SystemStatus.get();
  const id = status.seasonalTheme || 'standard';

  let season = SEASONS[id] || SEASONS.standard;

  // For 'custom', overlay admin-configured values
  if (id === 'custom') {
    season = {
      ...season,
      label:       status.customSeasonLabel    || season.label,
      eventLine:   status.customSeasonGreeting
        ? `${status.customSeasonEmoji || '🎉'} *${status.customSeasonGreeting}*`
        : season.eventLine,
      headerEmoji: status.customSeasonEmoji    || season.headerEmoji,
      bannerTop:   status.customSeasonEmoji
        ? `${status.customSeasonEmoji} *Mental Gaming Store* ${status.customSeasonEmoji}`
        : season.bannerTop,
      greeting:    status.customSeasonGreeting || season.greeting,
    };
  }

  CacheService._cache.set(SEASON_CACHE_KEY, season, SEASON_CACHE_TTL);
  return season;
}

function invalidateSeason() {
  CacheService._cache.del(SEASON_CACHE_KEY);
}

// ── Message builders ──────────────────────────────────────────────────────────

/**
 * Builds the welcome message header for /start.
 * Returns a multi-line string to inject into the welcome message.
 */
function buildWelcomeHeader(name, tier, season) {
  const tierBadge = { Silver: '🥈', Gold: '🥇', Platinum: '💎' };
  const badge = tierBadge[tier] || '🥈';
  const lines = [season.bannerTop, ''];

  if (season.eventLine) {
    lines.push(season.eventLine, '');
  }

  lines.push(
    `👋 Welcome back, *${name}*! ${badge}`,
    season.greeting,
  );

  return lines.join('\n');
}

/**
 * Builds the welcome header for a FIRST-TIME user (shown before onboarding).
 */
function buildFirstTimeHeader(name, season) {
  const lines = [season.bannerTop, ''];

  if (season.eventLine) {
    lines.push(season.eventLine, '');
  }

  lines.push(
    `🌟 Welcome, *${name}*!`,
    `You've just joined *Mental Gaming Store* — Myanmar's go-to gaming credit store.`,
    '',
    `${season.accent} ${season.greeting}`,
  );

  return lines.join('\n');
}

/**
 * Wraps an admin section title with seasonal decoration.
 */
function buildSeasonalHeader(title, season) {
  return `${season.headerEmoji} *${title}*`;
}

/** Preview text for /previewseason command. */
function buildPreview(season) {
  return (
    `${season.bannerTop}\n\n` +
    (season.eventLine ? `${season.eventLine}\n\n` : '') +
    `_${season.greeting}_\n\n` +
    `📌 Tag: ${season.footerTag}`
  );
}

// ── Available season list ─────────────────────────────────────────────────────

function getSeasonList() {
  return Object.values(SEASONS);
}

module.exports = {
  SEASONS,
  getActiveSeason,
  invalidateSeason,
  buildWelcomeHeader,
  buildFirstTimeHeader,
  buildSeasonalHeader,
  buildPreview,
  getSeasonList,
};
