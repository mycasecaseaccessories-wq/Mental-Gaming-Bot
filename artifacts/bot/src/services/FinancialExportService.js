/**
 * FinancialExportService
 *
 * Generates period-based financial reports from Orders + Transactions.
 *
 * Sections:
 *   1. Revenue Summary (gross, refunds, net, topups)
 *   2. Orders breakdown by status
 *   3. Discount analysis (promo + tier)
 *   4. Top 10 products by revenue
 *   5. Top 10 customers by spending
 *   6. Payment method breakdown
 *   7. Daily revenue + topup trend
 *
 * Output:
 *   { summary, csv, periodLabel }
 */

const Order       = require('../models/Order');
const Transaction = require('../models/Transaction');
const User        = require('../models/User');

// ── Date helpers (all display in MMT / Asia/Rangoon) ─────────────────────────

const TZ = 'Asia/Rangoon';

function toMmtDate(date) {
  return new Date(date).toLocaleDateString('en-GB', { timeZone: TZ });
}

function toMmtDatetime(date) {
  return new Date(date).toLocaleString('en-GB', { timeZone: TZ });
}

/**
 * Returns { start, end, label } for the given period string.
 * All dates are UTC Date objects for MongoDB queries.
 *
 * @param {'today'|'week'|'month'} period
 * @param {Date} [customStart]
 * @param {Date} [customEnd]
 */
function getDateRange(period, customStart, customEnd) {
  const now = new Date();

  if (period === 'custom' && customStart && customEnd) {
    // Extend end to 23:59:59 UTC of end day
    const end = new Date(customEnd);
    end.setUTCHours(23, 59, 59, 999);
    return {
      start: customStart,
      end,
      label: `${toMmtDate(customStart)} – ${toMmtDate(end)}`,
    };
  }

  if (period === 'today') {
    // "Today" in MMT: midnight MMT → now
    // MMT = UTC+6:30 → offset = 6.5h
    const mmtNow = new Date(now.getTime() + 6.5 * 3600_000);
    const mmtMidnightStr = mmtNow.toISOString().split('T')[0] + 'T00:00:00.000Z';
    const start = new Date(new Date(mmtMidnightStr).getTime() - 6.5 * 3600_000);
    return { start, end: now, label: `Today (${toMmtDate(now)} MMT)` };
  }

  if (period === 'week') {
    const start = new Date(now.getTime() - 7 * 86_400_000);
    return { start, end: now, label: `Last 7 Days (${toMmtDate(start)} – ${toMmtDate(now)} MMT)` };
  }

  // Default: month (last 30 days)
  const start = new Date(now.getTime() - 30 * 86_400_000);
  return { start, end: now, label: `Last 30 Days (${toMmtDate(start)} – ${toMmtDate(now)} MMT)` };
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

function esc(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function row(...cols) {
  return cols.map(esc).join(',');
}

function section(title) {
  return [``, `${title}`, row('────────────────────')];
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

async function orderStats(match) {
  const results = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$status',
        count:  { $sum: 1 },
        amount: { $sum: '$amount' },
      },
    },
  ]);
  const map = {};
  for (const r of results) map[r._id] = r;
  return map;
}

async function discountStats(match) {
  const [r] = await Order.aggregate([
    { $match: { ...match, status: 'Completed' } },
    {
      $group: {
        _id: null,
        grossOrderValue:  { $sum: { $ifNull: ['$originalAmount', '$amount'] } },
        totalPaid:        { $sum: '$amount' },
        totalTierDisc:    { $sum: { $ifNull: ['$tierDiscount', 0] } },
        totalPromoDisc:   { $sum: { $ifNull: ['$promoDiscount', 0] } },
        ordersWithPromo:  { $sum: { $cond: [{ $gt: ['$promoDiscount', 0] }, 1, 0] } },
        ordersWithTier:   { $sum: { $cond: [{ $gt: ['$tierDiscount', 0] }, 1, 0] } },
      },
    },
  ]);
  return r || {};
}

async function topProducts(match, limit = 10) {
  return Order.aggregate([
    { $match: { ...match, status: 'Completed' } },
    { $group: { _id: '$productId', revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
    { $limit: limit },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        name:    { $ifNull: ['$product.name', 'Unknown'] },
        revenue: 1,
        count:   1,
      },
    },
  ]);
}

async function topCustomers(match, limit = 10) {
  return Order.aggregate([
    { $match: { ...match, status: 'Completed' } },
    { $group: { _id: '$userId', spent: { $sum: '$amount' }, orders: { $sum: 1 } } },
    { $sort: { spent: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        username:   { $ifNull: ['$user.username', '—'] },
        telegramId: { $ifNull: ['$user.telegramId', '—'] },
        tier:       { $ifNull: ['$user.membershipTier', '—'] },
        spent:      1,
        orders:     1,
      },
    },
  ]);
}

