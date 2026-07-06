// =============================================================================
// PM2 process manager config — bot + api-server ကို 24/7 run + auto-restart
// အသုံးပြုနည်း (repo root ကနေ):
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup   (server reboot ဖြစ်ရင် အလိုအလျောက် ပြန်တက်)
// =============================================================================

require("dotenv").config();

module.exports = {
  apps: [
    {
      name: "mgs-bot",
      cwd: __dirname + "/..",
      script: "bot/src/index.js",
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
      script: "api-server/dist/index.mjs",
      interpreter: "node",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "8000",
        LOG_LEVEL: process.env.LOG_LEVEL || "info",
        MONGODB_URI: process.env.MONGODB_URI,
      },
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    },
  ],
};
