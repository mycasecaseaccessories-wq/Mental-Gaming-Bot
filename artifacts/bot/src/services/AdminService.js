/**
 * AdminService — Role-Based Access Control (RBAC)
 *
 * Role hierarchy (highest → lowest):
 *   OWNER (3) → MANAGER (2) → STAFF (1)
 *
 * The env ADMIN_ID is always implicitly OWNER, even if not in the DB.
 * All write operations are audit-logged.
 */

const Admin = require('../models/Admin');
const { auditLog } = require('./logger');
const { config } = require('../../config/settings');

const ROLE_LEVEL = Admin.ROLE_LEVEL;
const ROLES      = Admin.ROLES;

// ── Helpers ───────────────────────────────────────────────────────────────────

function roleLevel(role) {
  return ROLE_LEVEL[role] || 0;
}

function isEnvOwner(telegramId) {
  return Number(telegramId) === Number(config.bot.adminId);
}

// ── Core queries ──────────────────────────────────────────────────────────────

async function getAdminRecord(telegramId) {
  if (isEnvOwner(telegramId)) {
    return { telegramId, role: 'OWNER', isActive: true, _envOwner: true };
  }
  return Admin.findOne({ telegramId: Number(telegramId), isActive: true });
}

async function getAdminRole(telegramId) {
  const rec = await getAdminRecord(telegramId);
  return rec?.role || null;
}

async function isAdmin(telegramId) {
  const role = await getAdminRole(telegramId);
  return role !== null;
}

/**
 * Returns true if the user's role is >= minRole in the hierarchy.
 * @param {number} telegramId
 * @param {'STAFF'|'MANAGER'|'OWNER'} minRole
 */
async function hasRole(telegramId, minRole) {
  const role = await getAdminRole(telegramId);
  if (!role) return false;
  return roleLevel(role) >= roleLevel(minRole);
}

// ── Mutations (OWNER-only callers should be enforced at command level) ────────

async function addAdmin(telegramId, role, addedBy, username = null) {
  if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}. Use: ${ROLES.join(', ')}`);
  if (isEnvOwner(telegramId)) throw new Error('Cannot add the bot owner via this command.');

  const existing = await Admin.findOne({ telegramId: Number(telegramId) });
  let admin;

  if (existing) {
    existing.role     = role;
    existing.isActive = true;
    existing.addedBy  = Number(addedBy);
    if (username) existing.username = username;
    admin = await existing.save();
  } else {
    admin = await Admin.create({
      telegramId: Number(telegramId),
      username,
      role,
      addedBy: Number(addedBy),
    });
  }

  await auditLog(addedBy, 'ADMIN_ADDED', String(telegramId), 'Admin', { role });
  return admin;
}

async function removeAdmin(telegramId, removedBy) {
  if (isEnvOwner(telegramId)) throw new Error('Cannot remove the bot owner.');
  const admin = await Admin.findOne({ telegramId: Number(telegramId) });
  if (!admin) throw new Error('Admin not found.');

  admin.isActive = false;
  await admin.save();
  await auditLog(removedBy, 'ADMIN_REMOVED', String(telegramId), 'Admin', { role: admin.role });
  return admin;
}

async function listAdmins() {
  const admins = await Admin.find({ isActive: true }).sort({ createdAt: 1 });
  return admins;
}

async function updateAdminRole(telegramId, newRole, updatedBy) {
  if (!ROLES.includes(newRole)) throw new Error(`Invalid role: ${newRole}`);
  if (isEnvOwner(telegramId)) throw new Error('Cannot change the owner role.');

  const admin = await Admin.findOne({ telegramId: Number(telegramId), isActive: true });
  if (!admin) throw new Error('Admin not found.');

  const oldRole = admin.role;
  admin.role = newRole;
  await admin.save();
  await auditLog(updatedBy, 'ADMIN_ROLE_CHANGED', String(telegramId), 'Admin', { from: oldRole, to: newRole });
  return admin;
}

// ── Middleware factory ─────────────────────────────────────────────────────────

/**
 * Telegraf middleware — only allows users with role >= minRole.
 * Replaces adminOnly() for role-aware routes.
 *
 * @param {'STAFF'|'MANAGER'|'OWNER'} minRole
 */
function requireRole(minRole = 'STAFF') {
  return async (ctx, next) => {
    const ok = await hasRole(ctx.from?.id, minRole);
    if (!ok) {
      const text = ctx.callbackQuery
        ? '⛔ Access denied.'
        : '⛔ Access denied. You need at least ' + minRole + ' role.';
      if (ctx.callbackQuery) await ctx.answerCbQuery(text, { show_alert: true });
      else await ctx.reply(text);
      return;
    }
    // Attach role to ctx for downstream use
    ctx.adminRole = await getAdminRole(ctx.from.id);
    return next();
  };
}

module.exports = {
  ROLES,
  ROLE_LEVEL,
  isEnvOwner,
  getAdminRole,
  getAdminRecord,
  isAdmin,
  hasRole,
  addAdmin,
  removeAdmin,
  listAdmins,
  updateAdminRole,
  requireRole,
};
