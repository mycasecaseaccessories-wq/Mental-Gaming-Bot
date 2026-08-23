// =============================================================================
// PM2 process manager config — bot + api-server ကို 24/7 run + auto-restart
// အသုံးပြုနည်း (repo root ကနေ):
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup   (server reboot ဖြစ်ရင် အလိုအလျောက် ပြန်တက်)
// =============================================================================

const fs = require("fs");
const path = require("path");

// PM2 loads this file before workspace dependencies are resolved. Read the
// project env file without requiring dotenv at PM2 configuration time.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const envCandidates = [
  process.env.MGS_ENV_FILE,
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../artifacts/bot/.env"),
  path.resolve(__dirname, ".env"),
].filter(Boolean);
for (const envFile of envCandidates) loadEnvFile(envFile);

module.exports = {
  apps: [
    {
      name: "mgs-bot",
      cwd: __dirname + "/..",
      script: "artifacts/bot/src/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        BOT_TOKEN: process.env.BOT_TOKEN,
        BOT_USERNAME: process.env.BOT_USERNAME,
        ADMIN_ID: process.env.ADMIN_ID,
        MONGODB_URI: process.env.MONGODB_URI,
        AI_API_KEY: process.env.AI_API_KEY,
        SESSION_SECRET: process.env.SESSION_SECRET,
        SMILEONE_USER_ID: process.env.SMILEONE_USER_ID,
        SMILEONE_SECRET: process.env.SMILEONE_SECRET,
        UNIPIN_API_KEY: process.env.UNIPIN_API_KEY,
      },
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    },
    {
      name: "mgs-api",
      cwd: __dirname + "/..",
      script: "artifacts/api-server/dist/index.mjs",
      interpreter: "node",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "8000",
        LOG_LEVEL: process.env.LOG_LEVEL || "info",
        BOT_TOKEN: process.env.BOT_TOKEN,
        ADMIN_ID: process.env.ADMIN_ID,
        AI_API_KEY: process.env.AI_API_KEY,
        SESSION_SECRET: process.env.SESSION_SECRET,
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
        WEBHOOK_ALLOWED_IPS: process.env.WEBHOOK_ALLOWED_IPS,
        WEBHOOK_ALLOW_ANY_IP: process.env.WEBHOOK_ALLOW_ANY_IP || "false",
        CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
        MONGODB_URI: process.env.MONGODB_URI,
      },
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    },
  ],
};
