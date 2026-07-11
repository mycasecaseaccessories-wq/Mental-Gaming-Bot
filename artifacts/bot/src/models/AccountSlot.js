/**
 * AccountSlot — one buyer's purchase of ONE OR MORE slots on a shared/invite
 * AccountCredential (multi-device account or family invite link).
 *
 * Single-buyer accounts keep storing the sale on AccountCredential itself;
 * shared/invite accounts store per-buyer sales here so one credential can be
 * sold to many buyers (one per device / per member seat).
 */
const mongoose = require('mongoose');

const accountSlotSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountProduct',
      required: true,
      index: true,
    },
    credentialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountCredential',
      required: true,
      index: true,
    },
    buyerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    buyerTelegramId: { type: Number, default: null, index: true },

    slots: { type: Number, default: 1, comment: 'How many devices/members this buyer bought' },
    soldAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    pricePaid: { type: Number, default: null },

    // ── Delivery snapshot (so buyer history survives credential edits/deletion) ──
    credTypeSnap: { type: String, enum: ['login', 'link'], default: 'login' },
    serviceNameSnap: { type: String, default: null },
    planLabelSnap: { type: String, default: null },
    durationDaysSnap: { type: Number, default: null },
    loginIdSnap: { type: String, default: null },
    passwordSnap: { type: String, default: null },
    linkSnap: { type: String, default: null },
    noteSnap: { type: String, default: null },

    // ── Expiry reminder flags ─────────────────────────────────────────────────
    notified3d: { type: Boolean, default: false },
    notifiedExpired: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);

accountSlotSchema.index({ buyerTelegramId: 1, soldAt: -1 });

module.exports = mongoose.model('AccountSlot', accountSlotSchema);
