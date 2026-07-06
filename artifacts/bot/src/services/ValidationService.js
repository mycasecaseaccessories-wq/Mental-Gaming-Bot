/**
 * ValidationService — Game ID format validation + player nickname lookup.
 *
 * Two layers:
 *   1. Regex validation  — fast, offline, catches obviously wrong IDs
 *   2. Nickname lookup   — HTTP call to provider/public API, confirms ID exists
 *
 * Usage in order flow:
 *   const { valid, nickname, message } = await validate(game, playerId, zoneId);
 *   if (!valid) → show error + ask user to re-enter
 *   if (nickname) → show "Confirm: playing as <nickname>?" before payment
 */

const axios = require('axios');

// ── Game validator registry ───────────────────────────────────────────────────
//
// Each entry defines:
//   regex       — { playerId, zoneId? }  format rules
//   zoneRequired — whether zone ID is mandatory for this game
//   example      — shown to users when format is wrong
//   lookup       — async fn(playerId, zoneId) → { valid, nickname, error }

const GAME_VALIDATORS = {

  'Mobile Legends': {
    slug:         'mlbb',
    zoneRequired: true,
    regex: {
      playerId: /^\d{6,12}$/,
      zoneId:   /^\d{3,5}$/,
    },
    example: 'Player ID: 12345678 | Zone ID: 2501',
    lookup: lookupMLBB,
  },

  'Free Fire': {
    slug:         'freefire',
    zoneRequired: false,
    regex: {
      playerId: /^\d{9,12}$/,
      zoneId:   null,
    },
    example: 'UID: 123456789 (9-12 digits)',
    lookup: lookupFreeFire,
  },

  'PUBG Mobile': {
    slug:         'pubgm',
    zoneRequired: false,
    regex: {
      playerId: /^\d{7,20}$/,
      zoneId:   null,
    },
    example: 'UID: 5123456789',
    lookup: null, // No reliable public API
  },

  'Genshin Impact': {
    slug:         'genshin',
    zoneRequired: false,
    regex: {
      playerId: /^[1-9]\d{8}$/,  // 9 digits, first digit = server region
      zoneId:   null,
    },
    example: 'UID: 123456789 (9 digits, starts with server number)',
    lookup: null,
  },

  'Valorant': {
    slug:         'valorant',
    zoneRequired: false,
    regex: {
      playerId: /^.{3,24}#[A-Za-z0-9]{3,5}$/, // RiotID#tag format
      zoneId:   null,
    },
    example: 'Riot ID: PlayerName#1234',
    lookup: null,
  },

  'Google Play': {
    slug:         'googleplay',
    zoneRequired: false,
    regex: {
      playerId: null, // No player ID needed — digital code delivery
      zoneId:   null,
    },
    example: 'No Game ID required — code sent automatically',
    lookup: null,
  },

  'Steam': {
    slug:         'steam',
    zoneRequired: false,
    regex: {
      playerId: null,
      zoneId:   null,
    },
    example: 'No Game ID required — code sent automatically',
    lookup: null,
  },
};

// ── Fuzzy game name matching ──────────────────────────────────────────────────

function findValidator(gameName) {
  if (!gameName) return null;
  const lower = gameName.toLowerCase();
  for (const [key, val] of Object.entries(GAME_VALIDATORS)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return { key, ...val };
    }
  }
  return null;
}

// ── Main validate function ────────────────────────────────────────────────────

