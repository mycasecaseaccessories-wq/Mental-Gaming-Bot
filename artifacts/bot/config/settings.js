require('dotenv').config();

const config = {
  bot: {
    token:   process.env.BOT_TOKEN,
    adminId: Number(process.env.ADMIN_ID),
  },
  db: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/mental_gaming_store',
  },
  ai: {
    apiKey: process.env.AI_API_KEY,
  },
  membership: {
    tiers: ['Silver', 'Gold', 'Platinum'],
  },
  currency: {
    base:      'MMK',
    supported: ['BRL', 'PHP', 'USD'],
  },
  antiSpam: {
    maxRequestsPerMinute: 30,
    warningThreshold:     5,
  },
  // ── Referral defaults (overridable live via SystemStatus in MongoDB) ─────────
  // These are fallback values only; the live source of truth is SystemStatus.
  referral: {
    commissionRate:      2,      // % of top-up amount paid to referrer
    commissionMode:      'first', // 'first' | 'every'
    commissionType:      'KS',   // 'KS' | 'Coin' | 'Both'
    minTopupForReward:   1000,   // minimum top-up amount to trigger commission
    velocityLimit:       10,     // max new referrals per code per hour (fraud threshold)
    welcomeBonusKS:      200,    // fixed KS for referee on first top-up
    welcomeBonusCoins:   50,     // fixed coins for referee on first top-up
  },
};

function validate() {
  const required = ['BOT_TOKEN', 'MONGODB_URI', 'ADMIN_ID'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { config, validate };
