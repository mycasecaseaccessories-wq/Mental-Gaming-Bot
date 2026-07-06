/**
 * UI Helpers — themed message builders for consistent visual language.
 */

/**
 * Build a horizontal divider line using theme divider char.
 */
function divider(theme, length = 18) {
  return theme.emoji.divider.repeat(length);
}

/**
 * Render a section header with theme formatting.
 */
function header(theme, title) {
  return theme.format.header(title);
}

/**
 * Render a key-value row with consistent spacing.
 */
function row(theme, label, value) {
  return `${theme.emoji.bullet} ${label}: ${theme.format.bold(value)}`;
}

/**
 * Render a stat block (icon + label + value on one line).
 */
function stat(icon, label, value) {
  return `${icon} *${label}:* \`${value}\``;
}

/**
 * Render a badge-style tag.
 */
function badge(theme, text) {
  return theme.format.tag(text);
}

/**
 * Membership tier with emoji decoration.
 */
function tierBadge(tier) {
  const map = { Silver: '🥈 Silver', Gold: '🥇 Gold', Platinum: '💎 Platinum' };
  return map[tier] || tier;
}

/**
 * Order status with emoji.
 */
function statusBadge(status) {
  const map = {
    Pending:   '🟡 Pending',
    Success:   '🟢 Success',
    Cancelled: '🔴 Cancelled',
    Refunded:  '🔵 Refunded',
  };
  return map[status] || status;
}

/**
 * Format a KS price.
 */
function price(amount) {
  return `${Number(amount).toLocaleString()} KS`;
}

/**
 * Format a date to readable Myanmar-friendly string.
 */
function formatDate(date) {
  return new Date(date).toLocaleString('en-GB', {
    timeZone: 'Asia/Rangoon',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Build a full themed message block.
 * sections = [{ title, lines: [string] }]
 */
function buildMessage(theme, sections) {
  return sections
    .map(({ title, lines }) => {
      const body = lines.filter(Boolean).join('\n');
      if (!title) return body;
      return `${header(theme, title)}\n${divider(theme)}\n${body}`;
    })
    .join(`\n\n`);
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str, max = 40) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

module.exports = { divider, header, row, stat, badge, tierBadge, statusBadge, price, formatDate, buildMessage, truncate };
