require('dotenv').config();

// Suppress Mongoose 8.x false-positive "Duplicate schema index" warning
// (sparse+unique on a single field triggers this cosmetic warning; it does not affect behaviour)
const _origEmit = process.emit.bind(process);
process.emit = function (name, ...args) {
  if (name === 'warning' && args[0]?.message?.includes('Duplicate schema index')) return true;
  return _origEmit(name, ...args);
};

const { Telegraf, Scenes, session } = require('telegraf');
const path = require('path');
const fs   = require('fs');

const { config, validate }      = require('../config/settings');
const { connectDB }             = require('./database');
const { attachUser }            = require('./middlewares/authUser');
const { antiSpam }              = require('./middlewares/antiSpam');
const { errorHandler, setupGlobalErrorHandlers } = require('./middlewares/errorHandler');
const { navigationMiddleware }  = require('./middlewares/navigationMiddleware');
const { maintenanceCheck }      = require('./middlewares/maintenanceCheck');

const rateManagerScene  = require('./scenes/rateManagerScene');
const orderScene        = require('./scenes/orderScene');
const topupScene        = require('./scenes/topupScene');
const broadcastScene    = require('./scenes/broadcastScene');
const spinWheelScene    = require('./scenes/spinWheelScene');
const supportScene      = require('./scenes/supportScene');
const onboardingScene   = require('./scenes/onboardingScene');
const rewardScene       = require('./scenes/rewardScene');

validate();

const bot   = new Telegraf(config.bot.token);
const stage = new Scenes.Stage([
  rateManagerScene,
  orderScene,
  topupScene,
  broadcastScene,
  spinWheelScene,
  supportScene,
  onboardingScene,
  rewardScene,
]);

bot.use(errorHandler());
bot.use(antiSpam());
bot.use(session());
bot.use(maintenanceCheck());   // ← maintenance/holiday gate (after session, before auth)
bot.use(stage.middleware());
bot.use(attachUser());

navigationMiddleware(bot);

function loadCommands(bot) {
  const commandsDir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  const ORDER = [
    'start.js',
    'shop.js',
    'search.js',
    'orders.js',
    'wallet.js',
    'topup.js',
    'spin.js',
    'checkin.js',
    'promo.js',
    'addressBook.js',
    'referral.js',
    'support.js',
    'profile.js',
    'settings.js',
    'dashboard.js',
    'adminOrders.js',
    'userManagement.js',
    'systemManagement.js',  // ← RBAC + maintenance + templates + pulse
    'financialExport.js',   // ← CSV/financial reports (OWNER only)
    'faq.js',               // ← FAQ library + video tutorials
    'feedback.js',          // ← Post-order feedback + review wall
    'apiManagement.js',     // ← External API / provider management + attribution analytics
    'analytics.js',         // ← Financial analytics dashboard + AI insights + sentiment
    'sysinfo.js',           // ← /sysinfo resource monitor + /runbackup + /runcron + /flushcache
    'health.js',            // ← /checkhealth load test + /checkmodules
    'launch.js',            // ← /launchbroadcast + /setseason + /seasonlist + /previewseason
    'trackOrder.js',        // ← /trackorder <shortId> — live status lookup + refresh
    'adminGameConfig.js',
    'channelAutoPost.js',   // ← Channel auto-post scheduler (owner)
    'catalogAdmin.js',      // ← Catalog system + bulk product import
    'bannerAdmin.js',       // ← Promotion banner management (MANAGER+)
    'featureGate.js',       // ← Feature gate control panel (Owner/Manager)
    'mcConfig.js',          // ← Mental Coin exchange & review reward config (Owner)
    'adminRewards.js',      // ← Coin Rewards + Redeem Codes admin (Owner)
    'rewards.js',           // ← Coin Rewards + Redeem Codes (user) — text handler must precede ambient
    'accounts.js',          // ← Premium Accounts (user + admin) — text wizard must precede ambient
    'refCampaign.js',       // ← Referral campaigns (user + admin wizard)
    'joinReward.js',        // ← Channel join bonus (user + admin wizard)
    'admin.js',
    'help.js',
    'ambient.js',           // ← LAST: catch-all ambient AI text handler
  ];

  const sorted = [
    ...ORDER.filter((f) => files.includes(f)),
    ...files.filter((f) => !ORDER.includes(f)),
  ];

  for (const file of sorted) {
    try {
      const register = require(path.join(commandsDir, file));
      if (typeof register === 'function') {
        register(bot);
        console.log(`[Commands] ✅ ${file}`);
      } else {
        console.warn(`[Commands] ⏩ ${file}`);
      }
    } catch (err) {
      console.error(`[Commands] ❌ ${file}:`, err.message);
    }
  }
}