async function validateGameId(gameName, playerId, zoneId) {
  const validator = findValidator(gameName);

  // Unknown game — allow through (admin will verify manually)
  if (!validator) {
    return {
      valid:    true,
      nickname: null,
      message:  null,
      source:   'passthrough',
    };
  }

  // Digital code products don't need a game ID
  if (validator.regex.playerId === null) {
    return { valid: true, nickname: null, message: null, source: 'digital' };
  }

  // ── Regex checks ────────────────────────────────────────────────────────────
  if (!playerId || !validator.regex.playerId.test(playerId.trim())) {
    return {
      valid:   false,
      nickname: null,
      message: `❌ Invalid *${gameName}* Player ID format.\n_Example: ${validator.example}_`,
      source:  'regex',
    };
  }

  if (validator.zoneRequired && (!zoneId || !validator.regex.zoneId?.test(zoneId.trim()))) {
    return {
      valid:   false,
      nickname: null,
      message: `❌ Invalid *${gameName}* Zone ID format.\n_Example: ${validator.example}_`,
      source:  'regex',
    };
  }

  // ── Nickname lookup ──────────────────────────────────────────────────────────
  if (validator.lookup) {
    try {
      const result = await validator.lookup(playerId.trim(), zoneId?.trim() || '');
      if (result.nickname) {
        return {
          valid:    true,
          nickname: result.nickname,
          message:  null,
          source:   'api',
        };
      }
      if (!result.valid) {
        return {
          valid:   false,
          nickname: null,
          message: `❌ *${gameName}* Player ID not found. Please check your ID.\n_${result.error || 'ID does not exist'}_`,
          source:  'api',
        };
      }
    } catch (err) {
      // Lookup failed (network error) — fall through, allow manual verification
      console.warn(`[ValidationService] Lookup failed for ${gameName}: ${err.message}`);
    }
  }

  // Regex passed, no lookup available or lookup failed gracefully
  return { valid: true, nickname: null, message: null, source: 'regex' };
}

// ── MLBB nickname lookup ──────────────────────────────────────────────────────
// Uses the SmileOne public check endpoint (no auth needed for basic verification)

async function lookupMLBB(playerId, zoneId) {
  try {
    const { data } = await axios.post(
      'https://order.smile.one/smileone/checkrole',
      { role_id: playerId, zone_id: zoneId },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    );

    if (data?.status === 'success' && data?.role_name) {
      return { valid: true, nickname: data.role_name, error: null };
    }
    return { valid: false, nickname: null, error: data?.message || 'Player not found' };
  } catch (err) {
    // Try fallback unofficial API
    return lookupMLBBFallback(playerId, zoneId);
  }
}

async function lookupMLBBFallback(playerId, zoneId) {
  try {
    const { data } = await axios.get(
      `https://api.funcs.net/mlbb/nickname/${playerId}/${zoneId}`,
      { timeout: 8000 }
    );
    if (data?.nickname) {
      return { valid: true, nickname: data.nickname, error: null };
    }
    return { valid: false, nickname: null, error: 'Player not found' };
  } catch {
    // Both lookups failed — pass through, allow manual check
    return { valid: true, nickname: null, error: null };
  }
}

// ── Free Fire nickname lookup ─────────────────────────────────────────────────

async function lookupFreeFire(playerId) {
  try {
    const { data } = await axios.get(
      `https://api.funcs.net/freefire/nickname/${playerId}`,
      { timeout: 8000 }
    );
    if (data?.nickname) {
      return { valid: true, nickname: data.nickname, error: null };
    }
    return { valid: false, nickname: null, error: 'UID not found' };
  } catch {
    return { valid: true, nickname: null, error: null }; // graceful passthrough
  }
}

// ── Format validation message for users ──────────────────────────────────────

function formatValidationResult(gameName, result) {
  if (!result.valid) return result.message;

  if (result.nickname) {
    return (
      `✅ *Player Verified!*\n\n` +
      `👤 Nickname: *${result.nickname}*\n\n` +
      `_Is this the correct account?_`
    );
  }

  return null; // silent success — no confirmation message needed
}

// ── Get format hint for a game ────────────────────────────────────────────────

function getFormatHint(gameName) {
  const v = findValidator(gameName);
  if (!v) return null;
  return v.example;
}

function isZoneRequired(gameName) {
  const v = findValidator(gameName);
  return v?.zoneRequired || false;
}

module.exports = {
  validateGameId,
  formatValidationResult,
  getFormatHint,
  isZoneRequired,
  GAME_VALIDATORS,
};
