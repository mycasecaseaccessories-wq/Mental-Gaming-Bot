/**
 * Admin RBAC model
 *
 * Roles (descending power):
 *   OWNER   — full access, financial exports, delete admins, system settings
 *   MANAGER — edit prices/products, manage tickets, approve orders (no exports)
 *   STAFF   — approve/reject orders & top-ups, reply to tickets only
 *
 * The env ADMIN_ID is always treated as OWNER regardless of this collection.
 */

const mongoose = require('mongoose');

const ROLES = ['OWNER', 'MANAGER', 'STAFF'];
const ROLE_LEVEL = { STAFF: 1, MANAGER: 2, OWNER: 3 };

const adminSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    username:   { type: String, default: null },
    role:       { type: String, enum: ROLES, required: true },
    addedBy:    { type: Number, required: true },
    isActive:   { type: Boolean, default: true },
    notes:      { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

adminSchema.index({ isActive: 1, role: 1 });

adminSchema.statics.ROLES      = ROLES;
adminSchema.statics.ROLE_LEVEL = ROLE_LEVEL;

module.exports = mongoose.model('Admin', adminSchema);