async function paymentMethods(match) {
  return Transaction.aggregate([
    { $match: { ...match, type: 'Topup', status: 'Completed' } },
    { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
}

async function topupStats(match) {
  const [r] = await Transaction.aggregate([
    { $match: { ...match, type: 'Topup', status: 'Completed' } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return r || { total: 0, count: 0 };
}

async function refundStats(match) {
  const [r] = await Transaction.aggregate([
    { $match: { ...match, type: 'Refund' } },
    { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
  ]);
  return r || { total: 0, count: 0 };
}

async function dailyTrend(dateMatch) {
  const [orders, topups] = await Promise.all([
    Order.aggregate([
      { $match: { ...dateMatch, status: 'Completed' } },
      {
        $group: {
          _id:     { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: TZ } },
          revenue: { $sum: '$amount' },
          orders:  { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...dateMatch, type: 'Topup', status: 'Completed' } },
      {
        $group: {
          _id:    { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: TZ } },
          amount: { $sum: '$amount' },
          count:  { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // Merge by date
  const map = {};
  for (const o of orders) map[o._id] = { date: o._id, revenue: o.revenue, orders: o.orders, topups: 0, topupCount: 0 };
  for (const t of topups) {
    if (!map[t._id]) map[t._id] = { date: t._id, revenue: 0, orders: 0, topups: 0, topupCount: 0 };
    map[t._id].topups     = t.amount;
    map[t._id].topupCount = t.count;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Main report generator ────────────────────────────────────────────────────

async function generateReport(start, end) {
  const dateMatch = { timestamp: { $gte: start, $lte: end } };
  const orderDateMatch = { ...dateMatch };

  const [
    byStatus,
    discounts,
    products,
    customers,
    pmethods,
    topup,
    refund,
    trend,
    newUsers,
  ] = await Promise.all([
    orderStats(orderDateMatch),
    discountStats(orderDateMatch),
    topProducts(orderDateMatch),
    topCustomers(orderDateMatch),
    paymentMethods(dateMatch),
    topupStats(dateMatch),
    refundStats(dateMatch),
    dailyTrend(dateMatch),
    User.countDocuments({ createdAt: { $gte: start, $lte: end } }),
  ]);

  const completed  = byStatus['Completed']  || { count: 0, amount: 0 };
  const cancelled  = byStatus['Cancelled']  || { count: 0, amount: 0 };
  const pending    = byStatus['Pending']    || { count: 0, amount: 0 };
  const totalOrders = completed.count + cancelled.count + pending.count;

  const netRevenue = completed.amount - refund.total;

  return {
    meta: { generatedAt: new Date(), start, end },
    summary: {
      grossRevenue: completed.amount,
      refunded:     refund.total,
      refundCount:  refund.count,
      netRevenue,
      topupsCollected: topup.total,
      topupCount:      topup.count,
    },
    orders: {
      total:     totalOrders,
      completed: completed.count,
      completedAmount: completed.amount,
      cancelled: cancelled.count,
      cancelledAmount: cancelled.amount,
      pending:   pending.count,
    },
    discounts: {
      grossOrderValue: discounts.grossOrderValue || 0,
      totalTierDisc:   discounts.totalTierDisc   || 0,
      totalPromoDisc:  discounts.totalPromoDisc  || 0,
      ordersWithPromo: discounts.ordersWithPromo || 0,
      ordersWithTier:  discounts.ordersWithTier  || 0,
    },
    products,
    customers,
    pmethods,
    trend,
    newUsers,
  };
}

// ── CSV builder ───────────────────────────────────────────────────────────────

function buildCSV(report, periodLabel) {
  const { meta, summary, orders, discounts, products, customers, pmethods, trend, newUsers } = report;
  const fmt = (n) => Math.round(n).toLocaleString();
  const lines = [];

  // Header
  lines.push(row('Mental Gaming Store — Financial Report'));
  lines.push(row('Period', periodLabel));
  lines.push(row('Generated', toMmtDatetime(meta.generatedAt) + ' MMT'));
  lines.push(row('From', toMmtDatetime(meta.start) + ' MMT'));
  lines.push(row('To',   toMmtDatetime(meta.end)   + ' MMT'));

  // ── Revenue Summary ─────────────────────────────────────────────────────
  lines.push(...section('REVENUE SUMMARY'));
  lines.push(row('Metric', 'Amount (KS)', 'Count'));
  lines.push(row('Gross Revenue (Completed Orders)', fmt(summary.grossRevenue), orders.completed));
  lines.push(row('Total Refunds', fmt(summary.refunded), summary.refundCount));
  lines.push(row('Net Revenue', fmt(summary.netRevenue), ''));
  lines.push(row('Top-ups Collected', fmt(summary.topupsCollected), summary.topupCount));
  lines.push(row('New Users', '', newUsers));

  // ── Orders Breakdown ─────────────────────────────────────────────────────
  lines.push(...section('ORDERS BREAKDOWN'));
  lines.push(row('Status', 'Count', 'Amount (KS)'));
  lines.push(row('Completed', orders.completed, fmt(orders.completedAmount)));
  lines.push(row('Cancelled / Refunded', orders.cancelled, fmt(orders.cancelledAmount)));
  lines.push(row('Pending', orders.pending, '—'));
  lines.push(row('TOTAL', orders.total, fmt(orders.completedAmount + orders.cancelledAmount)));

  // ── Discounts ────────────────────────────────────────────────────────────
  lines.push(...section('DISCOUNT ANALYSIS'));
  lines.push(row('Metric', 'Amount (KS)', 'Orders'));
  lines.push(row('Gross Order Value (pre-discount)', fmt(discounts.grossOrderValue), ''));
  lines.push(row('Tier Discounts Applied', fmt(discounts.totalTierDisc), discounts.ordersWithTier));
  lines.push(row('Promo Discounts Applied', fmt(discounts.totalPromoDisc), discounts.ordersWithPromo));
  lines.push(row('Total Discounts', fmt(discounts.totalTierDisc + discounts.totalPromoDisc), ''));

  // ── Top Products ─────────────────────────────────────────────────────────
  lines.push(...section('TOP PRODUCTS BY REVENUE'));
  lines.push(row('Rank', 'Product Name', 'Orders', 'Revenue (KS)'));
  products.forEach((p, i) => {
    lines.push(row(i + 1, p.name, p.count, fmt(p.revenue)));
  });

  // ── Top Customers ────────────────────────────────────────────────────────
  lines.push(...section('TOP CUSTOMERS BY SPENDING'));
  lines.push(row('Rank', 'Username', 'Telegram ID', 'Tier', 'Orders', 'Total Spent (KS)'));
  customers.forEach((c, i) => {
    lines.push(row(i + 1, c.username, c.telegramId, c.tier, c.orders, fmt(c.spent)));
  });

  // ── Payment Methods ───────────────────────────────────────────────────────
  lines.push(...section('PAYMENT METHODS (TOP-UPS)'));
  lines.push(row('Method', 'Transactions', 'Total Collected (KS)'));
  for (const pm of pmethods) {
    lines.push(row(pm._id || 'Unknown', pm.count, fmt(pm.total)));
  }

  // ── Daily Trend ───────────────────────────────────────────────────────────
  lines.push(...section('DAILY REVENUE TREND'));
  lines.push(row('Date (MMT)', 'Orders Completed', 'Order Revenue (KS)', 'Top-ups', 'Topup Amount (KS)'));
  for (const d of trend) {
    lines.push(row(d.date, d.orders, fmt(d.revenue), d.topupCount, fmt(d.topups)));
  }

  lines.push('');
  lines.push(row('--- End of Report ---'));

  return lines.join('\r\n');
}

// ── Inline text summary ───────────────────────────────────────────────────────

function buildSummaryText(report, periodLabel) {
  const { summary, orders, discounts, products, pmethods, newUsers } = report;
  const fmt = (n) => Math.round(n).toLocaleString();

  const topProductLines = products.slice(0, 5).map((p, i) =>
    `  ${i + 1}. *${p.name}* — ${p.count} orders — ${fmt(p.revenue)} KS`
  );

  const topMethodLines = pmethods.slice(0, 4).map((pm) =>
    `  • ${pm._id || 'Unknown'}: ${pm.count}× — ${fmt(pm.total)} KS`
  );

  return (
    `📊 *Financial Report*\n` +
    `📅 _${periodLabel}_\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `💰 *Revenue Summary*\n` +
    `  Gross Revenue: *${fmt(summary.grossRevenue)} KS*\n` +
    `  Total Refunded: −${fmt(summary.refunded)} KS (${summary.refundCount}×)\n` +
    `  Net Revenue: *${fmt(summary.netRevenue)} KS*\n` +
    `  Top-ups Collected: *${fmt(summary.topupsCollected)} KS* (${summary.topupCount}×)\n` +
    `\`──────────────────────\`\n` +
    `📦 *Orders* (${orders.total} total)\n` +
    `  ✅ Completed: ${orders.completed} — *${fmt(orders.completedAmount)} KS*\n` +
    `  ❌ Cancelled: ${orders.cancelled} — ${fmt(orders.cancelledAmount)} KS refunded\n` +
    `  🟡 Pending: ${orders.pending}\n` +
    `\`──────────────────────\`\n` +
    `🏷 *Discounts Applied*\n` +
    `  Tier Discounts: −${fmt(discounts.totalTierDisc)} KS (${discounts.ordersWithTier} orders)\n` +
    `  Promo Discounts: −${fmt(discounts.totalPromoDisc)} KS (${discounts.ordersWithPromo} orders)\n` +
    `\`──────────────────────\`\n` +
    (topProductLines.length
      ? `🏆 *Top Products*\n${topProductLines.join('\n')}\n\`──────────────────────\`\n`
      : '') +
    (topMethodLines.length
      ? `💳 *Payment Methods*\n${topMethodLines.join('\n')}\n\`──────────────────────\`\n`
      : '') +
    `👥 New Users: *${newUsers}*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `_📎 Full CSV report attached below._`
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

async function exportReport(period, customStart = null, customEnd = null) {
  const { start, end, label } = getDateRange(period, customStart, customEnd);
  const report  = await generateReport(start, end);
  const csv     = buildCSV(report, label);
  const summary = buildSummaryText(report, label);
  return { csv, summary, label };
}

module.exports = { exportReport, getDateRange };
