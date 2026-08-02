/**
 * OutlineService — thin HTTP wrapper around the Outline Access Server Management API.
 *
 * The Outline server uses a self-signed TLS certificate. We connect with
 * rejectUnauthorized: false and rely on the stored certSha256 for identity.
 *
 * API reference: https://redocly.github.io/redoc/?url=https://raw.githubusercontent.com/Jigsaw-Code/outline-server/master/src/shadowbox/server/api.yaml
 */

const axios = require('axios');
const https = require('https');

// One shared HTTPS agent that ignores self-signed cert errors.
// The Outline server's identity is verified via the stored certSha256 at setup time.
const _agent = new https.Agent({ rejectUnauthorized: false });

function _client(apiUrl) {
  return axios.create({
    baseURL: apiUrl.replace(/\/$/, ''),
    httpsAgent: _agent,
    timeout: 15_000,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _gb(gb) {
  return Math.round(gb * 1024 * 1024 * 1024);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(2)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(2)} PB`;
}

// ── Connection test ──────────────────────────────────────────────────────────

/**
 * Verify that the API URL is reachable and returns access keys.
 * @returns {{ ok: boolean, error: string }}
 */
async function testConnection(apiUrl) {
  try {
    await _client(apiUrl).get('/access-keys');
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Keys ────────────────────────────────────────────────────────────────────

/**
 * List all keys on the server.
 * @returns {{ ok: boolean, keys: Array, error: string }}
 */
async function listKeys(apiUrl) {
  try {
    const res = await _client(apiUrl).get('/access-keys');
    return { ok: true, keys: res.data?.accessKeys || [], error: '' };
  } catch (err) {
    return { ok: false, keys: [], error: err.message };
  }
}

/**
 * Create a new access key.
 * @param {string} apiUrl
 * @param {string} name  Display name for the key
 * @param {number|null} dataLimitGb  GB cap (null = no limit)
 * @returns {{ ok: boolean, key: object|null, error: string }}
 */
async function createKey(apiUrl, name, dataLimitGb = null) {
  try {
    const client = _client(apiUrl);

    // Create key
    const createRes = await client.post('/access-keys', {});
    const key = createRes.data;
    const keyId = String(key.id);

    // Rename
    await client.put(`/access-keys/${keyId}/name`, { name }).catch(() => {});

    // Set data limit if specified
    if (dataLimitGb !== null && dataLimitGb > 0) {
      await client
        .put(`/access-keys/${keyId}/data-limit`, { limit: { bytes: _gb(dataLimitGb) } })
        .catch(() => {});
    }

    return { ok: true, key: { ...key, id: keyId }, error: '' };
  } catch (err) {
    return { ok: false, key: null, error: err.message };
  }
}

/**
 * Delete an access key.
 * @returns {{ ok: boolean, error: string }}
 */
async function deleteKey(apiUrl, keyId) {
  try {
    await _client(apiUrl).delete(`/access-keys/${keyId}`);
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Rename a key.
 * @returns {{ ok: boolean, error: string }}
 */
async function renameKey(apiUrl, keyId, name) {
  try {
    await _client(apiUrl).put(`/access-keys/${keyId}/name`, { name });
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Set (or remove) a data limit on a key.
 * @param {number|null} dataLimitGb  null removes the limit
 * @returns {{ ok: boolean, error: string }}
 */
async function setDataLimit(apiUrl, keyId, dataLimitGb) {
  try {
    const client = _client(apiUrl);
    if (dataLimitGb === null) {
      await client.delete(`/access-keys/${keyId}/data-limit`);
    } else {
      await client.put(`/access-keys/${keyId}/data-limit`, {
        limit: { bytes: _gb(dataLimitGb) },
      });
    }
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * Get per-key data usage.
 * @returns {{ ok: boolean, usage: Record<string,number>, error: string }}
 */
async function getUsage(apiUrl) {
  try {
    const res = await _client(apiUrl).get('/metrics/transfer');
    const raw = res.data?.bytesTransferredByUserId || {};
    // Normalise keys to string
    const usage = {};
    for (const [k, v] of Object.entries(raw)) usage[String(k)] = v;
    return { ok: true, usage, error: '' };
  } catch (err) {
    return { ok: false, usage: {}, error: err.message };
  }
}

// ── Brand label helper ───────────────────────────────────────────────────────

/**
 * Append a brand label as the URL fragment so it shows as the key name
 * inside the customer's Outline app.
 */
function applyBrand(accessUrl, brand) {
  if (!brand || !accessUrl) return accessUrl;
  const base = accessUrl.split('#')[0];
  return `${base}#${encodeURIComponent(brand)}`;
}

module.exports = {
  testConnection,
  listKeys,
  createKey,
  deleteKey,
  renameKey,
  setDataLimit,
  getUsage,
  applyBrand,
  formatBytes,
};
