const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: Number,
      required: true,
      comment: 'Telegram ID of the admin who performed the action',
    },
    action: {
      type: String,
      required: true,
      trim: true,
      comment: 'e.g. "BAN_USER", "UPDATE_PRICE", "PROCESS_ORDER", "ADD_PRODUCT"',
    },
    targetId: {
      type: String,
      default: null,
      comment: 'MongoDB _id or Telegram ID of the affected entity',
    },
    targetType: {
      type: String,
      enum: ['User', 'Product', 'Order', 'Currency', 'System', 'Catalog'],
      default: 'System',
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      comment: 'Extra context: before/after values, reason, etc.',
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
  }
);

auditLogSchema.index({ adminId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1 });

auditLogSchema.statics.log = function (adminId, action, targetId = null, targetType = 'System', details = {}) {
  return this.create({ adminId, action, targetId, targetType, details });
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
