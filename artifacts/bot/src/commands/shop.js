/**
 * Shop command — registers all navigation folders and wires /shop entry.
 */

const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const Product = require('../models/Product');
const Catalog = require('../models/Catalog');
const CacheService = require('../services/CacheService');
const { loadingMessage, resolveMessage } = require('../utils/animations');
const { buildMessage, price, truncate } = require('../utils/ui');
const { t } = require('../utils/i18n');

function backRow() {
  return Nav.backButton();
}

const { mainMenuKeyboard } = require('../utils/keyboard');

Nav.register({
  id: 'main',
  title: 'Main Menu',
  build: async (ctx, theme) => {
    const name = ctx.from?.first_name || 'there';
    const balanceKS   = ctx.user?.balanceKS   || 0;
    const balanceCoin = ctx.user?.balanceCoin  || 0;
    const tier        = ctx.user?.membershipTier || 'Silver';

    const text = buildMessage(theme, [
      {
        title: `Mental Gaming Store`,
        lines: [
          `${theme.emoji.user} Welcome, ${theme.format.bold(name)}!`,
          `${theme.emoji.money} Balance: ${theme.format.code(price(balanceKS))}`,
          `${theme.emoji.coin} Coins: ${theme.format.code(balanceCoin.toLocaleString() + ' MC')}`,
          `${theme.emoji.star} Tier: ${tier}`,
        ],
      },
      { title: null, lines: ['_Tap a button below to continue._'] },
    ]);

    // Reply keyboard (persistent buttons) — no inline buttons on the main menu
    return { text, keyboard: mainMenuKeyboard(ctx) };
  },
});

// Load active catalogs and determine which subtrees contain at least one product.
// Products match a catalog by catalogId OR by legacy category name.
async function loadShopTree() {
  const catalogs = await Catalog.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();

  const children = new Map(); // parentId(str) → [catalog]
  for (const c of catalogs) {
    if (c.parentCategory) {
      const pid = String(c.parentCategory);
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(c);
    }
  }

  const directCount = new Map();
  await Promise.all(catalogs.map(async (c) => {
    const n = await Product.countDocuments({
      isActive: true,
      $or: [
        { catalogId: c._id },
        { catalogId: { $in: [null, undefined] }, category: c.name },
      ],
    });
    directCount.set(String(c._id), n);
  }));

  const subtreeCache = new Map();
  function subtreeHasProducts(idStr) {
    if (subtreeCache.has(idStr)) return subtreeCache.get(idStr);
    let has = (directCount.get(idStr) || 0) > 0;
    if (!has) has = (children.get(idStr) || []).some((k) => subtreeHasProducts(String(k._id)));
    subtreeCache.set(idStr, has);
    return has;
  }

  return { catalogs, children, subtreeHasProducts };
}

Nav.register({
  id: 'shop',
  title: '🛒 Shop',
  build: async (ctx, theme) => {
    const { catalogs, subtreeHasProducts } = await loadShopTree();
    const roots = catalogs.filter((c) => !c.parentCategory && subtreeHasProducts(String(c._id)));

    if (!roots.length) {
      const text = buildMessage(theme, [{
        title: t(ctx, 'shop.title'),
        lines: [`${theme.emoji.warning} ${t(ctx, 'shop.no_products')}`],
      }]);
      return {
        text,
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, 'shop.search'), 'shop_search')],
          backRow(),
        ]),
      };
    }

    const text = buildMessage(theme, [
      {
        title: t(ctx, 'shop.title'),
        lines: [
          `${theme.emoji.bullet} ${t(ctx, 'shop.browse')}`,
          `${theme.emoji.bullet} ${t(ctx, 'shop.prices_ks')}`,
        ],
      },
    ]);

    const rows = Nav.buildRows(roots.map((c) => Nav.folderButton(c.name, `cat:${c._id}`)), 2);
    const keyboard = Markup.inlineKeyboard([
      ...rows,
      [Markup.button.callback(t(ctx, 'shop.search'), 'shop_search')],
      backRow(),
    ]);

    return { text, keyboard };
  },
});

