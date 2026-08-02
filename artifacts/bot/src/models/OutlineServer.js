/**
 * OutlineServer — stores Outline Access Server connections.
 * apiUrl and certSha256 are stored encrypted via the bot's crypto util.
 */
const mongoose = require('mongoose');

const outlineServerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Full management API URL e.g. https://1.2.3.4:8080/xxxxxx
    apiUrl: {
      type: String,
      required: true,
    },
    // SHA-256 fingerprint of the server's TLS certificate
    certSha256: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Optional note / label for admin reference
    note: {
      type: String,
      default: '',
    },
  },
  { timestamps: true, versionKey: false }
);

outlineServerSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ createdAt: 1 });
};

module.exports = mongoose.model('OutlineServer', outlineServerSchema);
