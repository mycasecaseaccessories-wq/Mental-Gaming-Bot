const mongoose = require('mongoose');

const currencySchema = new mongoose.Schema(
  {
    currencyCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      comment: 'e.g. BRL, PHP, USD',
    },
    rateToMMK: {
      type: Number,
      required: true,
      min: 0,
      comment: '1 unit of this currency = rateToMMK MMK',
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    source: {
      type: String,
      enum: ['manual', 'api'],
      default: 'manual',
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

currencySchema.statics.getRate = async function (code) {
  const doc = await this.findOne({ currencyCode: code.toUpperCase() });
  return doc ? doc.rateToMMK : null;
};

currencySchema.statics.upsertRate = async function (code, rate, source = 'manual') {
  return this.findOneAndUpdate(
    { currencyCode: code.toUpperCase() },
    { rateToMMK: rate, lastUpdated: new Date(), source },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('Currency', currencySchema);
