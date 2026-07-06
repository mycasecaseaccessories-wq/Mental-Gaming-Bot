const AuditLog = require('../models/AuditLog');

async function auditLog(adminId, action, targetId = null, targetType = 'System', details = {}) {
  try {
    await AuditLog.log(adminId, action, targetId, targetType, details);
  } catch (err) {
    console.error('[Logger] Failed to write audit log:', err.message);
  }
}

function info(message, meta = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] INFO: ${message}`, Object.keys(meta).length ? meta : '');
}

function warn(message, meta = {}) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] WARN: ${message}`, Object.keys(meta).length ? meta : '');
}

function error(message, err = null) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR: ${message}`, err ? err.stack || err.message : '');
}

module.exports = { auditLog, info, warn, error };
