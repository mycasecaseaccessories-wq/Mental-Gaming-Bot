const { adminOnly, requireRole } = require('../middlewares/adminCheck');
const { fetchLiveRates, getAllRates } = require('../services/currencyService');
const { auditLog } = require('../services/logger');
const { listUsers } = require('../services/UserManagementService');
const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const Order = require('../models/Order');
const Product = require('../models/Product');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Promo = require('../models/Promo');
const SupportTicket = require('../models/SupportTicket');
const SystemStatus = require('../models/SystemStatus');
const CacheService = require('../services/CacheService');
const AnalyticsService = require('../services/AnalyticsService');
const { price } = require('../utils/ui');
const { adminMenuKeyboard, mainMenuKeyboard } = require('../utils/keyboard');
const os = require('os');

// Split a long Markdown message into <=4096-char chunks on newline boundaries.
// Each guide line keeps its Markdown entities balanced, so splitting between
// lines never breaks the parse. Telegram's hard cap is 4096.
function splitForTelegram(text, limit = 3900) {
  if (!text || text.length <= limit) return [text];
  const lines = String(text).split('\n');
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    if (buf && buf.length + line.length + 1 > limit) {
      chunks.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ── Admin Guide — interactive, one section per button ─────────────────────────
const GUIDE_INTRO =
  `📖 *Admin Guide — Mental Gaming Store*\n` +
  `━━━━━━━━━━━━━━━━━━━━━\n` +
  `_အကန့်တစ်ခုချင်း button နှိပ်ပြီး ရှင်းလင်းချက် + 🎬 လက်တွေ့ ဥပမာ ဖတ်ပါ။_\n\n` +
  `👑 *Owner* — အားလုံး ထိန်းချုပ်\n` +
  `🧑‍💼 *Manager* — analytics, product, rate, broadcast\n` +
  `🧑‍🔧 *Staff* — order, support ticket\n\n` +
  `💡 အကန့်တိုင်းမှာ *🎬 ဥပမာ* — ဘယ် button/command နှိပ် → ဘာဖြစ်မယ် ဆိုတာ အဆင့်လိုက် ပြထားပါတယ်။`;

const GUIDE_SECTIONS = [
  {
    key: 'overview', label: '🏠 အခြေခံ',
    body:
      `🏠 *အခြေခံ — Admin Panel ဘယ်လိုသုံးမလဲ*\n\n` +
      `အောက်ခြေက persistent button (keyboard) တွေက အဓိက menu ဖြစ်ပါတယ်။ Button တစ်ခု နှိပ်လိုက်ရင် အဲ့အကန့် ပွင့်လာမယ်။\n\n` +
      `Admin အဆင့် ၃ ဆင့်:\n` +
      `👑 *Owner* — အရာအားလုံး\n` +
      `🧑‍💼 *Manager* — product, rate, analytics, broadcast\n` +
      `🧑‍🔧 *Staff* — order စီမံ, support ticket\n\n` +
      `🎬 *ဥပမာ — Admin Panel ဖွင့်နည်း:*\n` +
      `1️⃣ chat ထဲ \`/admin\` ရိုက် (သို့) အောက်က ⌨️ menu က *🔧 Admin Panel* နှိပ်\n` +
      `2️⃣ → Pending order / active product / user အရေအတွက် ပါတဲ့ panel ပေါ်လာမယ်\n` +
      `3️⃣ လိုချင်တဲ့ အကန့် button (📦 Orders / 🛍️ Products…) ဆက်နှိပ်\n\n` +
      `_ဒီ Guide ထဲက အကန့်တစ်ခုချင်း ရွေးဖတ်နိုင်ပါတယ်။_`,
  },
  {
    key: 'dashboard', label: '📊 Dashboard',
    body:
      `📊 *Dashboard* _(Manager+)_\n\n` +
      `လုပ်ငန်း အခြေအနေ တိုက်ရိုက် ကြည့်ရန်:\n` +
      `• Pending / Processing order အရေအတွက်\n` +
      `• Active product, စုစုပေါင်း user\n` +
      `• Payment gateway အခြေအနေ panel\n\n` +
      `🎬 *ဥပမာ — ဒီနေ့ အခြေအနေ စစ်နည်း:*\n` +
      `1️⃣ \`/dashboard\` ရိုက် (သို့ menu → *📊 Dashboard*)\n` +
      `2️⃣ → "Pending: 3 | Processing: 1 | Users: 250" စတဲ့ live card ပေါ်မယ်\n` +
      `3️⃣ Pending အရေအတွက် ရှိရင် → *📦 Manage Orders* သွားပြီး ဆက်ကိုင်\n\n` +
      `_နေ့စဉ် ပထမဆုံး ဝင်ကြည့်သင့်တဲ့ နေရာ။_`,
  },
  {
    key: 'orders', label: '📦 Manage Orders',
    body:
      `📦 *Manage Orders* _(Staff+)_\n\n` +
      `• Pending order စာရင်း — Game ID, ဝယ်သူ, ပမာဏ ပြ\n` +
      `• 🔄 *Processing* → ဝယ်သူဆီ auto အကြောင်းကြား\n` +
      `• ✅ *Complete* → delivery receipt ပို့\n` +
      `• ❌ *Cancel & Refund* → wallet ပြန်အမ်း + အကြောင်းပြ\n` +
      `• ကြာနေတဲ့ order (default ၃၀ မိနစ်) → support alert\n\n` +
      `🎬 *ဥပမာ — order တစ်ခု ပြီးအောင် ကိုင်နည်း:*\n` +
      `1️⃣ ဝယ်သူ order တင်ပြီး → menu က *📦 Manage Orders* နှိပ်\n` +
      `2️⃣ Pending order ကို နှိပ် → အသေးစိတ် (Game ID, ပမာဏ) ပေါ်မယ်\n` +
      `3️⃣ *🔄 Processing* နှိပ် → ဝယ်သူ chat ထဲ "🔄 လုပ်ဆောင်နေပါပြီ" auto ရောက်\n` +
      `4️⃣ ဂိမ်းထဲ ဖြည့်ပြီးရင် *✅ Complete* နှိပ် → ဝယ်သူဆီ delivery receipt + timeline ရောက်\n` +
      `❌ *ပြဿနာရှိရင်:* *Cancel & Refund* နှိပ် → အကြောင်းရိုက်ထည့် → ဝယ်သူ wallet ကို ငွေ auto ပြန်ဝင်\n\n` +
      `_Order တစ်ခုချင်းအတွက် status thread ကို ဝယ်သူ chat ထဲ auto ဖန်တီးပေးတယ်။_`,
  },
  {
    key: 'products', label: '🛍️ Manage Products',
    body:
      `🛍️ *Manage Products* _(Manager+)_\n\n` +
      `• 📋 *List Products* — အားလုံး ကြည့်/တည်းဖြတ်/ဖျက်/စျေးပြင်/on-off\n` +
      `• ➕ *Add Product* — တစ်ခုချင်း အသစ် (category → နာမည် → စျေး…)\n` +
      `• 📦 *Bulk Import* — အများကြီး တစ်ခါတည်း (template သို့ ကိုယ့် list \`နာမည် - စျေး\` paste)\n` +
      `• ⚡ *Flash Sale* — အချိန်ကန့် စျေးလျှော့\n` +
      `• 🎁 *Add Codes* — gift card / account code သိမ်း (auto delivery)\n\n` +
      `🎬 *ဥပမာ ၁ — product အသစ် ထည့်နည်း:*\n` +
      `1️⃣ menu → *🛍️ Manage Products* → *➕ Add Product* နှိပ်\n` +
      `2️⃣ category ရွေး (ဥပမာ "MLBB Diamonds") → နာမည်ရိုက် ("86 💎") → စျေးရိုက် ("4500")\n` +
      `3️⃣ → product က shop ထဲ ချက်ချင်း ပေါ်လာမယ်\n\n` +
      `🎬 *ဥပမာ ၂ — Flash Sale ဖွင့်နည်း:*\n` +
      `1️⃣ *⚡ Flash Sale* နှိပ် → product ရွေး → လျှော့စျေး + ကြာချိန် ထည့်\n` +
      `2️⃣ → ဝယ်သူ shop မှာ ⚡ တံဆိပ်နဲ့ လျှော့စျေး တန်းပေါ်မယ် (အချိန်ပြည့်ရင် auto ပြန်ပုံမှန်)`,
  },
  {
    key: 'catalogs', label: '📂 Catalogs (Category)',
    body:
      `📂 *Catalogs — Category စီမံ* _(Owner)_\n\n` +
      `*Manage Products → 📂 Catalogs* ကနေ ဝင်ပါ။\n` +
      `ပထမဆုံး *top-level category* တွေပဲ ပြပါမယ်။ category တစ်ခု နှိပ်ရင် အထဲက *sub-category* တွေကို သီးသန့် ပြပေးတယ် — အမြင်ရှင်းအောင်။\n\n` +
      `• ➕ *Add Catalog* — top-level category အသစ်\n` +
      `• ↳ sub-category button — အထဲ ဝင်ကြည့်\n` +
      `• ➕ *Add Sub-Category* — အဲ့ category အောက် sub အသစ် တိုက်ရိုက်ထည့်\n` +
      `• 🔗 *Set Parent* — ရှိပြီးသား category ကို တခြားအောက် ရွှေ့\n` +
      `• ⬆️ *Move Up* / ⬇️ *Move Down* — shop အစီအစဉ် ရွှေ့\n` +
      `• 📌 *Pin Top* — ချက်ချင်း ထိပ်ဆုံးတင်\n` +
      `• ⚡ *Quick-Setup* — checkout field (Game ID/Server ID) အမြန်ထည့်\n` +
      `• 🖼 *Set Image*, 🔀 *Toggle Active*, 🗑 *Delete*\n\n` +
      `🎬 *ဥပမာ — category + sub-category ဖွဲ့နည်း:*\n` +
      `1️⃣ *📂 Catalogs* → *➕ Add Catalog* → "Mobile Legends" ရိုက်\n` +
      `2️⃣ "Mobile Legends" button နှိပ်ဝင် → *➕ Add Sub-Category* → "Diamonds" ရိုက်\n` +
      `3️⃣ *⚡ Quick-Setup* နှိပ် → Game ID + Server ID checkout field ချက်ချင်း ထည့်\n` +
      `4️⃣ → ဝယ်သူ shop မှာ Mobile Legends ▸ Diamonds ဖြင့် တွေ့ရမယ်\n\n` +
      `_Product ရှိမှ category က shop ထဲ ပေါ်မယ်။ အစီအစဉ်က shop chat + Open Store နှစ်ခုစလုံး သက်ရောက်တယ်။_`,
  },
  {
    key: 'users', label: '👥 Manage Users',
    body:
      `👥 *Manage Users* _(Owner)_\n\n` +
      `• 👥 Manage Users ခလုတ် → *📋 All Users* — user တစ်ယောက်ချင်း ခလုတ်နှိပ်ပြီး ကြည့်လို့ရ\n` +
      `• User Card ထဲမှာ — 📦 *Orders* (ဘာဝယ်ထားလဲ), 💰 *Topup History* (ငွေဖြည့်မှတ်တမ်း), ⏳ *Pending Topup* (ရောက်မရောက် စစ်/Approve)\n` +
      `• \`/users <name|id>\` — ရှာ, \`/userinfo\` — အသေးစိတ်\n` +
      `• ⚠️ *Warn* / Unwarn, 🚫 *Ban* / Unban\n` +
      `• 🔒 *Restrict* (order/topup/spin) / 🔓 Remove\n` +
      `• 💳 *Adjust Balance* — လက်ဖြင့် ငွေထည့်/နုတ် (audit ချက်ချင်း)\n` +
      `• \`/penalize\` — fraud ဒဏ်\n\n` +
      `🎬 *ဥပမာ ၁ — user ငွေဖြည့်ထားတာ ရောက်မရောက် စစ်နည်း:*\n` +
      `1️⃣ 👥 Manage Users → 📋 All Users → user ခလုတ် နှိပ်\n` +
      `2️⃣ *💰 Topup History* နှိပ် → ⏳ Pending ရှိရင် ခလုတ်ပေါ်မယ်\n` +
      `3️⃣ *⏳ Pending Topup စစ်ရန်* နှိပ် → screenshot + ✅ Approve နှိပ်ရင် ငွေ ချက်ချင်းဝင်\n\n` +
      `🎬 *ဥပမာ ၂ — user ကို ငွေ ထည့်ပေးနည်း:*\n` +
      `1️⃣ User card မှာ *💳 Adjust Balance* နှိပ် → "+5000" ရိုက်\n` +
      `2️⃣ → user wallet ကို 5000 KS ဝင် + audit log မှာ auto မှတ်\n\n` +
      `🎬 *ဥပမာ ၃ — မကောင်းတဲ့ user ban လုပ်နည်း:*\n` +
      `1️⃣ User card မှာ *🚫 Ban* နှိပ် → user က bot သုံးလို့ မရတော့ (Unban နဲ့ ပြန်ဖွင့်နိုင်)`,
  },
  {
    key: 'rates', label: '💱 Manage Rates',
    body:
      `💱 *Manage Rates* _(Manager+)_\n\n` +
      `• \`/rates\` — လက်ရှိ နှုန်း ကြည့်\n` +
      `• \`/fetchrates\` — USD/CNY/THB live ဆွဲ\n` +
      `• \`/managerates\` — အားလုံး တစ်ခါတည်း approve + product အလိုက် ပြင်\n\n` +
      `🎬 *ဥပမာ — နှုန်း update လုပ်နည်း:*\n` +
      `1️⃣ \`/fetchrates\` ရိုက် → live USD/CNY/THB နှုန်း ဆွဲလာမယ်\n` +
      `2️⃣ \`/managerates\` ရိုက် → နှုန်းသစ်တွေ ပြ → *✅ Approve* နှိပ်\n` +
      `3️⃣ → အဲ့ ငွေကြေးနဲ့ ချိတ်ထားတဲ့ product စျေးတွေ auto ပြန်တွက်ပေးမယ်`,
  },
  {
    key: 'broadcast', label: '📢 Broadcast',
    body:
      `📢 *Broadcast & Channel Posts* _(Owner)_\n\n` +
      `• *Broadcast* — user အားလုံး / tier အလိုက် / active (၃၀ ရက်) ဆီ message (စာ + ပုံ)\n` +
      `• Admin menu → *📣 Announce* ခလုတ် (သို့ \`/announce\`) — *Product ကြေညာချက်* — product စာရင်းထဲက ရွေး → 🆕 New Product / ⚡ Flash Sale ပုံစံရွေး → *bot user အားလုံး + ကြေညာချက် channel နှစ်ခုလုံး* ကို 🛒 ဝယ်မယ့်ခလုတ်နဲ့တကွ တစ်ပြိုင်နက် ပို့ပေးမယ်\n` +
      `• \`/addchannelpost\` — channel ကို နေ့စဉ် auto post (HH:MM MMT)\n` +
      `• \`/listchannelposts\`, \`/sendchannelpost\`, \`/togglechannelpost\`, \`/delchannelpost\`\n` +
      `• \`/setseason\` — အခါသမယ theme (Thingyan/Christmas…)\n\n` +
      `🎬 *ဥပမာ — product ကြေညာနည်း:*\n` +
      `1️⃣ menu → *📣 Announce* နှိပ် (သို့ \`/announce\` ရိုက်) → product ခလုတ်တွေထဲက တစ်ခု ရွေး\n` +
      `2️⃣ ပုံစံရွေး — 🆕 New Product (ဒါမှမဟုတ် flash sale price သတ်မှတ်ထားရင် ⚡ Flash Sale)\n` +
      `3️⃣ → user အားလုံး + channel မှာ "🛒 ဝယ်မယ်" ခလုတ်ပါတဲ့ ကြေညာစာ တစ်ပြိုင်နက် ရောက်မယ်\n\n` +
      `🎬 *ဥပမာ ၁ — user အားလုံးဆီ message ပို့နည်း:*\n` +
      `1️⃣ menu → *📢 Broadcast* နှိပ် → ဘယ်သူဆီပို့မလဲ ရွေး (👥 All / tier / active)\n` +
      `2️⃣ ပို့မယ့် စာ (ဒါမှမဟုတ် ပုံ+စာ) ရိုက်ထည့် → *✅ Send* အတည်ပြု\n` +
      `3️⃣ → ရွေးထားတဲ့ user တိုင်းဆီ တစ်ပြိုင်တည်း ရောက်မယ်\n\n` +
      `🎬 *ဥပမာ ၂ — channel ကို နေ့စဉ် auto-post:*\n` +
      `1️⃣ \`/addchannelpost\` → channel ရွေး → စာ ရိုက် → အချိန် "09:00" ထည့်\n` +
      `2️⃣ → နေ့တိုင်း မနက် ၉ နာရီ (MMT) channel မှာ auto တင်ပေးမယ်`,
  },
  {
    key: 'promotions', label: '🎟 Promotions',
    body:
      `🎟 *Promotions* _(Owner)_\n\n` +
      `• \`/createpromo\` — Flat/Percent လျှော့, အနည်းဆုံး order, အသုံးအကြိမ်, သက်တမ်း\n` +
      `• \`/listpromos\`, \`/deletepromo\`\n\n` +
      `🎬 *ဥပမာ — promo code ဖန်တီးနည်း:*\n` +
      `1️⃣ \`/createpromo\` ရိုက် → code ("YKKO10") → အမျိုးအစား (Percent 10%)\n` +
      `2️⃣ အနည်းဆုံး order (5000) + အသုံးအကြိမ် (100) + သက်တမ်း ထည့်\n` +
      `3️⃣ → ဝယ်သူတွေ checkout မှာ "YKKO10" ရိုက်ရင် 10% လျှော့ရမယ်\n` +
      `_(စာရင်းကြည့်: \`/listpromos\` — ဖျက်: \`/deletepromo\`)_`,
  },
  {
    key: 'rewards', label: '🎁 Rewards & Codes',
    body:
      `🎁 *Coin Rewards & Redeem Codes* _(Owner)_\n\n` +
      `Admin Panel ထဲက *🎁 Rewards* button ကနေ ဝင်ပါ (button တွေနဲ့ အကုန် စီမံနိုင် — id ရိုက်စရာ မလို)။\n\n` +
      `*🎁 Reward Items* — ဝယ်သူ *Mental Coin (MC)* သုံးပြီး လဲ:\n` +
      `• *🎁 Reward Items* → *➕ Add Reward* — ဆု အသစ် (နာမည် → MC စျေး → product သို့ coupon)\n` +
      `• ဆုတစ်ခုချင်းဘေးက *⚪️ Hide / 🟢 Show* — ဖွင့်/ဖွက်\n` +
      `• *🗑* — ဖျက် (အတည်ပြုချက် တောင်းမယ်)\n\n` +
      `*🎟 Redeem Codes* — ကုဒ်ဖြင့် ဆု (အခမဲ့၊ ကုဒ်က ပေးချေမှု):\n` +
      `• *🎟 Redeem Codes* → *➕ Add Code* — ကုဒ် အသစ် (\`auto\` ရိုက်ရင် အလိုအလျောက် ထုတ်ပေး → product သို့ coupon)\n` +
      `• ကုဒ်တစ်ခုချင်းဘေးက *🔴 Off / 🟢 On* — ဖွင့်/ပိတ်\n` +
      `• *🗑* — ဖျက် (အတည်ပြုချက် တောင်းမယ်)\n\n` +
      `🎬 *ဥပမာ ၁ — MC နဲ့ လဲလို့ရတဲ့ ဆု ထည့်နည်း:*\n` +
      `1️⃣ *🎁 Rewards* → *🎁 Reward Items* → *➕ Add Reward*\n` +
      `2️⃣ နာမည် ("Free 11💎") → MC စျေး (500) → အမျိုးအစား (📦 Product) ရွေး\n` +
      `3️⃣ → ဝယ်သူ 🎁 Coin Rewards မှာ MC 500 နဲ့ လဲယူနိုင်\n\n` +
      `🎬 *ဥပမာ ၂ — redeem code ထုတ်နည်း:*\n` +
      `1️⃣ *🎟 Redeem Codes* → *➕ Add Code* → code မှာ \`auto\` ရိုက် (bot က code auto ထုတ်)\n` +
      `2️⃣ → ဝယ်သူ က checkout ရဲ့ 🎟 Promo Code နေရာ (သို့) \`/redeem\` မှာ ရိုက်ထည့်ရင် ဆု ချက်ချင်းရ\n\n` +
      `ဆု ၂ မျိုး: 📦 *Product* (order auto ဖန်တီး → Manage Orders မှာ complete လုပ်) / 🎟 *Coupon* (ဝယ်သူဆီ personal code ချက်ချင်း ရောက်)။\n` +
      `_Command အဖြစ်လည်း ရ: \`/addreward\` \`/listrewards\` \`/addcode\` \`/listcodes\`_`,
  },
  {
    key: 'support', label: '🎫 Support Tickets',
    body:
      `🎫 *Support Tickets* _(Staff+)_\n\n` +
      `• \`/tickets\` — Open + InProgress\n` +
      `• \`/tickets all\` — resolved/archived ပါ\n` +
      `• Reply / Resolve / Assign / Archive / Urgent\n` +
      `• 📜 Template library — အမြန် ပြန်ဖြေ\n` +
      `• 📨 *Support Contact သတ်မှတ်ရန်* ခလုတ် (သို့ \`/setsupportcontact\`) — /support ထဲက "Admin ကို တိုက်ရိုက် စာပို့ရန်" ခလုတ်နှိပ်ရင် ရောက်မယ့် account ကို ခလုတ်နဲ့ ပြောင်း/ဖျက် (Owner)\n\n` +
      `🎬 *ဥပမာ — ticket တစ်ခု ဖြေရှင်းနည်း:*\n` +
      `1️⃣ \`/tickets\` ရိုက် → Open ticket စာရင်း ပေါ်မယ်\n` +
      `2️⃣ ticket နှိပ် → *✍️ Reply* နှိပ် → ဖြေမယ့်စာ ရိုက် (သို့ 📜 Template ရွေး)\n` +
      `3️⃣ ပြီးရင် *✅ Resolve* နှိပ် → ticket ပိတ်\n\n` +
      `_ဝယ်သူ မေးခွန်းတွေကို AI က ရှေ့ဆုံးဖြေ၊ မဖြေနိုင်ရင် ticket auto ဖွင့်ပေးတယ်။_`,
  },
  {
    key: 'analytics', label: '📈 Analytics & AI',
    body:
      `📈 *Analytics & AI* _(Manager+)_\n\n` +
      `• \`/analytics [today|week|month]\` — ဝင်ငွေ/အမြတ် dashboard\n` +
      `• \`/analyticsai\` — 🤖 Gemini စီးပွားရေး report\n` +
      `• \`/forecast\` — ၇ ရက် ရောင်းအား ခန့်မှန်း\n` +
      `• \`/sentimentreport\` — review စိတ်ခံစားမှု\n` +
      `• \`/exportdetail\` — CSV (orders/transactions/users)\n\n` +
      `🎬 *ဥပမာ — အပတ်စဉ် ဝင်ငွေ ကြည့်နည်း:*\n` +
      `1️⃣ \`/analytics week\` ရိုက် → ၇ ရက်စာ ဝင်ငွေ/အမြတ်/order dashboard ပေါ်မယ်\n` +
      `2️⃣ ပိုနက်နဲတဲ့ analysis လိုရင် \`/analyticsai\` → 🤖 Gemini က စီးပွားရေး report ရေးပေးမယ်\n` +
      `3️⃣ Excel/CSV လိုရင် \`/exportdetail\` → orders/transactions/users ဖိုင် ရနိုင်`,
  },
  {
    key: 'spin', label: '🎰 Spin & Referral',
    body:
      `🎰 *Spin & Referral* _(Owner)_\n\n` +
      `⚠️ *Reward policy:* Gamification ဆု (Spin / Daily Check-in / Referral) အားလုံးကို *Mental Coin (MC)* နဲ့သာ ပေးပါတယ်။ Refund / Top-up / Admin manual credit တွေကတော့ KS အတိုင်း ဆက်ရှိပါတယ်။\n\n` +
      `*Spin Wheel:* \`/dashboard → 🎰 Spin\` ကနေ custom ဆု (coin/cash/free spin) ထည့်နိုင်\n` +
      `_(\`cash\` အမျိုးအစား ဆုကိုတောင် MC အဖြစ်ပဲ ပေးပါတယ်။)_\n\n` +
      `*Referral:*\n` +
      `• \`/setreftiers 1:2 6:3 16:5\` — commission tier\n` +
      `• \`/reftiers\` — ကြည့်\n` +
      `• \`/togglereferral\` — ရပ်/ဖွင့်\n` +
      `• \`/reffraud\` — fraud စစ်\n\n` +
      `🎬 *ဥပမာ ၁ — Spin ဆု အသစ် ထည့်နည်း:*\n` +
      `1️⃣ \`/dashboard\` → *🎰 Spin* → *➕ Add Custom Reward*\n` +
      `2️⃣ label ("50 MC") → amount (50) → weight (probability) ထည့်\n` +
      `3️⃣ → ဝယ်သူ spin လှည့်ရင် အဲ့ဆု ပါလာနိုင်\n\n` +
      `🎬 *ဥပမာ ၂ — referral commission သတ်မှတ်နည်း:*\n` +
      `1️⃣ \`/setreftiers 1:2 6:3 16:5\` ရိုက် → Bronze 2%, Silver 3%, Gold 5%\n` +
      `2️⃣ \`/reftiers\` နဲ့ ပြန်စစ် → referral ဖိတ်တဲ့သူဆီ commission ကို *MC* နဲ့ ပေးမယ်`,
  },
  {
    key: 'coins', label: '🪙 Coins & Tiers',
    body:
      `🪙 *Coins & Tiers Config* _(Owner)_\n\n` +
      `Admin menu → *🪙 Coins & Tiers* (သို့) \`/coinsconfig\`\n\n` +
      `Membership tier (🥈 Silver / 🥇 Gold / 💎 Platinum) benefit များ ပြင်ရန်:\n` +
      `• 🪙 *Edit Coin Rates* — top-up အတွက် Mental Coin bonus %\n` +
      `• 📊 *Edit Tier Thresholds* — tier တက်ရန် လိုသော စုစုပေါင်း သွင်းငွေ (KS)\n` +
      `• 🏷 *Edit Tier Discounts* — tier အလိုက် စျေးလျှော့ %\n` +
      `• 🏆 *Loyalty Tiers* — Profile ထဲက tier (🥉 Bronze→💎 Diamond) များ ပြင်ဆင်/အသစ်ထည့်\n` +
      `• 💳 *Adjust User Balance* — user balance ချိန်ညှိ\n\n` +
      `🎬 *ဥပမာ — tier discount ပြင်နည်း:*\n` +
      `1️⃣ \`/coinsconfig\` (သို့ menu → *🪙 Coins & Tiers*) → *🏷 Edit Tier Discounts*\n` +
      `2️⃣ tier ရွေး (ဥပမာ 🥇 Gold) → discount % ("5") ရိုက်\n` +
      `3️⃣ → Gold user တိုင်း order တိုင်းမှာ 5% auto လျှော့ရမယ်\n\n` +
      `*🏆 Loyalty Tiers editor:*\n` +
      `• tier တစ်ခုကို နှိပ်ပြီး — 📊 Min Spend / 🪙 Bonus % / 😀 Emoji / 🎁 Benefits ပြင်နိုင်\n` +
      `• *➕ Add Tier* — tier အသစ် ထည့်နိုင် (name → min → bonus% → emoji)\n` +
      `• *🗑 Delete Tier* — tier ဖျက်နိုင် (နောက်ဆုံး တစ်ခုတည်း ကျန်ရင် မဖျက်နိုင်)\n` +
      `• *♻️ Reset to Default* — မူရင်း tier များ ပြန်ထား\n\n` +
      `_ပြင်ပြီးရင် customer ရဲ့ tier က နောက် order ပြီးချိန်မှာ အလိုအလျောက် ပြန်တွက်ပါတယ်။_`,
  },
  {
    key: 'gateways', label: '💳 Payment Gateways',
    body:
      `💳 *Payment Gateways* _(Owner)_\n\n` +
      `Admin menu → *💳 Payment Gateways* — panel *တစ်ခုတည်း*မှာ ငွေပေးချေမှုနည်းလမ်း အားလုံးကို စီမံ။\n` +
      `_ဒီ panel ထဲက စာရင်းက ဝယ်သူတွေ topup မှာ မြင်ရတဲ့ စာရင်း အတိအကျ — admin မြင်တာ = user မြင်တာ။_\n\n` +
      `တစ်ခုချင်း ဝင်စရာ မလိုတော့ဘဲ button တွေနဲ့ တန်းလုပ်နိုင်:\n` +
      `• 🟢/🔴 *နာမည် button* — နှိပ်လိုက်တိုင်း On ↔ Off ပြောင်း (🔴 ဆို ဝယ်သူ မမြင်ရ)\n` +
      `• 🗑 — gateway ဖျက် (အတည်ပြုမှ ဖျက်)\n` +
      `• ➕ *Add New* — gateway အသစ် ၄ ဆင့်နဲ့ ထည့် (name → number → account name → emoji)\n` +
      `• 🔄 *Refresh* — စာရင်း ပြန် load\n\n` +
      `🎬 *ဥပမာ — admin မှာ ၄ ခုပြပြီး user မှာ ၂ ခုပဲ ပါနေရင်:*\n` +
      `1️⃣ menu → *💳 Payment Gateways* နှိပ်\n` +
      `2️⃣ 🔴 ပိတ်နေတဲ့ gateway (ဥပမာ 🔴 AYA Pay) ကို နှိပ် → 🟢 ဖြစ်သွားမယ်\n` +
      `3️⃣ → ချက်ချင်း ဝယ်သူ topup ထဲ AYA Pay ပေါ်လာမယ် (admin = user တူညီသွားပြီ)\n\n` +
      `_🟢 ပြထားသလောက်ပဲ ဝယ်သူ မြင်ရတာမို့ — ပြချင်တာ 🟢, ဖျောက်ချင်တာ 🔴 ထားပါ။_\n\n` +
      `⏳ *Pending Top-ups ပြန်ကြည့်နည်း* — \`/pendingtopups\` ရိုက်ရင် မစစ်ရသေးတဲ့ topup တောင်းဆိုမှုအားလုံး screenshot + Approve/Reject/Ask Info button တွေနဲ့ ပြန်ပြပေးပါတယ် (notification လွတ်သွားရင် ဒီကနေ ပြန်ရှာပါ)။`,
  },
  {
    key: 'accounts', label: '🔐 Premium Accounts',
    body:
      `🔐 *Premium Accounts* _(Owner)_\n\n` +
      `Account (ဥပမာ ExpressVPN) ရောင်းတဲ့ စနစ် — ဝယ်တာနဲ့ ဝယ်သူဆီ login/password (သို့) invite link *ချက်ချင်း* ရောက်။\n` +
      `_ရိုးရိုး product system နဲ့ လုံးဝ သီးသန့် — မရောထွေးပါ။_\n\n` +
      `📂 *အမျိုးအစား ၃ မျိုး* (➕ Add Product နှိပ်တာနဲ့ အရင်ရွေးရ):\n` +
      `• 👤 *Single* — login/password တစ်ခုကို လူတစ်ယောက်တည်း သုံး (ပုံမှန်)\n` +
      `• 📱 *Multi-device* — login/password တစ်ခုကို device အများ မျှသုံး (ဥပမာ ExpressVPN 8-device)\n` +
      `• 🔗 *Invite link* — link တစ်ခုကို member အများ ဝင် (ဥပမာ Duolingo family 5-member)\n` +
      `_📱/🔗 နှစ်မျိုးမှာ စျေးက *slot (device/member) တစ်ခုစီ* အလိုက် — ဝယ်သူက ဘယ်နှစ်ခု ဝယ်မလဲ ရွေးပြီး စုစုပေါင်း = စျေး × အရေအတွက်။ slot ပြည့်သွားရင် နောက် account/link ကို အလိုအလျောက် သုံးတယ်။_\n\n` +
      `Admin menu → *🔐 Accounts* (သို့ \`/accadmin\`):\n` +
      `• ➕ *Add Product* — အမျိုးအစားရွေး → service → plan → စျေး → သက်တမ်းရက် → (📱/🔗 ဆို: slot အရေအတွက်) → emoji\n` +
      `• 📥 *Stock/Account/Link ထည့်* — Single/Multi-device ဆို \`email:password\` တစ်ကြောင်းချင်း; Invite link ဆို link (\`https://...\`) တစ်ကြောင်းချင်း paste\n` +
      `• 🏷 *Discount* — % လျှော့စျေး (0 = ဖြုတ်)\n` +
      `• 📆 *Stock-date* — သက်တမ်း ရေတွက်ပုံ ပြောင်း (အောက်မှာ ရှင်း)\n` +
      `• 🔥 *Aging ဈေး* — သက်တမ်း နီးလာရင် ဈေးလျှော့ (အောက်မှာ ရှင်း)\n` +
      `• 💵 *စျေးပြင်* / 🟢🔴 *ဖွင့်-ပိတ်* / 🗑 *ဖျက်*\n\n` +
      `🎬 *ဥပမာ ၁ — ExpressVPN 8-device ရောင်းနည်း:*\n` +
      `1️⃣ *🔐 Accounts* → ➕ Add Product → 📱 Multi-device → "ExpressVPN" → "1 Month" → device တစ်ခု 3000 → 30 → device 8 → 🛡\n` +
      `2️⃣ 📥 Account ထည့် → \`myvpn@gmail.com:Pass123\` (account တစ်ခုကို device 8 ခုစာ ရောင်းပေးမယ်)\n` +
      `3️⃣ ဝယ်သူက ဝယ် → device ဘယ်နှစ်ခု ရွေး → စုစုပေါင်း = 3000 × device အရေအတွက် → login/pw ချက်ချင်းရ\n\n` +
      `🎬 *ဥပမာ ၂ — Duolingo family 5-member:*\n` +
      `1️⃣ ➕ Add Product → 🔗 Invite link → "Duolingo" → "Family" → member တစ်ခု 2000 → 30 → member 5 → 🦉\n` +
      `2️⃣ 📥 Link ထည့် → \`https://duolingo.com/invite/abc\` (link တစ်ခုကို member 5 ယောက်စာ)\n` +
      `3️⃣ ဝယ်သူက member အရေအတွက်ရွေး → invite link ချက်ချင်းရ\n\n` +
      `🎬 *ဥပမာ ၃ — Single (ပုံမှန်):*\n` +
      `➕ Add Product → 👤 Single → "Netflix" → "1 Month" → 15000 → 30 → 📺 → 📥 Stock ထည့် \`mail:pass\` → ဝယ်သူ ဝယ်တာနဲ့ account တစ်ခု ချက်ချင်းရ\n\n` +
      `ပုံမှန်အားဖြင့် *ဝယ်ချိန်မှ* သက်တမ်း စတွက် — ဝယ်သူက *🎟 ကျွန်ုပ်၏ Accounts* မှာ ကျန်ရက် အမြဲ ကြည့်နိုင်။\n` +
      `🤖 *Auto:* သက်တမ်း ၃ ရက်အလို + ကုန်ချိန်မှာ ဝယ်သူဆီ သတိပေးစာ အလိုအလျောက် ပို့ပေးတယ် (single + multi/invite နှစ်မျိုးလုံး)။\n` +
      `_Stock ကုန်ရင် ဝယ်လို့မရတော့ဘဲ ငွေလည်း မဖြတ်ပါ — stock အမြဲ ဖြည့်ထားပါ။_\n\n` +
      `📆 *Stock-date သက်တမ်း* _(ဥပမာ pre-paid VPN card, ကုန်ရက် သတ်မှတ်ထားတဲ့ account)_:\n` +
      `product card → *📆 Stock-date* နှိပ်ဖွင့်ရင် — သက်တမ်းက *stock ထည့်တဲ့နေ့* ကစ ရေတွက်တယ် (ဝယ်ချိန် မဟုတ်)။\n` +
      `• ဥပမာ 30-ရက် account ကို ဒီနေ့ထည့် → ၁၀ ရက်ကြာမှ ဝယ်တဲ့သူက *ကျန် ၂၀ ရက်* ပဲ ရမယ်။\n` +
      `• ကျန်ရက်ကို ဝယ်တဲ့နေရာ၊ ဝယ်ပြီး delivery၊ 🎟 My Accounts — နေရာတိုင်းမှာ ပြပေးတယ်။\n` +
      `• သက်တမ်းကုန်သွားတဲ့ မရောင်းရသေးတဲ့ stock ကို နေ့စဉ် *auto ဖယ်* ပေးတယ် (ဝယ်လို့ မရတော့)။\n` +
      `⚠️ ဖွင့်ခင်က ထည့်ထားပြီးသား stock တွေမှာ expiry မရှိ — အသစ်ပြန်ထည့်မှ သက်ရောက်တယ်။\n\n` +
      `🔥 *Aging ဈေး* _(Stock-date ဖွင့်ထားမှ အလုပ်လုပ်)_:\n` +
      `product card → *🔥 Aging ဈေး* → \`ကျန်ရက် လျှော့%\` ရိုက် (space ခြား):\n` +
      `• \`7 50\` = stock ကျန် ၇ ရက် အောက်ရောက်ရင် *-50%* လျှော့ရောင်း\n` +
      `• \`3 100\` = ကျန် ၃ ရက် အောက်ဆို *အခမဲ့* (100% လျှော့)\n` +
      `• ပိတ်ချင်ရင် \`off\`\n` +
      `_Fresh stock ကို ဈေးအပြည့်၊ သက်တမ်းနီးလာတဲ့ stock ကို လျှော့ရောင်း — မကုန်ခင် လက်ကျန် ရှင်းထုတ်ဖို့။_\n\n` +
      `🎁 *Free Giveaway* — account တွေကို *အခမဲ့* ဝေတဲ့စနစ် (*product တစ်ခုမက* တစ်ပြိုင်နက် ဖွင့်လို့ရ — product တစ်ခုကို giveaway တစ်ခု):\n` +
      `Admin menu → *🎁 Giveaway* (သို့ \`/giveaway\`, သို့ *🔐 Accounts* panel → 🎁 Free Giveaway) → giveaway စာရင်း ပေါ်လာမယ် → *➕ အခမဲ့ အသစ် ထည့်မယ်* နဲ့ product ရွေးပြီး ထည့် / ရှိပြီးသား တစ်ခုကို နှိပ်ဝင်ပြီး ကန့်သတ်ချက်တွေ ဖွင့်-ပိတ်:\n` +
      `⚠️ *👤 Single account* တွေပဲ giveaway လုပ်လို့ရ — multi-device / invite link account တွေ မရပါ။\n` +
      `• 📦 *အရေအတွက်* — ပထမဆုံး N ယောက်ပဲ (0 = stock ကုန်သည်အထိ)\n` +
      `• ⏰ *ရက်သတ်မှတ်* — ဒီနေ့ကစ N ရက်အတွင်းပဲ (0 = မကန့်သတ်)\n` +
      `• 📅 *Acc သက်တမ်း* — Telegram account N ရက်ကျော်မှ ရ (fake account ကာကွယ်၊ 0 = မစစ်)\n` +
      `• 🛒 *ဝယ်ဖူးမှ* — order တစ်ခါ အောင်မြင်ဖူးမှ ရ (ON/OFF)\n` +
      `• 📣 *Channel join* — ရွေးထားတဲ့ channel join ထားမှ ရ (bot က channel admin ဖြစ်ရမယ်)\n` +
      `→ 🟢 *စတင်မယ်* နှိပ်မှ user တွေ မြင်ရ / ရယူနိုင်မယ်။ 📢 *ကြေညာမယ်* နဲ့ user အားလုံး + announce channel ကို ပို့နိုင်။\n` +
      `_giveaway တစ်ခုကို user တစ်ယောက် တစ်ခါပဲ ရ (giveaway အများ ရှိရင် တစ်ခုချင်း သီးခြား ရ)။ quota ပြည့်/stock ကုန်ရင် အလိုအလျောက် ရပ်ပြီး owner ဆီ အကြောင်းကြားတယ်။ user ဘက်က /accounts ထဲ 🎁 ခလုတ် (သို့) /freebie နဲ့ ရယူနိုင်တယ် — အခမဲ့ များစွာ ရှိရင် စာရင်းက ရွေးဝင်ရ။_`,
  },
  {
    key: 'refcampaign', label: '🎯 Ref Campaign',
    body:
      `🎯 *Referral Campaign* _(Owner)_\n\n` +
      `"မိတ်ဆွေ N ယောက်ခေါ်ရင် ဆုရ" campaign စနစ် — တစ်ကြိမ်လျှင် campaign *တစ်ခုပဲ* ဖွင့်လို့ရ။\n\n` +
      `Admin menu → *🎯 Ref Campaign* (သို့ \`/refcamp\`):\n` +
      `• ➕ *New Campaign* — ၈ ဆင့် wizard:\n` +
      `   နာမည် → ဆုရဖို့ ref အရေအတွက် → ဆုအမျိုးအစား (🪙MC / 💵KS / 📦Product) → ဆုပမာဏ →\n` +
      `   max ref/user → max ဆု/user → *ဆုစုစုပေါင်း limit* → *ဖိတ်ခံရသူ acc သက်တမ်း အနည်းဆုံး (ရက်)*\n` +
      `• ⏹ *End* — campaign ပိတ် (မပြည့်သေးတဲ့ progress ပျက်၊ နောက် campaign အသစ် 0 ကစ)\n` +
      `• 📊 *Top ပါဝင်သူများ* — ဘယ်သူ ref ဘယ်နှစ်ယောက် ခေါ်ပြီးပြီ\n\n` +
      `🎬 *ဥပမာ — "ref 5 ယောက် = ExpressVPN အလကား" (ဆု 20 ခုပဲ):*\n` +
      `1️⃣ ➕ New Campaign → နာမည် → 5 → 📦 Product → "ExpressVPN 1 Month" → 0 → 1 → 20\n` +
      `2️⃣ \`/launchbroadcast\` နဲ့ ကြေညာ — ဝယ်သူတွေက \`/campaign\` မှာ progress ကြည့်နိုင်\n` +
      `3️⃣ တစ်ယောက်ယောက် ref 5 ယောက်ပြည့်ရင် → ဆုအလိုအလျောက်ရ (Product ဆို owner ဆီ "ပို့ပေးပါ" စာရောက်)\n` +
      `4️⃣ ဆု 20 ခု ပြည့်တာနဲ့ campaign *အလိုအလျောက် ပိတ်* — owner ဆီ အကြောင်းကြားစာ ရောက်\n\n` +
      `_Ref 1 ယောက် = မိတ်ဆွေက link နဲ့ဝင်ပြီး ပထမဆုံး ငွေဖြည့်မှ တွက်ပါတယ် (commission စနစ်နဲ့ တူတူ)။_\n\n` +
      `🛡 *Acc သက်တမ်း စစ်ဆေးမှု:* ဖိတ်ခံရသူရဲ့ Telegram account သက်တမ်းကို ID ကနေ *ခန့်မှန်း* တွက်ပြီး သတ်မှတ်ရက်မပြည့်ရင် campaign မှာ မတွက်ပါ (fake account ကာကွယ်ရေး)။ ပုံမှန် commission ကတော့ ရနေမြဲပါ။`,
  },
  {
    key: 'joinbonus', label: '📣 Join Bonus',
    body:
      `📣 *Channel Join Bonus* _(Owner)_\n\n` +
      `Channel join ရင် MC ပေးတဲ့ စနစ် — *force join မဟုတ်ပါ*၊ ဆန္ဒရှိမှ ဝင်တာပါ။\n\n` +
      `Admin menu → *📣 Join Bonus Admin* (သို့ \`/joinbonusadmin\`):\n` +
      `• ➕ *Add* — ၃ ဆင့် (channel → ပြမယ့်နာမည် → MC ပမာဏ)\n` +
      `• 📢 — user အားလုံးဆီ ကြေညာစာ ပို့ (join link + claim button ပါပြီးသား) — *ကြေညာချက် channel သတ်မှတ်ထားရင် channel မှာပါ တစ်ပြိုင်နက် တင်ပေးမယ်*\n` +
      `• 🟢🔴 ဖွင့်-ပိတ် / 🗑 ဖျက်\n\n` +
      `⚠️ *အရေးကြီး:* Bot ကို channel ထဲ *admin* အဖြစ် အရင်ထည့်ပါ — မဟုတ်ရင် member ဝင်မဝင် စစ်လို့မရပါ။\n\n` +
      `🎬 *ဥပမာ — "News channel join ရင် 50 MC":*\n` +
      `1️⃣ Bot ကို channel မှာ admin ထည့်\n` +
      `2️⃣ *📣 Join Bonus Admin* → ➕ Add → \`@mychannel\` → "MGS News" → 50\n` +
      `3️⃣ 📢 နှိပ် → user အားလုံးဆီ ကြေညာစာရောက်\n` +
      `4️⃣ User က channel ဝင် → ✅ Claim နှိပ် → bot က member ဟုတ်မဟုတ် စစ်ပြီး 50 MC ချက်ချင်းပေး (တစ်ယောက် တစ်ခါပဲ)\n\n` +
      `_ဝယ်သူတွေက \`/joinbonus\` နဲ့လည်း ကြည့်နိုင်ပါတယ်။_`,
  },
  {
    key: 'promoperks', label: '🎁 Promo Perks',
    body:
      `🎁 *Promotion Perks* _(Owner)_\n\n` +
      `Admin menu → *🎁 Promo Perks* ခလုတ် (သို့ \`/promoperks\`) — panel တစ်ခုတည်းကနေ promotion ၆ မျိုး ထိန်းချုပ်နိုင်ပါတယ်:\n\n` +
      `🎂 *Birthday Gift* — user က \`/setbirthday\` နဲ့ မွေးနေ့မှတ်ထားရင် မွေးနေ့ရောက်တိုင်း MC လက်ဆောင် အလိုအလျောက်ပေး (တစ်နှစ် တစ်ခါပဲ)\n` +
      `⏰ *Happy Hour* — သတ်မှတ်ထားတဲ့ နာရီအတွင်း (MMT) ငွေဖြည့်ရင် MC bonus ပိုပေး (ဥပမာ ညနေ 6–8 နာရီ +5%)\n` +
      `💸 *Cashback* — order ပြီးမြောက်တိုင်း order တန်ဖိုးရဲ့ % ကို MC နဲ့ ပြန်အမ်း\n` +
      `🛒 *First Order Discount* — user ရဲ့ ပထမဆုံး order မှာ % လျှော့ပေး (order စာမျက်နှာမှာ အလိုအလျောက်ပေါ်)\n` +
      `😴 *Win-back* — ရက်အတော်ကြာ ပျောက်နေတဲ့ user တွေဆီ "ပြန်လာပါ" စာ + MC bonus အလိုအလျောက်ပို့ (90 ရက်အတွင်း တစ်ခါပဲ)\n` +
      `📊 *Monthly Leaderboard* — လစဉ် အဝယ်အများဆုံး Top တွေကို လကုန်ရင် MC ဆု အလိုအလျောက်ချီးမြှင့်; user တွေက \`/toplist\` နဲ့ ကြည့်နိုင်\n\n` +
      `🎬 *ဥပမာ:*\n` +
      `1️⃣ \`/promoperks\` → 💸 Cashback % → \`2\` ရိုက် → order တိုင်း 2% MC ပြန်ရ\n` +
      `2️⃣ ⏰ HH အချိန်/% → \`18-20-5\` → ညနေ 6–8 နာရီ Happy Hour ဖွင့်\n` +
      `3️⃣ 📊 LB ဆုများ → \`3000 2000 1000\` → လကုန်ရင် Top 3 ကို ဆုပေး\n\n` +
      `_Toggle ခလုတ်တွေနဲ့ တစ်ချက်နှိပ် ဖွင့်-ပိတ် လုပ်နိုင်ပါတယ်။_`,
  },
  {
    key: 'coupons', label: '🎟 Coupons',
    body:
      `🎟 *Coupon System* _(Owner)_\n\n` +
      `*၁။ Auto-Generate Coupon — menu → 🎟 Coupons ခလုတ် (သို့ \`/gencoupon\`)*\n` +
      `Code ကို bot က အလိုအလျောက်ထုတ်ပေး (ဥပမာ \`MGS-A3K9ZX\`)။ အဆင့် ၅ ဆင့်:\n` +
      `1️⃣ Discount — \`pct 10\` (10%) သို့ \`flat 500\` (500 KS)\n` +
      `2️⃣ Scope — \`all\` (အားလုံး) / \`cat MLBB\` (category) / \`prod diamond\` (product ရှာ)\n` +
      `3️⃣ လူဘယ်နှစ်ယောက်စာ — စုစုပေါင်း အသုံးပြုနိုင်မယ့် အကြိမ် (\`unlimited\` ရ)\n` +
      `4️⃣ တစ်ယောက် ဘယ်နှစ်ခါ — per-account limit\n` +
      `5️⃣ သက်တမ်း ရက် (\`never\` ရ)\n` +
      `➕ ထုတ်ပြီးရင် *📢 Channel မှာ ကြေညာမယ်* ခလုတ်နှိပ်ရင် — bot ထဲမှာ ရှိပြီးသား channel တွေ (auto-post, join bonus, ကြေညာချက် channel) အကုန် ခလုတ်နဲ့ပေါ်မယ်၊ တစ်ချက်နှိပ်ရုံ ကြေညာစာပို့နိုင်။ Channel စာရင်းကို ကြိုတင် စီမံချင်ရင် \`/channels\` panel မှာ ဒီတိုင်း ထည့်/ဖျက် လုပ်နိုင် (bot က channel admin ဖြစ်ရမယ်)\n\n` +
      `*၂။ Top-up Coupon (အလိုအလျောက်လက်ဆောင်)*\n` +
      `\`/promoperks\` → 🎟 TC ပြင်မယ် → \`10000-pct-5-7\` = 10,000 KS+ ဖြည့်တိုင်း 5% coupon (7 ရက်သက်တမ်း) အလိုအလျောက်ရ။ Toggle နဲ့ ဖွင့်-ပိတ်နိုင်။\n\n` +
      `*၃။ ဝယ်သူဘက်မြင်ကွင်း*\n` +
      `• \`/mycoupons\` — ကိုယ့် coupon တွေ + discount + သက်တမ်း ကြည့်\n` +
      `• Order တင်တဲ့ promo code အဆင့်မှာ သုံးလို့ရတဲ့ coupon တွေ ခလုတ်အနေနဲ့ ပေါ်ပြီး တစ်ချက်နှိပ် သုံးနိုင်\n` +
      `• Scope မကိုက်တဲ့ ပစ္စည်းမှာ သုံးရင် ငြင်းပယ်ပြီး ဘာတွေမှာသုံးလို့ရလဲ ပြောပြပေး\n\n` +
      `_ရိုးရိုး code ကိုယ်တိုင်သတ်မှတ်ချင်ရင် \`/createpromo\` ကို ဆက်သုံးနိုင်ပါတယ်။_`,
  },
  {
    key: 'system', label: '🔧 System',
    body:
      `🔧 *System* _(Owner)_\n\n` +
      `• \`/sysinfo\` — memory, CPU, DB, cache\n` +
      `• \`/runbackup\` — AES-256 backup လက်ဖြင့်\n` +
      `• \`/runcron\` — maintenance job လက်ဖြင့်\n` +
      `• \`/flushcache\` — cache ရှင်း\n` +
      `• \`/systemhealth\` — gateway + system\n` +
      `• \`/setgateway <method> <Online|Busy|Offline>\`\n` +
      `• \`/setbackupchan\`, \`/setstalesupport <min>\`\n` +
      `• \`/setsupportcontact @username\` — /support ထဲက 📨 "Admin ကို တိုက်ရိုက် စာပို့ရန်" ခလုတ်နှိပ်ရင် ရောက်မယ့် account သတ်မှတ် (\`off\` = owner username အလိုအလျောက် ပြန်သုံး)\n` +
      `• Admin menu → *📡 Channels* (သို့ \`/channels\`) — Channel စာရင်း panel: bot သိထားတဲ့ channel အားလုံး (auto-post, join bonus, ကြေညာချက်, backup, review, game update, သိမ်းထားတဲ့) tag နဲ့ ကြည့်/➕ ထည့်/🗑 ဖျက်။ ➕ နဲ့ channel ထည့်ရင် *ဘာအတွက်လဲ ရွေးခိုင်းမယ်* — 📅 Auto-post (ဆက်ပြီး post wizard ဝင်မယ်) / 📣 Join Bonus (ဆက်ပြီး reward wizard ဝင်မယ်) / 📢 ကြေညာချက် / 🔐 Backup / ⭐ Review (⭐4-5 customer review တွေ အလိုအလျောက်တင်) / 🎮 Game Update (channel ထဲ တင်တဲ့ update post တွေကို bot က ရက်စွဲနဲ့တကွ မှတ်ထားပြီး game မေးခွန်းလာရင် *post ထဲက စာကို တိုက်ရိုက် ဖြေပေးပြီး မူရင်း post link ကို 🔗 reference ခလုတ်နဲ့ တွဲပေးမယ်* — နောက်ဆုံး ၃ လစာပဲ သိမ်းမယ် — menu → *🎮 Game News* ခလုတ် (သို့ \`/gamenews\`) နဲ့ စစ်လို့ရ) / 📖 FAQ (Game Update လိုပဲ မေးရင် အဖြေ + 🔗 reference link နဲ့ ဖြေမယ် — ဒါပေမဲ့ *သက်တမ်းမကုန်ဘူး*၊ အမြဲတမ်းမေးခွန်းတွေ တင်ထားဖို့ — 🎮 Game News panel မှာပဲ တွဲစစ်လို့ရ) / 💾 ရိုးရိုးသိမ်း။ ထည့်ထားတဲ့ channel တွေက coupon ကြေညာတဲ့ picker မှာ အလိုအလျောက် ပေါ်မယ်\n\n` +
      `🎬 *ဥပမာ ၁ — data backup လက်ဖြင့် ဆွဲနည်း:*\n` +
      `1️⃣ \`/runbackup\` ရိုက် → bot က collection တွေ AES-256 encrypt လုပ်\n` +
      `2️⃣ → backup ဖိုင် (\`.json.gz.enc\`) ကို backup channel (သို့ owner DM) ဆီ ပို့ပေးမယ်\n\n` +
      `🎬 *ဥပမာ ၂ — gateway ပိတ်နည်း (busy):*\n` +
      `1️⃣ \`/setgateway KPay Busy\` ရိုက် → ဝယ်သူတွေ topup မှာ KPay "🟡 Busy" မြင်ရမယ်\n\n` +
      `🤖 *Auto (24/7):* Cron (3AM), Backup (6AM), Flash sale, Feedback, Sentiment, AntiSpam — background အလိုအလျောက်။`,
  },
  {
    key: 'audit', label: '📋 Audit Logs',
    body:
      `📋 *Audit Logs* _(Manager+)_\n\n` +
      `Admin လုပ်ဆောင်ချက်တိုင်း မှတ်တမ်းတင်: ဘယ်သူ / ဘာ / ဘယ်အချိန်။\n\n` +
      `🎬 *ဥပမာ — ဘယ်သူ ဘာလုပ်ခဲ့လဲ စစ်နည်း:*\n` +
      `1️⃣ menu → *📋 Audit Logs* နှိပ် (သို့ \`/auditlog\`)\n` +
      `2️⃣ → "Admin John — Adjusted balance +5000 — 10:30 AM" စတဲ့ မှတ်တမ်းတွေ စာရင်း ပေါ်မယ်\n\n` +
      `_Order status ပြောင်း, balance ပြင်, broadcast, category ပြင်… အားလုံး ခြေရာခံနိုင်။_`,
  },
];

function guideMenuKeyboard() {
  const rows = [];
  for (let i = 0; i < GUIDE_SECTIONS.length; i += 2) {
    rows.push(
      GUIDE_SECTIONS.slice(i, i + 2).map((s) => Markup.button.callback(s.label, `guide:${s.key}`))
    );
  }
  return Markup.inlineKeyboard(rows);
}

// ── Admin main nav — inline panel with live stats ─────────────────────────────

Nav.register({
  id: 'admin_main',
  title: '🔧 Admin Panel',
  build: async (ctx, theme) => {
    const [pending, processing, activeProducts, totalUsers] = await Promise.all([
      Order.countDocuments({ status: 'Pending' }),
      Order.countDocuments({ status: 'Processing' }),
      Product.countDocuments({ isActive: true }),
      User.countDocuments({}),
    ]);

    const text =
      `🔧 *Admin Panel — Mental Gaming Store*\n\n` +
      `🟡 Pending Orders: *${pending}*\n` +
      `🔵 Processing: *${processing}*\n` +
      `🛍️ Active Products: *${activeProducts}*\n` +
      `👥 Total Users: *${totalUsers}*\n\n` +
      `_Tap a button below to continue._`;

    // Reply keyboard only — admin uses persistent buttons, not inline
    return { text, keyboard: adminMenuKeyboard() };
  },
});

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerAdmin(bot) {

  // ── /admin command ─────────────────────────────────────────────────────────
  bot.command('admin', adminOnly(), async (ctx) => {
    await Nav.navigate(ctx, 'admin_main', false);
  });

  // ── Reply-keyboard handlers for admin menu buttons ─────────────────────────

  // 📦 Manage Orders → inline panel
  bot.hears('📦 Manage Orders', adminOnly(), async (ctx) => {
    const [pending, processing] = await Promise.all([
      Order.countDocuments({ status: 'Pending' }),
      Order.countDocuments({ status: 'Processing' }),
    ]);
    await ctx.reply(
      `📦 *Order Management*\n\n🟡 Pending: *${pending}*\n🔵 Processing: *${processing}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟡 View Pending', 'admin_pending_orders')],
          [Markup.button.callback('📋 All Orders',   'admin_all_orders')],
          [Markup.button.callback('🔙 Back',         'nav:go:admin_main')],
        ]),
      }
    );
  });

  // 🛍️ Manage Products → inline panel (no commands shown)
  bot.hears('🛍️ Manage Products', adminOnly(), async (ctx) => {
    const [total, active] = await Promise.all([
      Product.countDocuments({}),
      Product.countDocuments({ isActive: true }),
    ]);
    await ctx.reply(
      `🛍️ *Product Management*\n\n📦 Total: *${total}* | ✅ Active: *${active}* | 🔴 Inactive: *${total - active}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 List Products',  'pm_list_products')],
          [Markup.button.callback('➕ Add Product',    'admin_product_add')],
          [Markup.button.callback('📦 Bulk Import',    'bulk_import_start')],
          [Markup.button.callback('📂 Catalogs',       'admin_catalogs_action')],
          [Markup.button.callback('⚡ Flash Sale',      'pm_flashsale_help')],
          [Markup.button.callback('🎁 Add Codes',      'pm_addcodes_help')],
          [Markup.button.callback('🔙 Back',           'nav:go:admin_main')],
        ]),
      }
    );
  });

  bot.action('bulk_import_start', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const Catalog = require('../models/Catalog');
    const catalogs = await Catalog.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
    if (!catalogs.length) {
      return ctx.reply(
        '❌ No active catalogs yet.\n\nCreate a catalog first:\n📂 Admin → Products → Catalogs → Add Catalog',
        { ...Markup.inlineKeyboard([[Markup.button.callback('📂 Catalogs', 'admin_catalogs_action')]]) }
      );
    }
    ctx.session.catalogAction = 'bulk_select_catalog';
    const buttons = catalogs.map((c) => [Markup.button.callback(c.name, `bulk_cat:${c._id}`)]);
    buttons.push([Markup.button.callback('❌ Cancel', 'bulk_cancel')]);
    await ctx.reply('📦 *Bulk Add Products*\n\nSelect the catalog:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  });

  // 👥 Manage Users → inline panel
  bot.hears('👥 Manage Users', adminOnly(), async (ctx) => {
    await ctx.reply(`👥 *User Management*\n\nChoose an action:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 All Users', 'users_page:1')],
        [Markup.button.callback('🚫 Banned',    'users_banned'), Markup.button.callback('⚠️ Warned', 'users_warned')],
        [Markup.button.callback('📊 Stats',     'users_stats')],
        [Markup.button.callback('🔙 Back',      'nav:go:admin_main')],
      ]),
    });
  });

  // 💱 Manage Rates → show current rates + open rate manager
  bot.hears('💱 Manage Rates', adminOnly(), async (ctx) => {
    const rates = await getAllRates();
    if (!rates.length) {
      return ctx.reply('No exchange rates yet. Use /managerates to set up.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Open Rate Manager', 'open_rate_manager')]]),
      });
    }
    const lines = rates.map((r) =>
      `• *${r.currencyCode}*: \`${parseFloat(r.rateToMMK.toFixed(4))}\` MMK  _(${r.source})_`
    );
    await ctx.reply(`💱 *Current Exchange Rates*\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Update Rates', 'open_rate_manager')],
        [Markup.button.callback('🔄 Fetch Live', 'admin_fetch_rates')],
      ]),
    });
  });

  // 📢 Broadcast → enter broadcast scene
  bot.hears('📢 Broadcast', adminOnly(), (ctx) => ctx.scene.enter('broadcast_scene'));

  // 📋 Audit Logs → last 15 entries
  bot.hears('📋 Audit Logs', adminOnly(), async (ctx) => {
    const entries = await AuditLog.find({}).sort({ timestamp: -1 }).limit(15);
    if (!entries.length) return ctx.reply('📋 No audit log entries yet.');

    const lines = entries.map((e) => {
      const ts  = new Date(e.timestamp).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });
      const det = Object.keys(e.details || {}).length
        ? ` — ${JSON.stringify(e.details).slice(0, 60)}`
        : '';
      return `\`${ts}\` *${e.action}*\n  by \`${e.adminId}\` on ${e.targetType}${e.targetId ? ` \`${String(e.targetId).slice(-8)}\`` : ''}${det}`;
    });

    await ctx.reply(
      `📋 *Audit Log (last ${entries.length})*\n\n${lines.join('\n\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'nav:go:admin_main')]]),
      }
    );
  });

  // 🎟 Promotions → list all promo codes + create button
  bot.hears('🎟 Promotions', adminOnly(), async (ctx) => {
    const promos = await Promo.find({}).sort({ createdAt: -1 }).limit(20);
    if (!promos.length) {
      return ctx.reply('🎟 No promo codes yet.\n\nUse /createpromo to create one.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ Create New', 'promo_create_start')]]),
      });
    }
    const lines = promos.map((p) => {
      const disc   = p.discountType === 'Flat' ? `${price(p.value)} off` : `${p.value}% off`;
      const uses   = p.maxUses ? `${p.currentUses}/${p.maxUses}` : `${p.currentUses}/∞`;
      const status = p.isActive ? '🟢' : '🔴';
      return `${status} \`${p.code}\` — ${disc} — Uses: ${uses}`;
    });
    await ctx.reply(
      `🎟 *Promo Codes (${promos.length})*\n\n${lines.join('\n')}\n\n` +
      `_Commands:_\n• /createpromo — guided creation\n• /deletepromo CODE — deactivate`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ Create New', 'promo_create_start')]]),
      }
    );
  });

  // 🎫 Support Tickets → open + in-progress tickets
  bot.hears('🎫 Support Tickets', adminOnly(), async (ctx) => {
    const tickets = await SupportTicket.find({
      status: { $in: ['Open', 'InProgress'] },
      isArchived: { $ne: true },
    }).sort({ createdAt: -1 }).limit(10);

    if (!tickets.length) {
      return ctx.reply('✅ No open tickets right now.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📨 Support Contact သတ်မှတ်ရန်', 'sup_contact_panel')],
          [Markup.button.callback('🔙 Back', 'nav:go:admin_main')],
        ]),
      });
    }

    const priorityBadge = { Normal: '🟡', High: '🟠', Urgent: '🔴' };
    const lines = tickets.map((t) => {
      const userTag  = t.username ? `@${t.username}` : `ID:${t.telegramId}`;
      const badge    = priorityBadge[t.priority] || '🟡';
      const assigned = t.assignedAdmin ? ` 🔵${t.assignedAdmin}` : '';
      return `${badge} \`${t.ticketId}\` — ${t.topic} — ${userTag}${assigned} _(${t.status})_`;
    });

    const ticketButtons = tickets.slice(0, 5).map((t) =>
      [Markup.button.callback(`📩 ${t.ticketId}`, `ticket_view:${t.ticketId}`)]
    );

    await ctx.reply(
      `🎫 *Open Tickets (${tickets.length})*\n\n${lines.join('\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...ticketButtons,
          [Markup.button.callback('📨 Support Contact သတ်မှတ်ရန်', 'sup_contact_panel')],
          [Markup.button.callback('🔙 Back', 'nav:go:admin_main')],
        ]),
      }
    );
  });

  // 📈 Analytics → today's report quick view
  bot.hears('📈 Analytics', requireRole('MANAGER'), async (ctx) => {
    const wait = await ctx.reply('⏳ _Loading today\'s analytics..._', { parse_mode: 'Markdown' });
    try {
      const report = await AnalyticsService.getFullReport('today');
      const r = report.revenue;
      const text =
        `📈 *Quick Analytics — Today*\n\n` +
        `💰 Gross: *${(r.grossRevenue || 0).toLocaleString()} KS*\n` +
        `💵 Net: *${(r.netRevenue || 0).toLocaleString()} KS*\n` +
        `📊 Est. Profit: *${(r.netProfit || 0).toLocaleString()} KS* (${r.estimatedMarginPct}%)\n` +
        `✅ Completed: *${r.orderCount}* | ❌ Cancelled: *${report.cancellation.cancelled}*\n` +
        `👥 New Users: *+${report.users.newUsers}*\n\n` +
        `_Use /analytics today|week|month for full report._`;
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📅 Today',  'analytics:today'),
            Markup.button.callback('📆 Week',   'analytics:week'),
            Markup.button.callback('🗓 Month',  'analytics:month'),
          ],
          [
            Markup.button.callback('🤖 AI Report', 'analyticsai_run:today'),
            Markup.button.callback('📥 Export',    'analytics_export_menu'),
          ],
        ]),
      });
    } catch (err) {
      console.error('[Admin] Analytics quick view failed:', err);
      await ctx.telegram
        .editMessageText(wait.chat.id, wait.message_id, undefined, `❌ ${err.message}`)
        .catch(() => ctx.reply(`❌ ${err.message}`));
    }
  });

  // 🤖 AI Insights → menu for AI-powered admin reports
  bot.hears('🤖 AI Insights', requireRole('MANAGER'), async (ctx) => {
    await ctx.reply(
      `🤖 *AI Insights — Gemini 2.0 Flash*\n\n` +
      `Pick a report:\n\n` +
      `📊 *Business Report* — Monthly revenue/profit summary\n` +
      `🔮 *7-Day Forecast* — Sales prediction\n` +
      `💬 *Sentiment Report* — Customer review analysis\n` +
      `❤️ *System Health* — Gateway + system status`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Business Report (Month)', 'analyticsai_run:month')],
          [Markup.button.callback('🔮 7-Day Forecast',          'ai_forecast_run')],
          [Markup.button.callback('💬 Sentiment Report',        'ai_sentiment_run')],
          [Markup.button.callback('❤️ System Health',           'ai_syshealth_run')],
        ]),
      }
    );
  });

  // 🔧 System → /sysinfo equivalent
  bot.hears('🔧 System', requireRole('MANAGER'), async (ctx) => {
    const wait = await ctx.reply('⏳ _Gathering system info..._', { parse_mode: 'Markdown' });
    try {
      const mem = process.memoryUsage();
      const memUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const memTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
      const uptimeMin  = Math.floor(process.uptime() / 60);
      const uptimeHr   = Math.floor(uptimeMin / 60);
      const cacheStats = CacheService.getStats();
      const [pending, processing, openTickets, sys] = await Promise.all([
        Order.countDocuments({ status: 'Pending' }),
        Order.countDocuments({ status: 'Processing' }),
        SupportTicket.countDocuments({ status: { $in: ['Open', 'InProgress'] }, isArchived: { $ne: true } }),
        SystemStatus.findOne({}),
      ]);
      const gatewayLines = (sys?.gateways || []).map((g) => {
        const icon = g.status === 'Online' ? '🟢' : g.status === 'Busy' ? '🟡' : '🔴';
        return `  ${icon} *${g.method}*: ${g.status}`;
      }).join('\n') || '  _No gateway config_';

      const text =
        `🔧 *System Status*\n\n` +
        `💾 Memory: *${memUsedMB} / ${memTotalMB} MB*\n` +
        `⏱ Uptime: *${uptimeHr}h ${uptimeMin % 60}m*\n` +
        `🖥 Node: ${process.version} | Platform: ${os.platform()}\n\n` +
        `🗃 *Cache* — ${cacheStats.keys} keys, ${cacheStats.hits} hits, ${cacheStats.misses} misses\n\n` +
        `📦 *Queue* — Pending: ${pending} | Processing: ${processing}\n` +
        `🎫 Open Tickets: ${openTickets}\n` +
        `🛡 Maintenance: ${sys?.maintenanceMode ? '🔴 ON' : '🟢 OFF'}\n\n` +
        `💳 *Gateways:*\n${gatewayLines}\n\n` +
        `_Commands: /sysinfo /runbackup /runcron /flushcache /checkhealth_`;

      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Refresh',     'sysinfo_refresh'),
            Markup.button.callback('🗃 Flush Cache',  'sysinfo_flush_cache'),
          ],
          [
            Markup.button.callback('🗄 Run Backup',   'sysinfo_backup'),
            Markup.button.callback('🔧 Run Cron',     'sysinfo_cron'),
          ],
        ]),
      });
    } catch (err) {
      console.error('[Admin] System view failed:', err);
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ ${err.message}`).catch(() => {});
    }
  });

  // 🤖 AI Insights wiring — forecast / sentiment / syshealth proxies
  bot.action('ai_forecast_run', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Generating forecast…');
    const wait = await ctx.reply('🔮 _Analyzing 90 days of data… (~20s)_', { parse_mode: 'Markdown' });
    try {
      const AIInsightsService = require('../services/AIInsightsService');
      const historicalTrend = await AnalyticsService.getHistoricalTrend(90);
      if (historicalTrend.length < 7) {
        await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined,
          `⚠️ Not enough data for forecasting. Need ≥ 7 days of order history.`).catch(() => {});
        return;
      }
      const forecast = await AIInsightsService.generateSalesForecast(historicalTrend);
      await ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(
        `🔮 *7-Day Sales Forecast*\n_Based on ${historicalTrend.length} days of history_\n\n${forecast}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[Admin] Forecast failed:', err);
      await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ ${err.message}`)
        .catch(() => ctx.reply(`❌ ${err.message}`));
    }
  });

  bot.action('ai_sentiment_run', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Loading sentiment report…');
    await ctx.reply('💬 _Use /sentimentreport for the full sentiment analysis._', { parse_mode: 'Markdown' });
  });

  bot.action('ai_syshealth_run', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Loading system health…');
    await ctx.reply('❤️ _Use /systemhealth for full gateway + system status._', { parse_mode: 'Markdown' });
  });

  // 📖 Admin Guide → interactive, one section per button
  bot.hears('📖 Admin Guide', adminOnly(), async (ctx) => {
    await ctx.reply(GUIDE_INTRO, { parse_mode: 'Markdown', ...guideMenuKeyboard() });
  });

  bot.action(/^guide:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const key = ctx.match[1];

    if (key === 'menu') {
      try {
        await ctx.editMessageText(GUIDE_INTRO, { parse_mode: 'Markdown', ...guideMenuKeyboard() });
      } catch (_) {
        await ctx.reply(GUIDE_INTRO, { parse_mode: 'Markdown', ...guideMenuKeyboard() });
      }
      return;
    }

    const section = GUIDE_SECTIONS.find((s) => s.key === key);
    if (!section) return;

    const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Guide Menu', 'guide:menu')]]);
    // Telegram caps a message at 4096 chars. Long guide sections must be split
    // on line boundaries (each line keeps its Markdown entities balanced) so the
    // parse never breaks — only the LAST chunk carries the 🔙 keyboard.
    const chunks = splitForTelegram(section.body);
    try {
      await ctx.editMessageText(chunks[0], { parse_mode: 'Markdown', ...(chunks.length === 1 ? kb : {}) });
    } catch (_) {
      await ctx.reply(chunks[0], { parse_mode: 'Markdown', ...(chunks.length === 1 ? kb : {}) });
    }
    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(chunks[i], { parse_mode: 'Markdown', ...(i === chunks.length - 1 ? kb : {}) });
    }
  });

  // 🔙 Back to Main → switch reply keyboard back to user main menu
  bot.hears('🔙 Back to Main', async (ctx) => {
    await ctx.reply('🏠 Back to main menu.', mainMenuKeyboard(ctx));
  });

  // ── Admin inline nav action handlers ──────────────────────────────────────

  bot.action('admin_dashboard_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Loading...');
    const [totalUsers, pending, processing, success, todayOrders] = await Promise.all([
      User.countDocuments({}),
      Order.countDocuments({ status: 'Pending' }),
      Order.countDocuments({ status: 'Processing' }),
      Order.countDocuments({ status: 'Success' }),
      Order.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
    ]);
    await ctx.reply(
      `📊 *Quick Dashboard*\n\n` +
      `👥 Total Users: *${totalUsers}*\n` +
      `🟡 Pending Orders: *${pending}*\n` +
      `🔵 Processing: *${processing}*\n` +
      `✅ Completed: *${success}*\n` +
      `📅 Today's Orders: *${todayOrders}*\n\n` +
      `_For full stats, use /dashboard_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'dashboard_refresh')],
          [Markup.button.callback('🔙 Back', 'nav:go:admin_main')],
        ]),
      }
    );
  });

  bot.action('admin_orders_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const pending    = await Order.countDocuments({ status: 'Pending' });
    const processing = await Order.countDocuments({ status: 'Processing' });
    await ctx.reply(
      `📦 *Order Management*\n\n🟡 Pending: *${pending}*\n🔵 Processing: *${processing}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟡 View Pending',  'admin_pending_orders')],
          [Markup.button.callback('📋 All Orders',    'admin_all_orders')],
          [Markup.button.callback('🔙 Back',          'nav:go:admin_main')],
        ]),
      }
    );
  });

  bot.action('admin_products_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [total, active] = await Promise.all([
      Product.countDocuments({}),
      Product.countDocuments({ isActive: true }),
    ]);
    await ctx.reply(
      `🛍️ *Product Management*\n\n✅ Active: *${active}*\n🔴 Inactive: *${total - active}*\n📦 Total: *${total}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 List Products',        'pm_list_products')],
          [Markup.button.callback('➕ Add Product',           'admin_product_add')],
          [Markup.button.callback('🗑 Delete by Category',   'pm_del_by_cat')],
          [Markup.button.callback('💱 Update Rates',          'open_rate_manager')],
          [Markup.button.callback('🔙 Back',                  'nav:go:admin_main')],
        ]),
      }
    );
  });

  // ── Delete all products in a category ────────────────────────────────────
  bot.action('pm_del_by_cat', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cats = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    if (!cats.length) return ctx.reply('🛍️ No products in the database.');
    const rows = cats.map((c) => [
      Markup.button.callback(
        `📁 ${c._id} (${c.count} products)`,
        `pm_del_cat_ask:${encodeURIComponent(c._id)}`
      ),
    ]);
    rows.push([Markup.button.callback('🔙 Back', 'admin_products_action')]);
    await ctx.reply(
      `🗑 *Delete Products by Category*\n\nSelect a category to delete ALL its products:\n_(Category itself will NOT be deleted)_`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  });

  bot.action(/^pm_del_cat_ask:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const cat = decodeURIComponent(ctx.match[1]);
    const count = await Product.countDocuments({ category: cat });
    await ctx.reply(
      `⚠️ *Delete all products in "${cat}"?*\n\n🗑 *${count} product(s)* will be permanently deleted.\nThe category itself will remain.\n\nThis cannot be undone.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ Yes, Delete ${count} products`, `pm_del_cat_confirm:${encodeURIComponent(cat)}`),
          ],
          [Markup.button.callback('❌ Cancel', 'pm_del_by_cat')],
        ]),
      }
    );
  });

  bot.action(/^pm_del_cat_confirm:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Deleting...');
    const cat = decodeURIComponent(ctx.match[1]);
    const result = await Product.deleteMany({ category: cat });
    await auditLog(ctx.from.id, 'BULK_DELETE_BY_CATEGORY', cat, 'Product', { deleted: result.deletedCount });
    await ctx.reply(
      `✅ *Done!* Deleted *${result.deletedCount}* product(s) from category *"${cat}"*.\n\nCategory itself was kept.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🗑 Delete Another Category', 'pm_del_by_cat')],
          [Markup.button.callback('📋 View Products', 'pm_list_products')],
        ]),
      }
    );
  });

  bot.action('admin_users_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`👥 *User Management*\n\nChoose an action:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 All Users',    'users_page:1')],
        [Markup.button.callback('🚫 Banned',       'users_banned'), Markup.button.callback('⚠️ Warned', 'users_warned')],
        [Markup.button.callback('📊 Stats',        'users_stats')],
        [Markup.button.callback('🔙 Back',         'nav:go:admin_main')],
      ]),
    });
  });

  bot.action('admin_promos_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const promos = await Promo.find().sort({ createdAt: -1 }).limit(20);
    if (!promos.length) {
      return ctx.reply(
        `🎟 *Promo Codes*\n\nNo promo codes yet.\n\nTo create one, use the \`/createpromo\` command.\nExample: \`/createpromo SAVE10 Percentage 10 100\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'nav:go:admin_main')]]),
        }
      );
    }
    const lines = promos.map((p) => {
      const disc = p.discountType === 'Flat' ? `${p.value.toLocaleString()} KS` : `${p.value}%`;
      const uses = p.maxUses ? `${p.currentUses}/${p.maxUses}` : `${p.currentUses}/∞`;
      return `${p.isActive ? '🟢' : '🔴'} \`${p.code}\` — ${disc} off — ${uses} uses`;
    });
    const deleteButtons = promos
      .filter((p) => p.isActive)
      .slice(0, 5)
      .map((p) => [Markup.button.callback(`🗑 ${p.code}`, `admin_promo_del:${p.code}`)]);
    await ctx.reply(
      `🎟 *Promo Codes (${promos.length})*\n\n${lines.join('\n')}\n\n_Create new: /createpromo_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...deleteButtons,
          [Markup.button.callback('🔙 Back', 'nav:go:admin_main')],
        ]),
      }
    );
  });

  bot.action(/^admin_promo_del:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Deactivating...');
    const code = ctx.match[1].toUpperCase();
    const result = await Promo.findOneAndUpdate({ code }, { isActive: false }, { new: true });
    if (!result) return ctx.reply(`❌ Promo \`${code}\` not found.`, { parse_mode: 'Markdown' });
    await auditLog(ctx.from.id, 'PROMO_DEACTIVATED', null, 'Promo', { code });
    await ctx.reply(`✅ Promo \`${code}\` deactivated.`, { parse_mode: 'Markdown' });
  });

  bot.action('admin_rates_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('rate_manager');
  });

  bot.action('admin_broadcast_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('broadcast_scene');
  });

  bot.action('admin_audit_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(10);
    if (!logs.length) return ctx.reply('📋 No audit log entries yet.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'nav:go:admin_main')]]),
    });
    const lines = logs.map((l, i) => {
      const ts = new Date(l.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });
      const target = l.targetId ? ` → \`${l.targetId}\`` : '';
      return `${i + 1}\\. \`${l.action}\`${target}\n   _${ts} MMT_`;
    });
    await ctx.reply(`📋 *Recent Audit Logs*\n\n${lines.join('\n\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'audit_refresh'), Markup.button.callback('🔙 Back', 'nav:go:admin_main')],
      ]),
    });
  });

  bot.action('admin_user_view', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Switching to user view...');
    await Nav.navigate(ctx, 'main', true);
  });

  // ── Product list — category picker ────────────────────────────────────────

  bot.action('pm_list_products', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const total = await Product.countDocuments();
    if (!total) {
      return ctx.reply('🛍️ No products found. Use "Add Product" to create one.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add Product', 'admin_product_add')],
          [Markup.button.callback('🔙 Back', 'admin_products_action')],
        ]),
      });
    }

    // Distinct categories with active/total counts
    const stats = await Product.aggregate([
      { $group: { _id: '$category', total: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]);

    const rows = stats.map((s) => {
      const label = s._id || '(No Category)';
      // keep callback_data under 64 bytes — category names are short enough
      const key = (s._id || '__none__').substring(0, 50);
      return [Markup.button.callback(
        `📁 ${label} — ${s.active}✅ / ${s.total} total`,
        `pm_cat:${key}`
      )];
    });
    rows.push([
      Markup.button.callback('➕ Add Product', 'admin_product_add'),
      Markup.button.callback('🔙 Back', 'admin_products_action'),
    ]);

    await ctx.reply(
      `🛍️ *Products — ${total} total*\n\nSelect a category to view products:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  });

  // ── Products in a category ─────────────────────────────────────────────────

  bot.action(/^pm_cat:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const category = key === '__none__' ? null : key;

    const query = category ? { category } : { $or: [{ category: null }, { category: '' }] };
    const products = await Product.find(query).sort({ isActive: -1, name: 1 });

    const catLabel = category || '(No Category)';

    if (!products.length) {
      return ctx.reply(`📁 *${catLabel}*\n\n_No products in this category._`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 All Categories', 'pm_list_products')]]),
      });
    }

    const activeCount = products.filter((p) => p.isActive).length;
    const rows = products.map((p) => [
      Markup.button.callback(
        `${p.isActive ? '✅' : '🔴'} ${p.name} — ${p.finalPrice?.toLocaleString() || '?'} KS`,
        `ap_view:${p._id}`
      ),
    ]);
    rows.push([Markup.button.callback('🔙 All Categories', 'pm_list_products')]);

    await ctx.reply(
      `📁 *${catLabel}*\n\n✅ Active: ${activeCount}  |  📦 Total: ${products.length}\n\nTap a product to manage:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  });

  bot.action(/^ap_view:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    const photoStatus = p.imageUrl ? '🖼 Photo: ✅ Set' : '🖼 Photo: ➕ Add';
    const flashLine = p.flashSalePrice
      ? `⚡ Flash Sale: ${price(p.flashSalePrice)}\n`
      : '';
    const ov = p.checkoutFieldsOverride;
    const noInfo = Array.isArray(ov) && ov.length === 0;
    const customFields = Array.isArray(ov) && ov.length > 0;
    const checkoutLine = noInfo
      ? `🧾 Checkout: 🚫 No info needed (account delivery)\n`
      : customFields
        ? `🧾 Checkout: 🧩 Custom fields (${ov.length})\n`
        : `🧾 Checkout: 📝 Asks catalog fields\n`;
    await ctx.reply(
      `📦 *${p.name}*\n\n` +
      `📁 Category: ${p.category}\n` +
      `🌍 Region: ${p.region || 'Global'}\n` +
      `💰 Price: ${price(p.finalPrice)}\n` +
      `${flashLine}` +
      `📦 Stock: ${p.stockCount === -1 ? '∞ Unlimited' : p.stockCount}\n` +
      `Status: ${p.isActive ? '✅ Active' : '🔴 Inactive'}\n` +
      `${checkoutLine}` +
      `${photoStatus}\n` +
      (p.description ? `📝 ${p.description}` : ''),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Edit Fields', `ap_edit:${p._id}`)],
          [Markup.button.callback(p.isActive ? '🔴 Deactivate' : '✅ Activate', `ap_toggle:${p._id}`)],
          [Markup.button.callback(
            noInfo ? '📝 Require Catalog Info' : '🚫 No Info Needed (Account Delivery)',
            `ap_nofields:${p._id}`,
          )],
          [Markup.button.callback('📸 Set Photo', `ap_photo:${p._id}`)],
          [Markup.button.callback('🗑 Delete', `ap_delete_ask:${p._id}`)],
          [Markup.button.callback('🔙 Products List', 'pm_list_products')],
        ]),
      }
    );
  });

  // ── Product Edit — field selector ─────────────────────────────────────────
  bot.action(/^ap_edit:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const p = await Product.findById(id);
    if (!p) return ctx.reply('❌ Product not found.');
    await ctx.reply(
      `✏️ *Edit: ${p.name}*\n\nWhich field do you want to edit?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Name',        `ap_ef:${id}:name`)],
          [Markup.button.callback('💰 Price (KS)',   `ap_ef:${id}:price`)],
          [Markup.button.callback('📝 Description',  `ap_ef:${id}:description`)],
          [Markup.button.callback('📁 Category',     `ap_ef:${id}:category`)],
          [Markup.button.callback('📦 Stock Count',  `ap_ef:${id}:stock`)],
          [Markup.button.callback('🌍 Region',       `ap_ef:${id}:region`)],
          [Markup.button.callback('🔢 Max Qty/Order', `ap_ef:${id}:maxQuantity`)],
          [Markup.button.callback('🔙 Back',         `ap_view:${id}`)],
        ]),
      }
    );
  });

  // ── Product Edit — field prompt ────────────────────────────────────────────
  bot.action(/^ap_ef:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, id, field] = ctx.match;
    const p = await Product.findById(id);
    if (!p) return ctx.reply('❌ Product not found.');
    const fieldLabels = {
      name:        'Name',
      price:       'Price (in KS, numbers only)',
      description: 'Description (or send `-` to clear)',
      category:    'Category',
      stock:       'Stock Count (-1 for unlimited)',
      region:      'Region (e.g. Global, SEA, MY)',
      maxQuantity: 'Max Qty per Order (1 = no selector, 10 = max 10, 0 = unlimited)',
    };
    const current = {
      name:        p.name,
      price:       p.finalPrice,
      description: p.description || '—',
      category:    p.category,
      stock:       p.stockCount,
      region:      p.region || 'Global',
      maxQuantity: p.maxQuantity ?? 'unlimited',
    };
    ctx.session.editProductField = { id, field };
    await ctx.reply(
      `✏️ *Edit ${fieldLabels[field]}*\n\nCurrent value: \`${current[field]}\`\n\nSend the new value:\n_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Product Toggle Active ─────────────────────────────────────────────────
  bot.action(/^ap_toggle:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    p.isActive = !p.isActive;
    await p.save();
    await auditLog(ctx.from.id, 'PRODUCT_TOGGLE', p._id.toString(), 'Product', { isActive: p.isActive });
    await ctx.reply(`${p.isActive ? '✅' : '🔴'} *${p.name}* is now ${p.isActive ? 'Active' : 'Inactive'}.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📦 Back to Product', `ap_view:${p._id}`)]]),
    });
  });

  // ── Product Checkout Mode — "No info needed" (account delivery) ────────────
  // [] override = customer orders without entering any field.
  // null override = product falls back to its catalog's checkout fields.
  bot.action(/^ap_nofields:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    const ov = p.checkoutFieldsOverride;
    const wasNoInfo = Array.isArray(ov) && ov.length === 0;
    if (wasNoInfo) {
      // Revert: restore a stashed custom override if there was one, else inherit catalog.
      const stashed = p.previousCheckoutFieldsOverride;
      p.checkoutFieldsOverride = (Array.isArray(stashed) && stashed.length > 0) ? stashed : null;
      p.previousCheckoutFieldsOverride = null;
    } else {
      // Switch to "no info": stash any existing custom override so we can restore it later.
      if (Array.isArray(ov) && ov.length > 0) p.previousCheckoutFieldsOverride = ov;
      p.checkoutFieldsOverride = [];
    }
    await p.save();
    CacheService.invalidateProducts();
    await auditLog(ctx.from.id, 'PRODUCT_CHECKOUT_MODE', p._id.toString(), 'Product', { noInfo: !wasNoInfo });
    const revertedToCustom = Array.isArray(p.checkoutFieldsOverride) && p.checkoutFieldsOverride.length > 0;
    const msg = wasNoInfo
      ? (revertedToCustom
          ? `🧩 *${p.name}* — restored its custom checkout fields.`
          : `📝 *${p.name}* — customers will be asked for the catalog's checkout fields again.`)
      : `🚫 *${p.name}* — customers can now order WITHOUT entering any info.\n\n` +
        `Use this for account-delivery products (you send Gmail / password / instructions after purchase).\n` +
        `Works in both the bot and the Mini App.`;
    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📦 Back to Product', `ap_view:${p._id}`)]]),
    });
  });

  // ── Product Delete — confirm ───────────────────────────────────────────────
  bot.action(/^ap_delete_ask:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    await ctx.reply(
      `🗑 *Delete "${p.name}"?*\n\nThis cannot be undone.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Delete', `ap_delete_confirm:${p._id}`),
           Markup.button.callback('❌ Cancel', `ap_view:${p._id}`)],
        ]),
      }
    );
  });

  bot.action(/^ap_delete_confirm:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Deleting...');
    const p = await Product.findByIdAndDelete(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product not found.');
    await auditLog(ctx.from.id, 'PRODUCT_DELETE', p._id.toString(), 'Product', { name: p.name });
    await ctx.reply(`🗑 *${p.name}* deleted.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 Products List', 'pm_list_products')]]),
    });
  });

  bot.action(/^ap_photo:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.photoProductId = ctx.match[1];
    await ctx.reply(
      `📸 *Set Product Photo*\n\nSend a photo/image for this product now.\nThe image will show in the Mini App store.\n\n_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle photo upload for product image
  bot.on('photo', async (ctx, next) => {
    // Do NOT gate this catch-all photo handler with adminOnly() middleware —
    // that would deny every non-owner who sends a photo. Pass non-owners through.
    const { config } = require('../../config/settings');
    if (Number(ctx.from?.id) !== Number(config.bot.adminId)) return next();
    if (!ctx.session?.photoProductId) return next();
    const productId = ctx.session.photoProductId;
    ctx.session.photoProductId = null;
    try {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1]; // highest resolution
      const fileLink = await ctx.telegram.getFileLink(best.file_id);
      const imageUrl = fileLink.href || fileLink.toString();
      const product = await Product.findByIdAndUpdate(
        productId,
        { imageUrl },
        { new: true }
      );
      if (!product) return ctx.reply('❌ Product not found.');
      await auditLog(ctx.from.id, 'SET_PRODUCT_PHOTO', productId, 'Product', { imageUrl });
      await ctx.reply(
        `✅ Photo updated for *${product.name}*!\n\nIt will now show in the Mini App store.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('📦 Back to Product', `ap_view:${productId}`)]]),
        }
      );
    } catch (err) {
      ctx.session.photoProductId = null;
      await ctx.reply(`❌ Failed to save photo: ${err.message}`);
    }
  });

  // ── Flash sale / digital codes — help cards with Back ─────────────────────
  bot.action('pm_flashsale_help', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const active = await Product.find({ isActive: true }).sort({ category: 1 }).limit(8);
    const list = active.map((p) =>
      `• \`${p._id}\` — ${p.name} (${p.finalPrice?.toLocaleString() || '?'} KS)`
    ).join('\n') || '_No active products yet._';
    await ctx.reply(
      `⚡ *Flash Sale Setup*\n\n` +
      `Format:\n\`/flashsale <productId> <salePrice> <durationHours>\`\n\n` +
      `Example:\n\`/flashsale abc123 2500 4\`\n\n` +
      `*Active products:*\n${list}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_products_action')]]),
      }
    );
  });

  bot.action('pm_addcodes_help', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `🎁 *Add Digital Codes*\n\n` +
      `Format:\n\`/addcodes <productId> code1 code2 code3\`\n\n` +
      `Each code separated by space.\nTap *List Products* to find the productId.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 List Products', 'pm_list_products')],
          [Markup.button.callback('🔙 Back',          'admin_products_action')],
        ]),
      }
    );
  });

  // ── User management actions ────────────────────────────────────────────────
  bot.action('users_banned', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { users, total } = await listUsers({ filter: { isBlocked: true }, limit: 10 });
    if (!total) return ctx.reply('✅ No banned users.');
    const btns = users.map((u) => {
      const name = u.first_name || (u.username ? `@${u.username}` : `ID:${u.telegramId}`);
      return [Markup.button.callback(`🚫 ${name}`.slice(0, 50), `um_view:${u.telegramId}`)];
    });
    await ctx.reply(`🚫 *Banned Users (${total})*\n\n_User ကို နှိပ်ပြီး အသေးစိတ် ကြည့်ပါ_ 👇`, {
      parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns),
    }).catch(() => ctx.reply(`Banned Users (${total}) — user ကို နှိပ်ပါ 👇`, Markup.inlineKeyboard(btns)));
  });

  bot.action('users_warned', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { users, total } = await listUsers({ filter: { warningsCount: { $gt: 0 } }, limit: 10 });
    if (!total) return ctx.reply('✅ No users with warnings.');
    const btns = users.map((u) => {
      const name = u.first_name || (u.username ? `@${u.username}` : `ID:${u.telegramId}`);
      return [Markup.button.callback(`⚠️ ${u.warningsCount}/3 — ${name}`.slice(0, 50), `um_view:${u.telegramId}`)];
    });
    await ctx.reply(`⚠️ *Warned Users (${total})*\n\n_User ကို နှိပ်ပြီး အသေးစိတ် ကြည့်ပါ_ 👇`, {
      parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns),
    }).catch(() => ctx.reply(`Warned Users (${total}) — user ကို နှိပ်ပါ 👇`, Markup.inlineKeyboard(btns)));
  });

  bot.action('users_stats', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [total, banned, warned, gold, platinum] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isBlocked: true }),
      User.countDocuments({ warningsCount: { $gt: 0 } }),
      User.countDocuments({ membershipTier: 'Gold' }),
      User.countDocuments({ membershipTier: 'Platinum' }),
    ]);
    await ctx.reply(
      `📊 *User Statistics*\n\n` +
      `👥 Total: *${total}*\n` +
      `🟢 Active: *${total - banned}*\n` +
      `🚫 Banned: *${banned}*\n` +
      `⚠️ Warned: *${warned}*\n` +
      `──────────────\n` +
      `🥈 Silver: *${total - gold - platinum}*\n` +
      `🥇 Gold: *${gold}*\n` +
      `💎 Platinum: *${platinum}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Rate management ────────────────────────────────────────────────────────
  bot.command('managerates', adminOnly(), (ctx) => ctx.scene.enter('rate_manager'));

  bot.command('rates', adminOnly(), async (ctx) => {
    const rates = await getAllRates();
    if (!rates.length) return ctx.reply('No exchange rates yet. Use /managerates.');
    const lines = rates.map((r) => `• *${r.currencyCode}*: \`${parseFloat(r.rateToMMK.toFixed(4))}\` MMK  _(${r.source})_`);
    await ctx.reply(`💱 *Current Exchange Rates*\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Update', 'open_rate_manager')]]),
    });
  });

  bot.action('open_rate_manager', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('rate_manager');
  });

  bot.command('fetchrates', adminOnly(), async (ctx) => {
    const msg = await ctx.reply('⏳ Fetching live exchange rates...');
    try {
      const updates = await fetchLiveRates();
      const lines = updates.map((u) => `• *${u.code}*: \`${u.rateToMMK}\` MMK`).join('\n');
      await auditLog(ctx.from.id, 'FETCH_LIVE_RATES', null, 'Currency', { updates });
      await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      await ctx.reply(`✅ *Live Rates Fetched*\n\n${lines}\n\n_Use /managerates → Approve All to apply._`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Orders ─────────────────────────────────────────────────────────────────
  bot.action('admin_pending_orders', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const orders = await Order.find({ status: 'Pending' })
      .populate('userId', 'username telegramId')
      .populate('productId', 'name')
      .sort({ timestamp: -1 })
      .limit(10);
    if (!orders.length) return ctx.reply('✅ No pending orders!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_orders_action')]]),
    });
    const lines = orders.map((o, i) => {
      const user    = o.userId?.username ? `@${o.userId.username}` : `ID:${o.userId?.telegramId}`;
      const product = o.productId?.name || 'Unknown';
      return `${i + 1}\\. 🟡 ${user} — *${product}* — \`${price(o.amount)}\``;
    });
    await ctx.reply(`🟡 *Pending Orders (${orders.length})*\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_orders_action')]]),
    });
  });

  bot.action('admin_all_orders', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const orders = await Order.find()
      .populate('userId', 'username telegramId')
      .populate('productId', 'name')
      .sort({ timestamp: -1 })
      .limit(10);
    if (!orders.length) return ctx.reply('📦 No orders found.');
    const lines = orders.map((o, i) => {
      const user    = o.userId?.username ? `@${o.userId.username}` : `ID:${o.userId?.telegramId}`;
      const product = o.productId?.name || 'Unknown';
      const icon    = o.status === 'Success' ? '✅' : o.status === 'Pending' ? '🟡' : o.status === 'Cancelled' ? '❌' : '🔵';
      return `${i + 1}\\. ${icon} ${user} — *${product}* — \`${price(o.amount)}\``;
    });
    await ctx.reply(`📦 *Recent Orders (${orders.length})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  // ── Broadcast ──────────────────────────────────────────────────────────────
  bot.command('broadcast', adminOnly(), (ctx) => ctx.scene.enter('broadcast_scene'));

  // ── Audit log refresh ──────────────────────────────────────────────────────
  bot.action('audit_refresh', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Refreshing...');
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(10);
    if (!logs.length) return ctx.editMessageText('📋 No audit log entries yet.').catch(() => ctx.reply('📋 No entries yet.'));
    const lines = logs.map((l, i) => {
      const ts = new Date(l.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });
      const target = l.targetId ? ` → \`${l.targetId}\`` : '';
      return `${i + 1}\\. \`${l.action}\`${target}\n   _${ts} MMT_`;
    });
    await ctx.editMessageText(`📋 *Recent Audit Logs*\n\n${lines.join('\n\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'audit_refresh'), Markup.button.callback('🔙 Back', 'nav:go:admin_main')]]),
    }).catch(() => {});
  });

  // ── Manual price setter (from rate manager scene) ──────────────────────────
  bot.on('message', async (ctx, next) => {
    const text = ctx.message?.text?.trim();

    // Cancel any pending session
    if (text === '/cancel') {
      if (ctx.session?.photoProductId)   { ctx.session.photoProductId = null; return ctx.reply('❌ Photo upload cancelled.'); }
      if (ctx.session?.editProductField) { ctx.session.editProductField = null; return ctx.reply('❌ Edit cancelled.'); }
    }

    // ── Product field editor ────────────────────────────────────────────────
    if (ctx.session?.editProductField && text) {
      const { id, field } = ctx.session.editProductField;
      ctx.session.editProductField = null;

      const p = await Product.findById(id);
      if (!p) return ctx.reply('❌ Product not found.');

      try {
        if (field === 'name') {
          if (!text || text.length < 2) return ctx.reply('❌ Name must be at least 2 characters.');
          p.name = text;
        } else if (field === 'price') {
          const val = parseFloat(text.replace(/,/g, ''));
          if (isNaN(val) || val <= 0) return ctx.reply('❌ Enter a valid price (positive number).');
          p.finalPrice = val;
          p.baseCost = val;
        } else if (field === 'description') {
          p.description = text === '-' ? '' : text;
        } else if (field === 'category') {
          p.category = text;
        } else if (field === 'stock') {
          const val = parseInt(text, 10);
          if (isNaN(val) || val < -1) return ctx.reply('❌ Enter -1 (unlimited) or a positive number.');
          p.stockCount = val;
        } else if (field === 'region') {
          p.region = text;
        } else if (field === 'maxQuantity') {
          const val = parseInt(text, 10);
          if (text === '0' || text.toLowerCase() === 'unlimited') {
            p.maxQuantity = null;
          } else if (isNaN(val) || val < 1) {
            return ctx.reply('❌ Enter a number ≥ 1, or `0` for unlimited.');
          } else {
            p.maxQuantity = val;
          }
        }

        await p.save();
        await auditLog(ctx.from.id, 'PRODUCT_EDIT', id, 'Product', { field, value: text });

        return ctx.reply(
          `✅ *${p.name}* updated!\n\n*${field}* → \`${text}\``,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('✏️ Edit More Fields', `ap_edit:${id}`)],
              [Markup.button.callback('📦 View Product', `ap_view:${id}`)],
            ]),
          }
        );
      } catch (err) {
        return ctx.reply(`❌ Save failed: ${err.message}`);
      }
    }

    // ── Manual price setter (from rate manager scene) ───────────────────────
    if (ctx.session?.rm_manual_product && text) {
      const p = parseInt(text, 10);
      if (isNaN(p) || p <= 0) return ctx.reply('❌ Enter a positive integer.');
      const { setManualPrice } = require('../services/PriceCalculator');
      try {
        const product = await setManualPrice(ctx.session.rm_manual_product, p);
        await auditLog(ctx.from.id, 'SET_MANUAL_PRICE', product._id.toString(), 'Product', { price: p });
        ctx.session.rm_manual_product = null;
        return ctx.reply(
          `✅ *${product.name}* → \`${p.toLocaleString()} KS\` _(Manual mode)_`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        return ctx.reply(`❌ ${err.message}`);
      }
    }

    return next();
  });
};
