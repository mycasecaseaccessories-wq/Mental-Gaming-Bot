require('dotenv').config();

const config = {
  botToken:   process.env.BOT_TOKEN,
  mongoUri:   process.env.MONGODB_URI,
  adminId:    parseInt(process.env.ADMIN_ID || '0', 10),
  nodeEnv:    process.env.NODE_ENV || 'development',
};

function validate() {
  const missing = ['BOT_TOKEN', 'MONGODB_URI', 'ADMIN_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { config, validate };
