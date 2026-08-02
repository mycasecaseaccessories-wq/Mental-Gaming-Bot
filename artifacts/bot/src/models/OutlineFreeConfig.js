/**
 * OutlineFreeConfig — singleton document controlling free-key eligibility.
 * Admin can toggle the free-key feature and set limits here.
 */
const mongoose = require('mongoose');

const outlineFreeConfigSchema = new mongoose.Schema(
  {
    _singleton: { type: String, default: 'free_config', unique: true },
    enabled: {
      type: Boolean,
      default: true,
    },
    // Data cap for each free key in GB (null = unlimited)
    dataLimitGb: {
      type: Number,
      default: 10,
    },
    // How many days the free key is valid (null = no expiry)
    durationDays: {
      type: Number,
      default: 7,
    },
    // How many active free keys one user may hold at a time
    maxKeysPerUser: {
      type: Number,
      default: 1,
    },
    // Hours a user must wait between claiming free keys (0 = no cooldown)
    cooldownHours: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true, versionKey: false }
);

// Get or create the singleton config document
outlineFreeConfigSchema.statics.get = async function () {
  let doc = await this.findOne({ _singleton: 'free_config' });
  if (!doc) {
    doc = await this.create({ _singleton: 'free_config' });
  }
  return doc;
};

module.exports = mongoose.model('OutlineFreeConfig', outlineFreeConfigSchema);
