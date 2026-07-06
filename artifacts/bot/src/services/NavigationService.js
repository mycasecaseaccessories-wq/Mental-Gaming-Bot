/**
 * NavigationService
 *
 * Registry-based folder navigation with session history stack.
 *
 * Each folder defines:
 *   id       – unique string key
 *   title    – display name
 *   parent   – parent folder id (or null for root)
 *   build(ctx) → Promise<{ text: string, keyboard: InlineKeyboardMarkup }>
 *
 * Session shape:  ctx.session.nav = { history: ['main', 'shop', 'ml'] }
 */

const { Markup } = require('telegraf');
const { getTheme } = require('./ThemeService');

const registry = new Map();

// Dynamic resolvers handle folders whose id is not known at startup
// (e.g. catalog:<id>). Each resolver: { match(id)→bool, build(ctx,theme,id)→{text,keyboard} }
const dynamicResolvers = [];

function register(folder) {
  if (!folder.id || typeof folder.build !== 'function') {
    throw new Error(`[Nav] Invalid folder definition: ${JSON.stringify(folder)}`);
  }
  registry.set(folder.id, folder);
}

function registerDynamic(resolver) {
  if (typeof resolver.match !== 'function' || typeof resolver.build !== 'function') {
    throw new Error('[Nav] Invalid dynamic resolver: needs match() and build()');
  }
  dynamicResolvers.push(resolver);
}

function resolveFolder(folderId) {
  const exact = registry.get(folderId);
  if (exact) return exact;
  const dyn = dynamicResolvers.find((r) => r.match(folderId));
  if (dyn) return { id: folderId, build: (ctx, theme) => dyn.build(ctx, theme, folderId) };
  return null;
}

function getFolder(id) {
  return registry.get(id) || null;
}

function getHistory(ctx) {
  if (!ctx.session.nav) ctx.session.nav = { history: [] };
  return ctx.session.nav.history;
}

function pushHistory(ctx, folderId) {
  const history = getHistory(ctx);
  if (history[history.length - 1] !== folderId) {
    history.push(folderId);
  }
}

function popHistory(ctx) {
  const history = getHistory(ctx);
  history.pop();
  return history[history.length - 1] || null;
}

function clearHistory(ctx) {
  ctx.session.nav = { history: [] };
}

/**
 * Navigate to a folder — push to history and render.
 */
async function navigate(ctx, folderId, editMessage = false) {
  const folder = resolveFolder(folderId);
  if (!folder) {
    console.warn(`[Nav] Folder not found: ${folderId}`);
    return ctx.reply('❌ Menu not found.');
  }

  pushHistory(ctx, folderId);

  const theme = getTheme(ctx.user);
  const { text, keyboard } = await folder.build(ctx, theme);

  const opts = { parse_mode: 'Markdown', ...keyboard };

  if (editMessage && ctx.callbackQuery?.message) {
    return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

/**
 * Go back one level in history.
 */
async function back(ctx) {
  const prevId = popHistory(ctx);

  if (!prevId) {
    clearHistory(ctx);
    return navigate(ctx, 'main', true);
  }

  return navigate(ctx, prevId, true);
}

/**
 * Build a consistent back button row.
 */
function backButton(label = '🔙 Back') {
  return [Markup.button.callback(label, 'nav:back')];
}

/**
 * Build a folder row button.
 */
function folderButton(label, folderId) {
  return Markup.button.callback(`📁 ${label}`, `nav:go:${folderId}`);
}

/**
 * Build an item/action row button.
 */
function itemButton(label, actionId, emoji = '💎') {
  return Markup.button.callback(`${emoji} ${label}`, actionId);
}

/**
 * Build rows from an array of items (auto-chunks into 2 per row).
 */
function buildRows(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

module.exports = {
  register,
  registerDynamic,
  getFolder,
  navigate,
  back,
  clearHistory,
  backButton,
  folderButton,
  itemButton,
  buildRows,
  registry,
};