async function registerBotCommands() {
  await bot.telegram.setMyCommands([
    // ── User ──────────────────────────────────────────────────────────────────
    { command: 'start',         description: '🏠 Main Menu' },
    { command: 'shop',          description: '🛒 Browse Products' },
    { command: 'orders',        description: '📦 My Orders' },
    { command: 'wallet',        description: '💰 My Wallet' },
    { command: 'topup',         description: '💳 Top Up Wallet' },
    { command: 'accounts',      description: '🔐 Premium Accounts' },
    { command: 'myaccounts',    description: '🎟 My Purchased Accounts' },
    { command: 'campaign',      description: '🎯 Referral Campaign' },
    { command: 'joinbonus',     description: '📣 Channel Join Bonus' },
    { command: 'history',       description: '📜 Transaction History' },
    { command: 'spin',          description: '🎰 Spin Wheel' },
    { command: 'spininfo',      description: '🎲 Prize Pool Info' },
    { command: 'checkin',       description: '🗓 Daily Check-In' },
    { command: 'streak',        description: '🔥 My Streak Stats' },
    { command: 'calendar',      description: '📅 Check-In Calendar' },
    { command: 'progress',      description: '📊 Tier Level Progress' },
    { command: 'promo',         description: '🎟 Check Promo Code' },
    { command: 'myids',         description: '📖 Saved Game IDs' },
    { command: 'saveid',        description: '➕ Save a Game ID' },
    { command: 'deleteid',      description: '🗑 Delete a Game ID' },
    { command: 'faq',           description: '📚 FAQ & Help Center' },
    { command: 'reviews',       description: '🌟 Customer Reviews' },
    { command: 'support',       description: '💬 AI Customer Support' },
    { command: 'mytickets',     description: '🎫 My Support Tickets' },
    { command: 'myrole',        description: '🔹 My Admin Role' },
    { command: 'profile',       description: '👤 My Profile' },
    { command: 'settings',      description: '⚙️ Theme & Settings' },
    { command: 'help',          description: '❓ Help' },
    // ── Staff+ ────────────────────────────────────────────────────────────────
    { command: 'pendingorders', description: '🟡 Pending Orders (Staff+)' },
    { command: 'tickets',       description: '🎫 Support Tickets (Staff+)' },
    { command: 'closeticket',   description: '⚫ Close a Ticket (Staff+)' },
    { command: 'templates',     description: '📜 Quick-Reply Templates (Staff+)' },
    { command: 'feedbackstats', description: '📊 Feedback Statistics (Staff+)' },
    { command: 'listfaqs',      description: '📋 List All FAQs (Staff+)' },
    // ── Manager+ ──────────────────────────────────────────────────────────────
    { command: 'addcodes',      description: '🎁 Add Digital Codes (Manager+)' },
    { command: 'flashsale',     description: '🔥 Activate Flash Sale (Manager+)' },
    { command: 'maintenance',   description: '🔧 Maintenance Mode (Manager+)' },
    { command: 'holiday',       description: '🎉 Holiday Mode (Manager+)' },
    { command: 'systemstatus',  description: '📊 System Status (Manager+)' },
    { command: 'addtemplate',   description: '📝 Add Template (Manager+)' },
    { command: 'deletetemplate',description: '🗑 Delete Template (Manager+)' },
    { command: 'createpromo',   description: '🎟 Create Promo Code (Manager+)' },
    { command: 'listpromos',    description: '📋 List Promo Codes (Manager+)' },
    { command: 'deletepromo',   description: '🗑 Deactivate Promo (Manager+)' },
    { command: 'broadcast',          description: '📢 Broadcast Message (Manager+)' },
    { command: 'addfaq',             description: '➕ Add FAQ Entry (Manager+)' },
    { command: 'deletefaq',          description: '🗑 Delete FAQ Entry (Manager+)' },
    { command: 'addfaqvideo',        description: '🎬 Add Video Tutorial to FAQ (Manager+)' },
    { command: 'setfeedbackchannel', description: '📢 Set Review Channel (Manager+)' },
    { command: 'togglefeedback',     description: '🔛 Toggle Feedback Watcher (Manager+)' },
    { command: 'refstats',           description: '📊 Referral Stats (Manager+)' },
    { command: 'reffraud',           description: '⚠️ Fraud Flags (Manager+)' },
    { command: 'toggledelivery',     description: '🔄 Toggle Auto/Manual Delivery (Manager+)' },
    { command: 'setprovider',        description: '🔌 Set API Provider for Product (Manager+)' },
    { command: 'listproviders',      description: '🟢 Provider Health Check (Manager+)' },
    { command: 'providerstats',      description: '📊 API Call Stats (Manager+)' },
    { command: 'testapi',            description: '🧪 Test Provider Connection (Manager+)' },
    { command: 'adminproducts',      description: '📦 Products & Delivery Modes (Manager+)' },
    { command: 'joinsources',        description: '📊 User Attribution Stats (Manager+)' },
    { command: 'analytics',      description: '📊 Analytics Dashboard (Manager+)' },
    { command: 'analyticsai',    description: '🤖 AI Business Report (Manager+)' },
    { command: 'forecast',       description: '🔮 7-Day Sales Forecast (Manager+)' },
    { command: 'sentimentreport',description: '🧠 Sentiment Analysis (Manager+)' },
    { command: 'systemhealth',   description: '🖥 System Status (Manager+)' },
    { command: 'exportdetail',   description: '📥 Detailed CSV Export (Manager+)' },
    { command: 'sysinfo',        description: '🖥 System Info & Resources (Manager+)' },
    { command: 'runbackup',      description: '🗄 Run DB Backup Now (Owner)' },
    { command: 'runcron',        description: '🔧 Run Maintenance Jobs (Owner)' },
    { command: 'flushcache',     description: '🗃 Flush In-Memory Cache (Manager+)' },
    { command: 'setbackupchan',  description: '🗄 Set Backup Channel (Owner)' },
    { command: 'checkhealth',    description: '🏥 Full System Health Check (Owner)' },
    { command: 'checkmodules',   description: '📦 List Loaded Modules (Manager+)' },
    { command: 'launchbroadcast',description: '🚀 Official Launch Broadcast (Owner)' },
    { command: 'setseason',      description: '🎨 Set Seasonal Theme (Owner)' },
    { command: 'seasonlist',     description: '🎨 List Seasonal Themes (Manager+)' },
    { command: 'previewseason',  description: '👁 Preview a Season Theme (Manager+)' },
    { command: 'setgateway',     description: '💳 Set Payment Gateway Status (Owner)' },
    { command: 'setgatewaynote', description: '📝 Set Gateway Note (Owner)' },
    { command: 'setannouncechannel', description: '📢 Set Announcement Channel (Owner)' },
    { command: 'announce',           description: '📣 Broadcast Product to Channel (Manager+)' },
    { command: 'webhookstats',       description: '📡 Webhook Event Stats (Owner)' },
    // ── Owner only ────────────────────────────────────────────────────────────
    { command: 'admin',         description: '🔧 Admin Panel (Owner)' },
    { command: 'dashboard',     description: '📊 Dashboard (Owner)' },
    { command: 'export',        description: '📊 Financial Export CSV (Owner)' },
    { command: 'setcommission', description: '💹 Set Referral Commission (Owner)' },
    { command: 'togglereferral',description: '🔛 Toggle Referral Program (Owner)' },
    { command: 'refadjust',     description: '💰 Manual Commission Adjust (Owner)' },
    { command: 'pulse',         description: '📡 System Pulse (Owner)' },
    { command: 'addadmin',      description: '👑 Add Admin (Owner)' },
    { command: 'removeadmin',   description: '🗑 Remove Admin (Owner)' },
    { command: 'listadmins',    description: '👥 List Admins (Owner)' },
    { command: 'setrole',       description: '🔄 Change Admin Role (Owner)' },
    { command: 'auditlog',      description: '📋 Audit Log (Owner)' },
    { command: 'penalize',      description: '⚠️ Penalize User (Owner)' },
    { command: 'userlog',       description: '📋 User Activity Log (Owner)' },
    { command: 'block',         description: '🚫 Block User (Owner)' },
    { command: 'unblock',       description: '✅ Unblock User (Owner)' },
    { command: 'userinfo',      description: '👤 User Info (Owner)' },
    { command: 'users',         description: '👥 User List (Owner)' },
    { command: 'ban',           description: '🚫 Ban User (Owner)' },
    { command: 'unban',         description: '✅ Unban User (Owner)' },
    { command: 'warn',          description: '⚠️ Warn User (Owner)' },
    { command: 'unwarn',        description: '✅ Remove Warning (Owner)' },
    { command: 'restrict',      description: '🔒 Restrict Rights (Owner)' },
    { command: 'unrestrict',    description: '🔓 Remove Restrictions (Owner)' },
    { command: 'adjustbal',     description: '💳 Adjust Balance (Owner)' },
    { command: 'addpayment',    description: '➕ Add Payment Method (Owner)' },
    { command: 'listpayments',  description: '💳 Payment Methods (Owner)' },
    { command: 'managerates',   description: '💱 Manage Rates (Owner)' },
    { command: 'rates',         description: '💹 Current Rates (Owner)' },
    { command: 'fetchrates',    description: '🔄 Fetch Live Rates (Owner)' },
    { command: 'setmenu',       description: '🛍 Re-apply Mini App button (Owner)' },
  ]);
  console.log('[Bot] ✅ Command menu registered');
}