// Dynamic catalog view — handles any catalog (root or sub-catalog), any depth.
// folderId format: `cat:<catalogId>`
Nav.registerDynamic({
  match: (id) => id.startsWith('cat:'),
  build: async (ctx, theme, folderId) => {
    const catId = folderId.slice(4);

    let cat = null;
    try {
      cat = await Catalog.findOne({ _id: catId, isActive: true }).lean();
    } catch (_) {
      cat = null;
    }
    if (!cat) {
      return {
        text: buildMessage(theme, [{ title: '🛒 Shop', lines: [`${theme.emoji.warning} ${t(ctx, 'shop.no_products')}`] }]),
        keyboard: Markup.inlineKeyboard([backRow()]),
      };
    }

    const title = `📁 ${cat.name}`;
    const { children, subtreeHasProducts } = await loadShopTree();
    const subCatalogs = (children.get(String(cat._id)) || []).filter((k) => subtreeHasProducts(String(k._id)));
    const products = await CacheService.getCachedCatalogProducts(cat._id, cat.name);

    if (!subCatalogs.length && !products.length) {
      return {
        text: buildMessage(theme, [{ title, lines: [`${theme.emoji.warning} ${t(ctx, 'shop.no_products')}`] }]),
        keyboard: Markup.inlineKeyboard([backRow()]),
      };
    }

    const subRows = Nav.buildRows(subCatalogs.map((k) => Nav.folderButton(k.name, `cat:${k._id}`)), 2);
    const prodRows = products.map((p) => [
      Markup.button.callback(
        `${theme.emoji.item} ${truncate(p.name, 28)} — ${price(p.finalPrice)}`,
        `product:${p._id}`
      ),
    ]);

    const lines = [];
    if (cat.description) lines.push(cat.description, '');
    if (products.length) {
      lines.push(`${theme.emoji.bullet} ${products.length} ${t(ctx, 'shop.packages_available')}`);
      lines.push(`${theme.emoji.bullet} ${t(ctx, 'shop.tap_to_order')}`);
    } else {
      lines.push(`${theme.emoji.bullet} ${t(ctx, 'shop.select_package')}:`);
    }

    const text = buildMessage(theme, [{ title, lines }]);
    return { text, keyboard: Markup.inlineKeyboard([...subRows, ...prodRows, backRow()]) };
  },
});

module.exports = function registerShop(bot) {
  bot.command('shop', async (ctx) => {
    Nav.clearHistory(ctx);
    await Nav.navigate(ctx, 'shop');
  });

  bot.hears(['🛒 Shop', '🛒 ဈေးဝယ်'], async (ctx) => {
    Nav.clearHistory(ctx);
    await Nav.navigate(ctx, 'shop');
  });

  bot.command('menu', async (ctx) => {
    Nav.clearHistory(ctx);
    await Nav.navigate(ctx, 'main');
  });

  bot.action(/^product:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const ref = await loadingMessage(ctx, '⌛ Loading product\\.\\.\\.');

    try {
      const product = await Product.findById(productId);
      if (!product) return resolveMessage(ctx, ref, t(ctx, 'shop.product_not_found'));

      const theme = require('../services/ThemeService').getTheme(ctx.user);
      const stockLabel = product.stockCount === -1
        ? t(ctx, 'shop.stock_unlimited')
        : `${product.stockCount} ${t(ctx, 'shop.stock_left')}`;

      const text = buildMessage(theme, [{
        title: product.name,
        lines: [
          `${theme.emoji.folder} ${t(ctx, 'shop.category')}: ${product.category}`,
          `🌍 ${t(ctx, 'shop.region')}: ${product.region}`,
          `${theme.emoji.money} ${t(ctx, 'shop.price')}: ${theme.format.bold(price(product.finalPrice))}`,
          `📦 ${t(ctx, 'shop.stock')}: ${stockLabel}`,
          product.description ? `\n📝 ${product.description}` : null,
        ],
      }]);

      const botUsername = ctx.botInfo?.username;
      const shareUrl   = botUsername
        ? `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}?start=product_${product._id}`)}&text=${encodeURIComponent(`🎮 ${product.name} — Mental Gaming Store`)}`
        : null;

      await resolveMessage(ctx, ref, text, {
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, 'shop.order_now'), `order_start:${product._id}`)],
          ...(shareUrl ? [[Markup.button.url('📤 Share', shareUrl)]] : []),
          Nav.backButton(),
        ]),
      });
    } catch (err) {
      await resolveMessage(ctx, ref, `❌ Error: ${err.message}`);
    }
  });
};
