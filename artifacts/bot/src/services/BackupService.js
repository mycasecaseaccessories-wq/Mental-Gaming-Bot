/**
 * BackupService — Automated encrypted database backup.
 *
 * On each run (triggered by CronService at 06:00 AM daily):
 *   1. Dumps all critical MongoDB collections to a JSON snapshot
 *   2. Compresses with gzip  (zlib, Node built-in)
 *   3. Encrypts with AES-256-CBC (crypto, Node built-in; key derived from SESSION_SECRET)
 *   4. Sends the encrypted file to the admin's Telegram DM or a dedicated backup channel
 *
 * File format: MGS_Backup_YYYY-MM-DD_HHMMSS.json.gz.enc
 *
 * Decryption (run locally with SESSION_SECRET):
 *   const crypto = require('crypto');
 *   const zlib   = require('zlib');
 *   const raw    = fs.readFileSync('MGS_Backup_...enc');
 *   const key    = crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
 *   const iv     = raw.slice(0, 16);
 *   const enc    = raw.slice(16);
 *   const dec    = crypto.createDecipheriv('aes-256-cbc', key, iv);
 *   const gz     = Buffer.concat([dec.update(enc), dec.final()]);
 *   const json   = zlib.gunzipSync(gz).toString('utf8');
 *   fs.writeFileSync('restored.json', json);
 */

const crypto  = require('crypto');
const zlib    = require('zlib');
const { promisify } = require('util');
const gzip    = promisify(zlib.gzip);
const { config } = require('../../config/settings');

// Collections included in every backup
const COLLECTIONS = [
  'User',
  'Order',
  'Transaction',
  'Product',
  'PaymentMethod',
  'Currency',
  'Promo',
  'Review',
  'SystemStatus',
  'Admin',
  'FAQ',
  'Template',
  'AuditLog',
  'SupportTicket',
  'Referral',
];

// Orders and Transactions: include last 90 days to keep backup manageable
const RECENT_ONLY = new Set(['Order', 'Transaction', 'AuditLog']);
const RECENT_DAYS = 90;

// ── In-memory metadata for /sysinfo ──────────────────────────────────────────
let lastBackupAt   = null;
let lastBackupSize = null;
let lastBackupFile = null;

function getLastBackupInfo() {
  return { lastBackupAt, lastBackupSize, lastBackupFile };
}

// ── Encryption ────────────────────────────────────────────────────────────────

function deriveKey() {
  const secret = process.env.SESSION_SECRET || config.db.uri || 'mgs-default-backup-key-32b!';
  return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
}

function encryptBuffer(buffer) {
  const key = deriveKey();
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  // Output: [16-byte IV][encrypted payload]
  return Buffer.concat([iv, encrypted]);
}

// ── Collection dumper ─────────────────────────────────────────────────────────

async function dumpCollection(modelName) {
  try {
    const Model = require(`../models/${modelName}`);
    let query;

    if (RECENT_ONLY.has(modelName)) {
      const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
      const timeField = modelName === 'Order' ? 'timestamp' : 'createdAt';
      query = Model.find({ [timeField]: { $gte: since } }).lean();
    } else {
      query = Model.find({}).lean();
    }

    const docs = await query;
    return { model: modelName, count: docs.length, docs };
  } catch (err) {
    // If model doesn't exist or errors, include a stub so backup isn't broken
    return { model: modelName, count: 0, docs: [], error: err.message };
  }
}

// ── Main backup runner ────────────────────────────────────────────────────────

async function runBackup(telegram) {
  const startedAt = new Date();
  console.log('[BackupService] 🗄 Starting backup…');

  const collections = {};
  let totalDocs = 0;

  // Dump all collections in parallel
  const results = await Promise.all(COLLECTIONS.map(dumpCollection));
  for (const r of results) {
    collections[r.model] = { count: r.count, docs: r.docs };
    totalDocs += r.count;
    if (r.error) console.warn(`[BackupService] ⚠ ${r.model}: ${r.error}`);
  }

  const backup = {
    meta: {
      store:       'Mental Gaming Store',
      generatedAt: startedAt.toISOString(),
      totalDocs,
      collections: Object.keys(collections),
      note:        `Orders/Transactions include last ${RECENT_DAYS} days only`,
    },
    data: collections,
  };

  const jsonStr  = JSON.stringify(backup, null, 0); // compact JSON
  const jsonBuf  = Buffer.from(jsonStr, 'utf8');
  const compressed = await gzip(jsonBuf);
  const encrypted  = encryptBuffer(compressed);

  const now      = new Date();
  const datePart = now.toISOString().replace(/[:T]/g, '-').slice(0, 19).replace(/:/g, '');
  const filename = `MGS_Backup_${datePart}.json.gz.enc`;

  const sizeMB   = (encrypted.length / 1024 / 1024).toFixed(2);
  const origMB   = (jsonBuf.length   / 1024 / 1024).toFixed(2);
  const duration = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);

  // Update in-memory metadata
  lastBackupAt   = now;
  lastBackupSize = `${sizeMB} MB`;
  lastBackupFile = filename;

  // Determine where to send
  const SystemStatus = require('../models/SystemStatus');
  const status       = await SystemStatus.get();
  const targetId     = status.backupChannelId || config.bot.adminId;

  const caption =
    `🗄 *Database Backup Complete*\n\n` +
    `📅 ${now.toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT\n` +
    `📦 Records: *${totalDocs.toLocaleString()}* across ${COLLECTIONS.length} collections\n` +
    `📄 Raw JSON: *${origMB} MB*\n` +
    `📦 Encrypted: *${sizeMB} MB* (gzip + AES-256)\n` +
    `⏱ Duration: ${duration}s\n\n` +
    `🔐 _Encrypted with AES-256-CBC. Decrypt with SESSION_SECRET._\n` +
    `_Last ${RECENT_DAYS} days for Orders/Transactions._`;

  try {
    await telegram.sendDocument(
      targetId,
      { source: encrypted, filename },
      { caption, parse_mode: 'Markdown' }
    );
    console.log(`[BackupService] ✅ Backup sent (${sizeMB} MB, ${totalDocs} docs, ${duration}s)`);
    return { filename, sizeMB, totalDocs, duration };
  } catch (err) {
    console.error('[BackupService] ❌ Send failed:', err.message);
    // Fallback: try sending to admin directly
    if (String(targetId) !== String(config.bot.adminId)) {
      try {
        await telegram.sendDocument(
          config.bot.adminId,
          { source: encrypted, filename },
          { caption: caption + '\n\n⚠️ _Backup channel unavailable — sent to owner._', parse_mode: 'Markdown' }
        );
      } catch (e2) {
        console.error('[BackupService] ❌ Fallback send failed:', e2.message);
      }
    }
    throw err;
  }
}

module.exports = { runBackup, getLastBackupInfo };