function getMiniAppUrl() {
  if (process.env.MINI_APP_URL) return process.env.MINI_APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(',')[0].trim()}/`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}/`;
  return null;
}

async function applyMiniAppMenuButton(telegram) {
  const url = getMiniAppUrl();
  if (!url) {
    console.warn('[Bot] ⚠️  No MINI_APP_URL or REPLIT_DEV_DOMAIN set — menu button not configured');
    return;
  }
  try {
    await telegram.callApi('setChatMenuButton', {
      menu_button: { type: 'web_app', text: '🛍 Open Store', web_app: { url } },
    });
    console.log(`[Bot] ✅ Menu button set → ${url}`);
  } catch (err) {
    console.warn('[Bot] ⚠️  setMenuButton failed:', err.message);
  }
}

async function bootstrap() {
  console.log('[Bot] 🚀 Starting Mental Gaming Store Bot...');

  await connectDB();
  loadCommands(bot);

  // Owner-only: /setmenu — re-applies the Mini App menu button on demand
  const { adminOnly } = require('./middlewares/adminCheck');
  bot.command('setmenu', adminOnly(), async (ctx) => {
    const url = getMiniAppUrl();
    const envDiag =
      `\`MINI_APP_URL\`: ${process.env.MINI_APP_URL || '_(not set)_'}\n` +
      `\`REPLIT_DOMAINS\`: ${process.env.REPLIT_DOMAINS || '_(not set)_'}\n` +
      `\`REPLIT_DEV_DOMAIN\`: ${process.env.REPLIT_DEV_DOMAIN || '_(not set)_'}`;
    if (!url) {
      return ctx.reply(
        `❌ *No URL found* — cannot set menu button.\n\n${envDiag}\n\nSet the \`MINI_APP_URL\` secret to the landing page URL.`,
        { parse_mode: 'Markdown' }
      );
    }
    const errors = [];
    // 1. Set for this specific chat (takes effect immediately for this user)
    try {
      await ctx.telegram.callApi('setChatMenuButton', {
        chat_id: ctx.chat.id,
        menu_button: { type: 'web_app', text: '🛍 Open Store', web_app: { url } },
      });
    } catch (err) {
      errors.push(`Chat-specific: ${err.message}`);
    }
    // 2. Set global default (applies to all future/new chats)
    try {
      await ctx.telegram.callApi('setChatMenuButton', {
        menu_button: { type: 'web_app', text: '🛍 Open Store', web_app: { url } },
      });
    } catch (err) {
      errors.push(`Global default: ${err.message}`);
    }
    if (errors.length) {
      return ctx.reply(
        `⚠️ *Partial failure*\n\`\`\`\n${errors.join('\n')}\n\`\`\`\n\nURL tried: \`${url}\`\n\n${envDiag}`,
        { parse_mode: 'Markdown' }
      );
    }
    return ctx.reply(
      `✅ *Menu button set!*\n\n🔗 URL: \`${url}\`\n\nThe blue *🛍 Open Store* button should now appear to the left of the message input.\n_If not visible, close and reopen this chat._`,
      { parse_mode: 'Markdown' }
    );
  });

  // Flash sale watcher — every 60s
  const { startFlashSaleWatcher } = require('./services/FlashSaleService');
  startFlashSaleWatcher(bot.telegram);
  console.log('[Bot] ✅ Flash sale watcher started');

  // Feedback watcher — every 60 min
  const { startFeedbackWatcher } = require('./services/FeedbackService');
  startFeedbackWatcher(bot.telegram);
  console.log('[Bot] ✅ Feedback watcher started');

  // Sentiment watcher — every 60 min (runs alongside feedback watcher)
  const { runSentimentWatcherCycle } = require('./services/SentimentService');
  const SENTIMENT_INTERVAL_MS = 60 * 60_000;
  // Initial scan 2 min after startup (don't block launch)
  setTimeout(() => runSentimentWatcherCycle(bot.telegram), 2 * 60_000);
  setInterval(() => runSentimentWatcherCycle(bot.telegram), SENTIMENT_INTERVAL_MS);
  console.log('[Bot] ✅ Sentiment watcher scheduled');

  // Seed default FAQs if collection is empty
  const { seedDefaultFAQs } = require('./services/FAQService');
  await seedDefaultFAQs();

  process.on('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.on('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

  await bot.launch();
  await registerBotCommands();

  // Set the chat menu button to open the Mini App directly
  await applyMiniAppMenuButton(bot.telegram);

  // Global crash handler — must run AFTER launch so telegram client is ready
  setupGlobalErrorHandlers(bot.telegram);

  // Cron jobs — daily archive, promo purge, screenshot audit, cache flush, backup
  const { startCronJobs } = require('./services/CronService');
  startCronJobs(bot.telegram);

  // Webhook event processor — polls every 30s for events written by api-server
  const { startWebhookProcessor } = require('./services/WebhookProcessor');
  startWebhookProcessor(bot.telegram);

  console.log(`[Bot] ✅ @${bot.botInfo?.username} is live!`);
}

async function bootstrapWithRetry(attempt = 1) {
  try {
    await bootstrap();
  } catch (err) {
    const is409 = err?.response?.error_code === 409 ||
                  (err?.message || '').includes('409');
    if (is409 && attempt <= 5) {
      const waitSec = attempt * 15;
      console.warn(`[Bot] ⚠️ Conflict (409) — another instance may be running. Retrying in ${waitSec}s... (attempt ${attempt}/5)`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return bootstrapWithRetry(attempt + 1);
    }
    console.error('[Bot] ❌ Fatal startup error:', err);
    process.exit(1);
  }
}

bootstrapWithRetry();
