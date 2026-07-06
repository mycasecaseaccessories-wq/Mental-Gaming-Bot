/**
 * Catalog Admin Commands
 * Registers all catalog management actions for the admin panel.
 *
 * Commands / actions:
 *   admin_catalogs_action  — catalog list panel
 *   cat_view:<id>          — view catalog details + fields
 *   cat_add                — add new catalog (name prompt)
 *   cat_del:<id>           — delete catalog
 *   cat_toggle:<id>        — toggle active/inactive
 *   cat_field_add:<id>     — add checkout field
 *   cat_field_del:<id>:<key> — remove a checkout field
 *   /bulkaddproducts       — bulk import products from formatted text
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const { auditLog } = require('../services/logger');
const { price } = require('../utils/ui');

// ── Ordering helpers (siblings = catalogs sharing the same parentCategory) ─────
// Shop order is driven by { sortOrder: 1, name: 1 }, so these operate per level.
async function getSiblings(catalog) {
  return Catalog.find({ parentCategory: catalog.parentCategory ?? null }).sort({ sortOrder: 1, name: 1 });
}

// Move a catalog up/down among its siblings. Normalizes sibling sortOrder to a
// clean 0..N sequence first, then swaps with its neighbour.
async function moveCatalog(catalogId, dir) {
  const cat = await Catalog.findById(catalogId);
  if (!cat) return { ok: false, reason: 'notfound' };
  const siblings = await getSiblings(cat);
  siblings.forEach((s, i) => { s.sortOrder = i; });
  const idx = siblings.findIndex((s) => s._id.equals(cat._id));
  const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) {
    await Promise.all(siblings.map((s) => s.save()));
    return { ok: false, reason: 'edge' };
  }
  const tmp = siblings[idx].sortOrder;
  siblings[idx].sortOrder = siblings[swapIdx].sortOrder;
  siblings[swapIdx].sortOrder = tmp;
  await Promise.all(siblings.map((s) => s.save()));
  return { ok: true };
}

// Would assigning `newParentId` as the parent of `catalogId` create a cycle?
// True if newParent is the catalog itself or anywhere in its descendant subtree
// (i.e. walking up from newParent reaches catalogId).
async function wouldCreateCycle(catalogId, newParentId) {
  if (!newParentId) return false;
  if (String(newParentId) === String(catalogId)) return true;
  let cursor = await Catalog.findById(newParentId).select('parentCategory').lean();
  let hops = 0;
  while (cursor && cursor.parentCategory && hops < 100) {
    if (String(cursor.parentCategory) === String(catalogId)) return true;
    cursor = await Catalog.findById(cursor.parentCategory).select('parentCategory').lean();
    hops += 1;
  }
  return false;
}

// Pin a catalog to the very top of its sibling group.
async function pinCatalogTop(catalogId) {
  const cat = await Catalog.findById(catalogId);
  if (!cat) return { ok: false };
  const siblings = await getSiblings(cat);
  const others = siblings.filter((s) => !s._id.equals(cat._id));
  cat.sortOrder = 0;
  others.forEach((s, i) => { s.sortOrder = i + 1; });
  await Promise.all([cat.save(), ...others.map((s) => s.save())]);
  return { ok: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function sendCatalogView(ctx, catalog) {
  const fieldLines = catalog.checkoutFields.length
    ? catalog.checkoutFields
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((f, i) =>
          `${i + 1}\\. *${f.label}* (\`${f.key}\`) — ${f.fieldType}${f.required ? ' ✅' : ' ☑️ opt'}`
        )
        .join('\n')
    : '_No checkout fields — will not prompt user for delivery info_';

  const productCount = await Product.countDocuments({ catalogId: catalog._id });
  let parentName = null;
  if (catalog.parentCategory) {
    const parent = await Catalog.findById(catalog.parentCategory).select('name').lean();
    parentName = parent?.name ?? null;
  }

  // Position within its sibling group (drives where it shows in the shop)
  const siblings = await Catalog.find({ parentCategory: catalog.parentCategory ?? null })
    .sort({ sortOrder: 1, name: 1 }).select('_id').lean();
  const pos = siblings.findIndex((s) => String(s._id) === String(catalog._id)) + 1;
  const scope = parentName ? `under ${parentName}` : 'top level';

  // Sub-catalogs nested directly under this one
  const subs = await Catalog.find({ parentCategory: catalog._id })
    .sort({ sortOrder: 1, name: 1 }).select('_id name isActive').lean();
  const subLines = subs.length
    ? subs.map((s, i) => `${i + 1}\\. ${s.isActive ? '✅' : '🔴'} ${s.name}`).join('\n')
    : '_None yet_';

  const text =
    `📂 *${catalog.name}*\n\n` +
    `Status: ${catalog.isActive ? '✅ Active' : '🔴 Inactive'}\n` +
    `Products: *${productCount}*\n` +
    `Shop position: *${pos}/${siblings.length}* (${scope})\n` +
    (parentName ? `Parent: *${parentName}*\n` : '') +
    (catalog.imageUrl ? `🖼 Image: ${catalog.imageUrl}\n` : '') +
    (catalog.description ? `📝 ${catalog.description}\n` : '') +
    `\n*Sub-Categories (${subs.length}):*\n${subLines}\n` +
    `\n*Checkout Fields:*\n${fieldLines}`;

  const fieldDelButtons = catalog.checkoutFields
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .flatMap((f) => [
      [
        Markup.button.callback(`✏️ ${f.label}`, `cat_field_edit:${catalog._id}:${f.key}`),
        Markup.button.callback(`🗑`,              `cat_field_del:${catalog._id}:${f.key}`),
      ],
    ]);

  // One button per sub-catalog so admin can drill into it directly
  const subButtons = subs.map((s) => [
    Markup.button.callback(`↳ ${s.isActive ? '' : '🔴 '}${s.name}`, `cat_view:${s._id}`),
  ]);

  // Root catalogs go back to the top-level list; sub-catalogs go back to their parent
  const backButton = catalog.parentCategory
    ? Markup.button.callback('🔙 Back to Parent', `cat_view:${catalog.parentCategory}`)
    : Markup.button.callback('🔙 All Catalogs', 'admin_catalogs_action');

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('➕ Add Field',      `cat_field_add:${catalog._id}`),
        Markup.button.callback('⚡ Quick-Setup',    `cat_preset:${catalog._id}`),
      ],
      ...fieldDelButtons,
      ...subButtons,
      [Markup.button.callback('➕ Add Sub-Category', `cat_addsub:${catalog._id}`)],
      [
        Markup.button.callback('⬆️ Move Up',   `cat_moveup:${catalog._id}`),
        Markup.button.callback('⬇️ Move Down', `cat_movedown:${catalog._id}`),
        Markup.button.callback('📌 Pin Top',   `cat_pintop:${catalog._id}`),
      ],
      [
        Markup.button.callback('🖼 Set Image', `cat_setimage:${catalog._id}`),
        Markup.button.callback('🔗 Set Parent', `cat_setparent:${catalog._id}`),
      ],
      [
        Markup.button.callback('🔀 Toggle Active', `cat_toggle:${catalog._id}`),
        Markup.button.callback('🗑 Delete', `cat_del:${catalog._id}`),
      ],
      [backButton],
    ]),
  });
}

// ── Checkout field presets (Quick-Setup) ──────────────────────────────────────
const FIELD_PRESETS = {
  ml: {
    label: '🌟 Mobile Legends (Game ID + Server ID)',
    fields: [
      { key: 'game_id', label: 'Game ID',   fieldType: 'text',   required: true, placeholder: '218101075', sortOrder: 0 },
      { key: 'zone_id', label: 'Server ID', fieldType: 'number', required: true, placeholder: '9001',      sortOrder: 1 },
    ],
  },
  pubg: {
    label: '🔫 PUBG / Single-ID Game',
    fields: [
      { key: 'game_id', label: 'Player ID', fieldType: 'text', required: true, placeholder: 'e.g. 5234567890', sortOrder: 0 },
    ],
  },
  ff: {
    label: '🔥 Free Fire / Single-ID Game',
    fields: [
      { key: 'game_id', label: 'Player ID', fieldType: 'text', required: true, placeholder: 'e.g. 123456789', sortOrder: 0 },
    ],
  },
  genshin: {
    label: '⚔️ Genshin / UID-only Game',
    fields: [
      { key: 'game_id', label: 'UID', fieldType: 'text', required: true, placeholder: 'e.g. 700123456', sortOrder: 0 },
    ],
  },
  email: {
    label: '📧 Email-based (Gift Card / Account)',
    fields: [
      { key: 'email', label: 'Email Address', fieldType: 'text', required: true, placeholder: 'e.g. user@gmail.com', sortOrder: 0 },
    ],
  },
};

// ── Built-in game catalog templates ───────────────────────────────────────────
const CATALOG_TEMPLATES = {
  ml_diamonds: {
    label: '💎 Mobile Legends Diamonds',
    products: [
      { name: '💎 86 Diamonds',   finalPrice: 6000 },
      { name: '💎 172 Diamonds',  finalPrice: 12000 },
      { name: '💎 257 Diamonds',  finalPrice: 18000 },
      { name: '💎 343 Diamonds',  finalPrice: 24000 },
      { name: '💎 429 Diamonds',  finalPrice: 30000 },
      { name: '💎 514 Diamonds',  finalPrice: 36000 },
      { name: '💎 600 Diamonds',  finalPrice: 42000 },
      { name: '💎 706 Diamonds',  finalPrice: 49000 },
      { name: '💎 878 Diamonds',  finalPrice: 61000 },
      { name: '💎 963 Diamonds',  finalPrice: 67000 },
      { name: '💎 1050 Diamonds', finalPrice: 73000 },
      { name: '💎 1412 Diamonds', finalPrice: 98000 },
      { name: '💎 2195 Diamonds', finalPrice: 152000 },
      { name: '🏆 Weekly Pass',   finalPrice: 4500 },
      { name: '🏆 Twilight Pass', finalPrice: 35000 },
    ],
  },
  pubg_uc: {
    label: '🔫 PUBG Mobile UC',
    products: [
      { name: '🔫 60 UC',    finalPrice: 2000 },
      { name: '🔫 300 UC',   finalPrice: 9000 },
      { name: '🔫 325 UC',   finalPrice: 9500 },
      { name: '🔫 600 UC',   finalPrice: 17500 },
      { name: '🔫 660 UC',   finalPrice: 19000 },
      { name: '🔫 1500 UC',  finalPrice: 42000 },
      { name: '🔫 1800 UC',  finalPrice: 50000 },
      { name: '🔫 3000 UC',  finalPrice: 82000 },
      { name: '🔫 3850 UC',  finalPrice: 104000 },
      { name: '🔫 6000 UC',  finalPrice: 161000 },
      { name: '🔫 8100 UC',  finalPrice: 216000 },
    ],
  },
  ff_diamonds: {
    label: '🔥 Free Fire Diamonds',
    products: [
      { name: '🔥 50 Diamonds',    finalPrice: 1000 },
      { name: '🔥 100 Diamonds',   finalPrice: 2000 },
      { name: '🔥 210 Diamonds',   finalPrice: 4000 },
      { name: '🔥 310 Diamonds',   finalPrice: 6000 },
      { name: '🔥 520 Diamonds',   finalPrice: 10000 },
      { name: '🔥 1060 Diamonds',  finalPrice: 20000 },
      { name: '🔥 2180 Diamonds',  finalPrice: 40000 },
      { name: '🔥 5600 Diamonds',  finalPrice: 100000 },
      { name: '🔥 Weekly Pass',    finalPrice: 3000 },
    ],
  },
  genshin: {
    label: '⚔️ Genshin Impact Genesis Crystals',
    products: [
      { name: '⚔️ 60 Crystals',   finalPrice: 2000 },
      { name: '⚔️ 300 Crystals',  finalPrice: 9000 },
      { name: '⚔️ 980 Crystals',  finalPrice: 28000 },
      { name: '⚔️ 1980 Crystals', finalPrice: 55000 },
      { name: '⚔️ 3280 Crystals', finalPrice: 90000 },
      { name: '⚔️ 6480 Crystals', finalPrice: 176000 },
    ],
  },
  hok: {
    label: '👑 Honor of Kings Tokens',
    products: [
      { name: '👑 50 Tokens',   finalPrice: 1500 },
      { name: '👑 100 Tokens',  finalPrice: 3000 },
      { name: '👑 250 Tokens',  finalPrice: 7000 },
      { name: '👑 500 Tokens',  finalPrice: 14000 },
      { name: '👑 1000 Tokens', finalPrice: 27000 },
    ],
  },
  valorant: {
    label: '🎯 Valorant VP',
    products: [
      { name: '🎯 125 VP',   finalPrice: 3000 },
      { name: '🎯 420 VP',   finalPrice: 9000 },
      { name: '🎯 700 VP',   finalPrice: 15000 },
      { name: '🎯 1375 VP',  finalPrice: 28000 },
      { name: '🎯 2050 VP',  finalPrice: 42000 },
      { name: '🎯 3650 VP',  finalPrice: 73000 },
      { name: '🎯 5350 VP',  finalPrice: 105000 },
    ],
  },
  lol_wild: {
    label: '🃏 Wild Rift Wild Cores',
    products: [
      { name: '🃏 110 Wild Cores',  finalPrice: 3000 },
      { name: '🃏 570 Wild Cores',  finalPrice: 14000 },
      { name: '🃏 1000 Wild Cores', finalPrice: 24000 },
      { name: '🃏 2175 Wild Cores', finalPrice: 49000 },
      { name: '🃏 3600 Wild Cores', finalPrice: 80000 },
    ],
  },
};

// ── Bulk product parser ────────────────────────────────────────────────────────
// Parses lines like:
//   💎 86 - 5000 ks
//   86 Diamonds - 5,000 KS
//   Elite Pass - 35000
function parseBulkProducts(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    // Strip leading emoji/symbols (use Emoji_Presentation to avoid stripping digits 0-9)
    const clean = line.replace(/^[\p{Emoji_Presentation}\s*#•\-]+/u, '').trim();
    // Try: "Name - Price unit" or "Name - Price"
    const match = clean.match(/^(.+?)\s*[-–—]\s*([\d,\.]+)\s*(ks|mmk|k)?$/i);
    if (!match) continue;
    const name = match[1].trim();
    const priceRaw = parseFloat(match[2].replace(/,/g, ''));
    if (!name || isNaN(priceRaw) || priceRaw <= 0) continue;
    results.push({ name, finalPrice: priceRaw });
  }
  return results;
}

// ── Register ───────────────────────────────────────────────────────────────────

module.exports = (bot) => {
  // ── Catalog list ─────────────────────────────────────────────────────────────
  bot.action('admin_catalogs_action', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    // Top level only — sub-catalogs are shown inside each catalog's own view
    const roots = await Catalog.find({ parentCategory: null }).sort({ sortOrder: 1, name: 1 });
    if (!roots.length) {
      return ctx.reply(
        `📂 *Catalogs*\n\nNo catalogs yet.\nCatalogs group products and define what delivery info (Game ID, Player ID, etc.) is required during checkout.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add Catalog', 'cat_add')],
            [Markup.button.callback('🔙 Back', 'nav:go:admin_main')],
          ]),
        }
      );
    }
    // How many sub-catalogs each root has (one grouped query, not per-root)
    const subCounts = await Catalog.aggregate([
      { $match: { parentCategory: { $ne: null } } },
      { $group: { _id: '$parentCategory', n: { $sum: 1 } } },
    ]);
    const subMap = new Map(subCounts.map((s) => [String(s._id), s.n]));

    const rows = roots.map((c) => {
      const subs = subMap.get(String(c._id)) || 0;
      const meta = subs > 0 ? `${subs} sub${subs > 1 ? 's' : ''}` : `${c.checkoutFields.length} fields`;
      return [
        Markup.button.callback(`${c.isActive ? '✅' : '🔴'} ${c.name} (${meta})`, `cat_view:${c._id}`),
      ];
    });
    rows.push([Markup.button.callback('➕ Add Catalog', 'cat_add')]);
    rows.push([Markup.button.callback('🔙 Back', 'nav:go:admin_main')]);
    await ctx.reply(
      `📂 *Catalogs (${roots.length} top-level)*\n\nSelect a category to manage.\n_Sub-categories appear inside each one._`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  });

  // ── View catalog ─────────────────────────────────────────────────────────────
  bot.action(/^cat_view:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const catalog = await Catalog.findById(ctx.match[1]);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    await sendCatalogView(ctx, catalog);
  });

  // ── Add catalog — name prompt ─────────────────────────────────────────────
  bot.action('cat_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.catalogAction = 'add_name';
    ctx.session.newCatalogParent = null;
    await ctx.reply(
      `📂 *New Catalog*\n\nEnter the catalog name (e.g. "Mobile Legends", "PUBG Mobile", "Gift Cards"):\n\n_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Add sub-catalog under a specific parent ───────────────────────────────
  bot.action(/^cat_addsub:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const parent = await Catalog.findById(ctx.match[1]).select('name').lean();
    if (!parent) return ctx.reply('❌ Parent catalog not found.');
    ctx.session.catalogAction = 'add_name';
    ctx.session.newCatalogParent = ctx.match[1];
    await ctx.reply(
      `📂 *New Sub-Category under ${parent.name}*\n\nEnter the sub-category name (e.g. "Diamonds", "Weekly Pass"):\n\n_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Toggle active ─────────────────────────────────────────────────────────
  bot.action(/^cat_toggle:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const catalog = await Catalog.findById(ctx.match[1]);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    catalog.isActive = !catalog.isActive;
    await catalog.save();
    await auditLog(ctx.from.id, 'CATALOG_TOGGLE', catalog._id.toString(), 'Catalog', { isActive: catalog.isActive });
    await ctx.reply(`${catalog.isActive ? '✅' : '🔴'} *${catalog.name}* is now ${catalog.isActive ? 'Active' : 'Inactive'}.`, { parse_mode: 'Markdown' });
    await sendCatalogView(ctx, catalog);
  });

  // ── Delete catalog ────────────────────────────────────────────────────────
  bot.action(/^cat_del:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const catalog = await Catalog.findById(ctx.match[1]);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    const inUse = await Product.countDocuments({ catalogId: catalog._id });
    if (inUse > 0) {
      return ctx.reply(`❌ Cannot delete — *${catalog.name}* is used by ${inUse} product(s). Reassign products first.`, { parse_mode: 'Markdown' });
    }
    const childCount = await Catalog.countDocuments({ parentCategory: catalog._id });
    if (childCount > 0) {
      return ctx.reply(`❌ Cannot delete — *${catalog.name}* has ${childCount} sub-categor${childCount > 1 ? 'ies' : 'y'}. Delete or move them out first.`, { parse_mode: 'Markdown' });
    }
    await Catalog.deleteOne({ _id: catalog._id });
    await auditLog(ctx.from.id, 'CATALOG_DELETE', catalog._id.toString(), 'Catalog', { name: catalog.name });
    await ctx.reply(`🗑 Catalog *${catalog.name}* deleted.`, { parse_mode: 'Markdown' });
  });

  // ── Set image URL ─────────────────────────────────────────────────────────
  bot.action(/^cat_setimage:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.catalogAction = 'set_image_url';
    ctx.session.catalogId = ctx.match[1];
    await ctx.reply(
      `🖼 *Set Catalog Image*\n\nPaste an image URL (JPG/PNG/WebP) for this catalog, or send \`-\` to clear the image:\n\n_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Set parent category ────────────────────────────────────────────────────
  bot.action(/^cat_setparent:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const catalogId = ctx.match[1];
    const allCatalogs = await Catalog.find({ _id: { $ne: catalogId }, isActive: true }).sort({ name: 1 });
    const buttons = allCatalogs.map((c) => [
      Markup.button.callback(c.name, `cat_parent_pick:${catalogId}:${c._id}`),
    ]);
    buttons.push([Markup.button.callback('🚫 Remove Parent (make root)', `cat_parent_pick:${catalogId}:none`)]);
    buttons.push([Markup.button.callback('❌ Cancel', `cat_view:${catalogId}`)]);
    await ctx.reply(
      `🔗 *Set Parent Category*\n\nSelect which catalog this should be a sub-catalog of:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  bot.action(/^cat_parent_pick:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, catalogId, parentId] = ctx.match;
    const catalog = await Catalog.findById(catalogId);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    if (parentId !== 'none') {
      const parentExists = await Catalog.exists({ _id: parentId });
      if (!parentExists) return ctx.reply('❌ That parent no longer exists. Please pick another.');
      if (await wouldCreateCycle(catalogId, parentId)) {
        return ctx.reply('❌ Cannot set that parent — it would create a loop (you picked this catalog itself or one of its own sub-categories). Choose a different parent.');
      }
    }
    catalog.parentCategory = parentId === 'none' ? null : parentId;
    await catalog.save();
    await auditLog(ctx.from.id, 'CATALOG_SET_PARENT', catalogId, 'Catalog', { parentId });
    const msg = parentId === 'none' ? '✅ Parent removed — now a root category.' : '✅ Parent category set.';
    await ctx.reply(msg);
    await sendCatalogView(ctx, catalog);
  });

  // ── Reorder: Move Up / Move Down within sibling group ─────────────────────
  bot.action(/^cat_(moveup|movedown):(.+)$/, adminOnly(), async (ctx) => {
    const dir = ctx.match[1] === 'moveup' ? 'up' : 'down';
    const catalogId = ctx.match[2];
    const res = await moveCatalog(catalogId, dir);
    if (res.reason === 'notfound') { await ctx.answerCbQuery('❌ Not found'); return; }
    if (!res.ok && res.reason === 'edge') {
      await ctx.answerCbQuery(dir === 'up' ? 'Already at the top' : 'Already at the bottom');
    } else {
      await ctx.answerCbQuery(dir === 'up' ? '⬆️ Moved up' : '⬇️ Moved down');
      await auditLog(ctx.from.id, 'CATALOG_REORDER', catalogId, 'Catalog', { dir });
    }
    const fresh = await Catalog.findById(catalogId);
    if (fresh) await sendCatalogView(ctx, fresh);
  });

  // ── Pin catalog to top of its sibling group ───────────────────────────────
  bot.action(/^cat_pintop:(.+)$/, adminOnly(), async (ctx) => {
    const catalogId = ctx.match[1];
    const res = await pinCatalogTop(catalogId);
    if (!res.ok) { await ctx.answerCbQuery('❌ Not found'); return; }
    await ctx.answerCbQuery('📌 Pinned to top');
    await auditLog(ctx.from.id, 'CATALOG_PIN_TOP', catalogId, 'Catalog', {});
    const fresh = await Catalog.findById(catalogId);
    if (fresh) await sendCatalogView(ctx, fresh);
  });

  // ── Quick-Setup preset picker ─────────────────────────────────────────────
  bot.action(/^cat_preset:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const catalogId = ctx.match[1];
    const buttons = Object.entries(FIELD_PRESETS).map(([key, p]) => [
      Markup.button.callback(p.label, `cat_preset_apply:${catalogId}:${key}`),
    ]);
    buttons.push([Markup.button.callback('❌ Cancel', `cat_view:${catalogId}`)]);
    await ctx.reply(
      `⚡ *Quick-Setup Checkout Fields*\n\nSelect a preset — existing fields will be *replaced*:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  bot.action(/^cat_preset_apply:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Applying preset...');
    const [, catalogId, presetKey] = ctx.match;
    const preset = FIELD_PRESETS[presetKey];
    if (!preset) return ctx.reply('❌ Unknown preset.');
    const catalog = await Catalog.findById(catalogId);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    catalog.checkoutFields = preset.fields.map((f) => ({ ...f }));
    await catalog.save();
    await auditLog(ctx.from.id, 'CATALOG_PRESET_APPLY', catalogId, 'Catalog', { preset: presetKey, fields: preset.fields.map((f) => f.key) });
    await ctx.reply(`✅ *${preset.label}* applied to *${catalog.name}*!`, { parse_mode: 'Markdown' });
    await sendCatalogView(ctx, catalog);
  });

  // ── Remove checkout field ─────────────────────────────────────────────────
  bot.action(/^cat_field_del:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, catalogId, key] = ctx.match;
    const catalog = await Catalog.findById(catalogId);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    catalog.checkoutFields = catalog.checkoutFields.filter((f) => f.key !== key);
    await catalog.save();
    await auditLog(ctx.from.id, 'CATALOG_FIELD_DEL', catalogId, 'Catalog', { key });
    await ctx.reply(`✅ Field \`${key}\` removed.`, { parse_mode: 'Markdown' });
    await sendCatalogView(ctx, catalog);
  });

  // ── Add checkout field — starts a multi-step session ─────────────────────
  bot.action(/^cat_field_add:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.catalogAction = 'field_add';
    ctx.session.catalogFieldStep = 'key';
    ctx.session.catalogId = ctx.match[1];
    ctx.session.catalogFieldDraft = {};
    await ctx.reply(
      `➕ *Add Checkout Field*\n\nStep 1/4 — Enter the field *key* (short code, no spaces, e.g. \`game_id\`, \`player_id\`, \`email\`):\n\n_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Bulk add products command ─────────────────────────────────────────────
  bot.command('bulkaddproducts', adminOnly(), async (ctx) => {
    const catalogs = await Catalog.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
    if (!catalogs.length) {
      return ctx.reply('❌ No active catalogs. Create a catalog first with the admin panel → Catalogs.');
    }
    ctx.session.catalogAction = 'bulk_select_catalog';
    const buttons = catalogs.map((c) => [Markup.button.callback(c.name, `bulk_cat:${c._id}`)]);
    buttons.push([Markup.button.callback('❌ Cancel', 'bulk_cancel')]);
    await ctx.reply(
      `📦 *Bulk Add Products*\n\nSelect the catalog these products belong to:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });

  bot.action(/^bulk_cat:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const catalog = await Catalog.findById(ctx.match[1]);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    ctx.session.bulkCatalogId = catalog._id.toString();
    ctx.session.bulkCatalogName = catalog.name;

    // Show choice: use template or paste manually
    const templateButtons = Object.entries(CATALOG_TEMPLATES).map(([key, tpl]) => [
      Markup.button.callback(tpl.label, `bulk_tpl:${key}`),
    ]);

    await ctx.reply(
      `📦 *Bulk Add — ${catalog.name}*\n\nChoose how to add products:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...templateButtons,
          [Markup.button.callback('✍️ Paste My Own List', `bulk_manual:${catalog._id}`)],
          [Markup.button.callback('❌ Cancel', 'bulk_cancel')],
        ]),
      }
    );
  });

  // ── Template selected — preview & confirm ─────────────────────────────────
  bot.action(/^bulk_tpl:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const tpl = CATALOG_TEMPLATES[key];
    if (!tpl) return ctx.reply('❌ Template not found.');

    const catalogId = ctx.session.bulkCatalogId;
    const catalogName = ctx.session.bulkCatalogName;
    if (!catalogId) return ctx.reply('❌ No catalog selected. Start again.');

    ctx.session.bulkProductsDraft = tpl.products;
    ctx.session.catalogAction = 'bulk_pending_confirm';

    const preview = tpl.products
      .slice(0, 20)
      .map((p, i) => `${i + 1}\\. *${p.name}* — ${p.finalPrice.toLocaleString()} KS`)
      .join('\n');
    const more = tpl.products.length > 20 ? `\n_... and ${tpl.products.length - 20} more_` : '';

    await ctx.reply(
      `📋 *Template Preview — ${tpl.label}*\n\n${preview}${more}\n\nCatalog: *${catalogName}*\n\n_Prices shown are defaults — you can edit each product after import._\n\nConfirm import?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Import Template', `bulk_confirm:${catalogId}`)],
          [Markup.button.callback('❌ Cancel', 'bulk_cancel')],
        ]),
      }
    );
  });

  // ── Manual paste ──────────────────────────────────────────────────────────
  bot.action(/^bulk_manual:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.catalogAction = 'bulk_paste';
    await ctx.reply(
      `📦 *Bulk Add — ${ctx.session.bulkCatalogName}*\n\nPaste your product list, one per line:\n\n` +
      `Format: \`Product Name - Price\`\n\nExamples:\n` +
      `\`💎 86 Diamonds - 5000\`\n` +
      `\`💎 172 Diamonds - 10000\`\n` +
      `\`Elite Pass - 35000 ks\`\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('bulk_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    ctx.session.catalogAction = null;
    ctx.session.bulkCatalogId = null;
    await ctx.reply('❌ Bulk import cancelled.');
  });

  // ── Confirm bulk import ───────────────────────────────────────────────────
  bot.action(/^bulk_confirm:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Saving...');
    const catalogId = ctx.match[1];
    const products = ctx.session.bulkProductsDraft;
    const catalogName = ctx.session.bulkCatalogName;
    if (!products?.length) return ctx.reply('❌ Nothing to import.');

    const catalog = await Catalog.findById(catalogId);
    if (!catalog) return ctx.reply('❌ Catalog not found.');

    const docs = products.map((p, i) => ({
      name: p.name,
      category: catalog.name,
      catalogId: catalog._id,
      region: 'Global',
      baseCurrency: 'MMK',
      baseCost: p.finalPrice,
      finalPrice: p.finalPrice,
      sortOrder: i,
      isActive: true,
      productType: 'DirectTopup',
    }));

    await Product.insertMany(docs);
    await auditLog(ctx.from.id, 'BULK_PRODUCTS_IMPORT', catalogId, 'Product', { count: docs.length, catalogName });

    ctx.session.bulkProductsDraft = null;
    ctx.session.catalogAction = null;
    ctx.session.bulkCatalogId = null;

    await ctx.reply(
      `✅ *${docs.length} products* added to *${catalogName}*!`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 View Products', 'pm_list_products')]]),
      }
    );
  });

  // ── Message handler — catalog field wizard + bulk paste ───────────────────
  // NOTE: This is a catch-all `message` handler. It must NOT be gated with
  // adminOnly() as middleware — doing so denies every non-owner message that
  // reaches this point (e.g. menu buttons whose handlers load later, like
  // "🎁 Coin Rewards"). Instead we pass non-owners through with next().
  bot.on('message', async (ctx, next) => {
    const { config } = require('../../config/settings');
    if (Number(ctx.from?.id) !== Number(config.bot.adminId)) return next();
    const action = ctx.session?.catalogAction;
    const text = ctx.message?.text?.trim();

    // Session-less product list paste detection (e.g. after bot restart)
    if (!action && text) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const productLines = lines.filter(l => /^.+\s*[-–—]\s*[\d,]+/.test(l));
      if (productLines.length >= 3) {
        return ctx.reply(
          `📦 *Product list detected!*\n\nSession expired (bot restarted). To import:\n\n1. *Manage Products → 📦 Bulk Import*\n2. Catalog ရွေး\n3. *✍️ Paste My Own List* tap\n4. List paste ထည့်\n\n_Your list is still in your clipboard — just paste it again after step 3._`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    if (!action) return next();

    // Cancel
    if (text === '/cancel') {
      ctx.session.catalogAction = null;
      ctx.session.catalogFieldStep = null;
      ctx.session.catalogId = null;
      ctx.session.catalogFieldDraft = null;
      ctx.session.bulkCatalogId = null;
      ctx.session.bulkProductsDraft = null;
      ctx.session.newCatalogParent = null;
      return ctx.reply('❌ Cancelled.');
    }

    // ── Set image URL ─────────────────────────────────────────────────────
    if (action === 'set_image_url') {
      if (!text) return ctx.reply('Please paste an image URL or send `-` to clear:');
      const catalog = await Catalog.findById(ctx.session.catalogId);
      if (!catalog) return ctx.reply('❌ Catalog not found.');
      catalog.imageUrl = text === '-' ? null : text;
      await catalog.save();
      await auditLog(ctx.from.id, 'CATALOG_SET_IMAGE', catalog._id.toString(), 'Catalog', { imageUrl: catalog.imageUrl });
      ctx.session.catalogAction = null;
      await ctx.reply(text === '-' ? '✅ Image cleared.' : '✅ Image URL saved.');
      await sendCatalogView(ctx, catalog);
      return;
    }

    // ── Add catalog name ──────────────────────────────────────────────────
    if (action === 'add_name') {
      if (!text) return ctx.reply('Please enter a catalog name:');
      const existing = await Catalog.findOne({ name: { $regex: `^${text}$`, $options: 'i' } });
      if (existing) return ctx.reply(`❌ A catalog named *${text}* already exists.`, { parse_mode: 'Markdown' });

      // If created via "Add Sub-Category", nest it under the chosen parent
      const parentId = ctx.session.newCatalogParent || null;
      if (parentId) {
        const parentExists = await Catalog.exists({ _id: parentId });
        if (!parentExists) {
          ctx.session.catalogAction = null;
          ctx.session.newCatalogParent = null;
          return ctx.reply('❌ The parent category no longer exists. Please start again from 📂 Catalogs.');
        }
      }
      // Append at the end of its sibling group so existing/pinned order stays stable
      const lastSibling = await Catalog.findOne({ parentCategory: parentId }).sort({ sortOrder: -1 }).select('sortOrder').lean();
      const nextOrder = (lastSibling?.sortOrder ?? -1) + 1;
      const catalog = await Catalog.create({ name: text, sortOrder: nextOrder, parentCategory: parentId });
      await auditLog(ctx.from.id, 'CATALOG_CREATE', catalog._id.toString(), 'Catalog', { name: text, parentId });
      ctx.session.catalogAction = null;
      ctx.session.newCatalogParent = null;
      await ctx.reply(
        `✅ Catalog *${catalog.name}* created!\n\n` +
        `Checkout fields are *optional*:\n` +
        `• If buyers must send delivery info (Game ID, Server ID, Email…) → *Add Field* or *Quick-Setup*.\n` +
        `• If this category needs *no buyer input* (e.g. account delivery — you send Gmail/password/instructions after purchase) → tap *Done*.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add Field', `cat_field_add:${catalog._id}`)],
            [Markup.button.callback('⚡ Quick-Setup', `cat_preset:${catalog._id}`)],
            [Markup.button.callback('✅ Done — No Fields Needed', `cat_view:${catalog._id}`)],
          ]),
        }
      );
      return;
    }

    // ── Checkout field wizard ─────────────────────────────────────────────
    if (action === 'field_add') {
      if (!text) return;
      const step = ctx.session.catalogFieldStep;
      const draft = ctx.session.catalogFieldDraft || {};

      if (step === 'key') {
        const key = text.toLowerCase().replace(/\s+/g, '_');
        draft.key = key;
        ctx.session.catalogFieldDraft = draft;
        ctx.session.catalogFieldStep = 'label';
        return ctx.reply(
          `Step 2/4 — Enter the field *label* (shown to user, e.g. "Game ID", "Player ID", "Email Address"):`,
          { parse_mode: 'Markdown' }
        );
      }

      if (step === 'label') {
        draft.label = text;
        ctx.session.catalogFieldDraft = draft;
        ctx.session.catalogFieldStep = 'required';
        return ctx.reply(
          `Step 3/4 — Is this field *required*?`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('✅ Required', 'cat_field_req:yes'), Markup.button.callback('☑️ Optional', 'cat_field_req:no')],
            ]),
          }
        );
      }

      if (step === 'placeholder') {
        draft.placeholder = text === '-' ? '' : text;
        ctx.session.catalogFieldDraft = null;
        ctx.session.catalogFieldStep = null;
        ctx.session.catalogAction = null;

        const catalog = await Catalog.findById(ctx.session.catalogId);
        if (!catalog) return ctx.reply('❌ Catalog not found.');
        catalog.checkoutFields.push({
          key: draft.key,
          label: draft.label,
          fieldType: draft.fieldType || 'text',
          required: draft.required !== false,
          placeholder: draft.placeholder || '',
          sortOrder: catalog.checkoutFields.length,
        });
        await catalog.save();
        await auditLog(ctx.from.id, 'CATALOG_FIELD_ADD', catalog._id.toString(), 'Catalog', { key: draft.key, label: draft.label });
        await ctx.reply(`✅ Field *${draft.label}* added to *${catalog.name}*!`, { parse_mode: 'Markdown' });
        await sendCatalogView(ctx, catalog);
        return;
      }

      return next();
    }

    // ── Edit field label ──────────────────────────────────────────────────
    if (action === 'fedit_label') {
      if (!text) return ctx.reply('Please enter the new label:');
      const catalog = await Catalog.findById(ctx.session.catalogId);
      if (!catalog) return ctx.reply('❌ Catalog not found.');
      const field = catalog.checkoutFields.find((f) => f.key === ctx.session.catalogEditKey);
      if (!field) return ctx.reply('❌ Field not found.');
      field.label = text;
      await catalog.save();
      await auditLog(ctx.from.id, 'CATALOG_FIELD_EDIT', catalog._id.toString(), 'Catalog', { key: field.key, label: text });
      ctx.session.catalogAction  = null;
      ctx.session.catalogEditKey = null;
      await ctx.reply(`✅ Label updated to *${text}*.`, { parse_mode: 'Markdown' });
      await sendCatalogView(ctx, catalog);
      return;
    }

    // ── Edit field placeholder ────────────────────────────────────────────
    if (action === 'fedit_ph') {
      if (!text) return ctx.reply('Please enter the new placeholder (or `-` to clear):');
      const catalog = await Catalog.findById(ctx.session.catalogId);
      if (!catalog) return ctx.reply('❌ Catalog not found.');
      const field = catalog.checkoutFields.find((f) => f.key === ctx.session.catalogEditKey);
      if (!field) return ctx.reply('❌ Field not found.');
      field.placeholder = text === '-' ? '' : text;
      await catalog.save();
      await auditLog(ctx.from.id, 'CATALOG_FIELD_EDIT', catalog._id.toString(), 'Catalog', { key: field.key, placeholder: field.placeholder });
      ctx.session.catalogAction  = null;
      ctx.session.catalogEditKey = null;
      await ctx.reply(text === '-' ? '✅ Placeholder cleared.' : `✅ Placeholder updated to _${text}_.`, { parse_mode: 'Markdown' });
      await sendCatalogView(ctx, catalog);
      return;
    }

    // ── Bulk product paste (manual) ───────────────────────────────────────
    if (action === 'bulk_paste' || action === 'bulk_pending_confirm') {
      if (!text) return ctx.reply('Please paste your product list:');

      const products = parseBulkProducts(text);
      if (!products.length) {
        // In confirm state, a non-parseable message might just be a mistake — ignore and let buttons handle it
        if (action === 'bulk_pending_confirm') return next();
        return ctx.reply(
          `❌ Could not parse any products.\n\nEach line must be:\n\`Product Name - Price\`\nExample: \`86 Diamonds - 5000\``,
          { parse_mode: 'Markdown' }
        );
      }

      // If user pasted a list while in confirm state → treat as override (new manual import)
      if (action === 'bulk_pending_confirm' && !ctx.session.bulkCatalogId) {
        return ctx.reply(
          `❌ Session expired. Please start again:\n\n*Manage Products → 📦 Bulk Import → select catalog → ✍️ Paste My Own List*`,
          { parse_mode: 'Markdown' }
        );
      }

      ctx.session.bulkProductsDraft = products;
      ctx.session.catalogAction = 'bulk_pending_confirm';

      const preview = products
        .slice(0, 20)
        .map((p, i) => `${i + 1}. *${p.name}* — ${p.finalPrice.toLocaleString()} KS`)
        .join('\n');
      const more = products.length > 20 ? `\n_... and ${products.length - 20} more_` : '';
      const catalogName = ctx.session.bulkCatalogName || 'Selected Catalog';

      await ctx.reply(
        `📋 *Preview (${products.length} products)*\n\n${preview}${more}\n\nCatalog: *${catalogName}*\n\nConfirm import?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Import', `bulk_confirm:${ctx.session.bulkCatalogId}`)],
            [Markup.button.callback('❌ Cancel', 'bulk_cancel')],
          ]),
        }
      );
      return;
    }

    return next();
  });

  // ── Field required/optional buttons ──────────────────────────────────────
  bot.action(/^cat_field_req:(yes|no)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const draft = ctx.session.catalogFieldDraft || {};
    draft.required = ctx.match[1] === 'yes';
    ctx.session.catalogFieldDraft = draft;
    ctx.session.catalogFieldStep = 'fieldType';
    await ctx.reply(
      `Step 4a/4 — Field type:`,
      {
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Text', 'cat_field_type:text'),
            Markup.button.callback('Number', 'cat_field_type:number'),
          ],
          [
            Markup.button.callback('Email', 'cat_field_type:email'),
            Markup.button.callback('Textarea', 'cat_field_type:textarea'),
          ],
        ]),
      }
    );
  });

  bot.action(/^cat_field_type:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const draft = ctx.session.catalogFieldDraft || {};
    draft.fieldType = ctx.match[1];
    ctx.session.catalogFieldDraft = draft;
    ctx.session.catalogFieldStep = 'placeholder';
    await ctx.reply(
      `Step 4b/4 — Enter placeholder text (shown greyed out in the input), or send \`-\` to skip:`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Edit existing field — pick what to change ─────────────────────────────
  bot.action(/^cat_field_edit:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, catalogId, key] = ctx.match;
    const catalog = await Catalog.findById(catalogId);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    const field = catalog.checkoutFields.find((f) => f.key === key);
    if (!field) return ctx.reply('❌ Field not found.');
    await ctx.reply(
      `✏️ *Edit Field: ${field.label}*\n\n` +
      `Key: \`${field.key}\`\n` +
      `Label: *${field.label}*\n` +
      `Placeholder: _${field.placeholder || '(none)'}_ \n` +
      `Required: ${field.required ? '✅ Yes' : '☑️ Optional'}\n\n` +
      `What do you want to change?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Change Label',       `cat_fedit_label:${catalogId}:${key}`)],
          [Markup.button.callback('📝 Change Placeholder', `cat_fedit_ph:${catalogId}:${key}`)],
          [Markup.button.callback('🔀 Toggle Required',    `cat_fedit_req:${catalogId}:${key}`)],
          [Markup.button.callback('🔙 Back',               `cat_view:${catalogId}`)],
        ]),
      }
    );
  });

  bot.action(/^cat_fedit_label:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, catalogId, key] = ctx.match;
    ctx.session.catalogAction   = 'fedit_label';
    ctx.session.catalogId       = catalogId;
    ctx.session.catalogEditKey  = key;
    await ctx.reply(`✏️ Enter the new *label* for field \`${key}\`:\n\n_Send /cancel to abort._`, { parse_mode: 'Markdown' });
  });

  bot.action(/^cat_fedit_ph:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, catalogId, key] = ctx.match;
    ctx.session.catalogAction   = 'fedit_ph';
    ctx.session.catalogId       = catalogId;
    ctx.session.catalogEditKey  = key;
    await ctx.reply(`📝 Enter the new *placeholder* for field \`${key}\` (e.g. \`218101075\`), or \`-\` to clear:\n\n_Send /cancel to abort._`, { parse_mode: 'Markdown' });
  });

  bot.action(/^cat_fedit_req:([^:]+):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, catalogId, key] = ctx.match;
    const catalog = await Catalog.findById(catalogId);
    if (!catalog) return ctx.reply('❌ Catalog not found.');
    const field = catalog.checkoutFields.find((f) => f.key === key);
    if (!field) return ctx.reply('❌ Field not found.');
    field.required = !field.required;
    await catalog.save();
    await auditLog(ctx.from.id, 'CATALOG_FIELD_EDIT', catalogId, 'Catalog', { key, required: field.required });
    await ctx.reply(`✅ *${field.label}* is now ${field.required ? '✅ Required' : '☑️ Optional'}.`, { parse_mode: 'Markdown' });
    await sendCatalogView(ctx, catalog);
  });

  // ── One-time migration: auto-create parent catalogs + assign sub-catalogs ─────
  bot.command('migratecatalogs', adminOnly(), async (ctx) => {
    const GROUPS = [
      { prefixes: ['ML ', 'MLBB '], parent: 'Mobile Legends' },
      { prefixes: ['FF ', 'Free Fire'], parent: 'Free Fire' },
      { prefixes: ['PUBG '], parent: 'PUBG Mobile' },
      { prefixes: ['Genshin '], parent: 'Genshin Impact' },
      { prefixes: ['Honkai ', 'HSR '], parent: 'Honkai: Star Rail' },
      { prefixes: ['Valorant '], parent: 'Valorant' },
    ];

    const all = await Catalog.find({}).lean();
    const lines = ['🔄 *Running catalog migration...*\n'];

    for (const group of GROUPS) {
      const children = all.filter(c =>
        group.prefixes.some(p => c.name.startsWith(p)) && c.name !== group.parent
      );
      if (!children.length) continue;

      let parent = await Catalog.findOne({ name: group.parent });
      if (!parent) {
        parent = await Catalog.create({ name: group.parent, isActive: true, checkoutFields: [], sortOrder: 0 });
        lines.push(`✅ Created: *${group.parent}*`);
      } else {
        lines.push(`📂 Found: *${group.parent}*`);
      }

      for (const child of children) {
        if (child.parentCategory && child.parentCategory.toString() === parent._id.toString()) {
          lines.push(`  ⏭ Already: ${child.name}`);
        } else {
          await Catalog.updateOne({ _id: child._id }, { $set: { parentCategory: parent._id } });
          lines.push(`  ✅ ${child.name} → ${group.parent}`);
        }
      }
    }

    lines.push('\n✅ *Migration complete!*');
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });
};
