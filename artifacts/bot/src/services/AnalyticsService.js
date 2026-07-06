/**
 * AnalyticsService — Core business intelligence engine.
 *
 * Aggregates Orders, Transactions, Users, and Products into structured
 * analytics objects consumed by admin commands and the AI insights module.
 *
 * All monetary values are in KS (MMK). Timezone: Asia/Rangoon (UTC+6:30).
 *
 * Time periods: 'today' | 'yesterday' | 'week' | 'month' | 'custom'
 */

const Order       = require('../models/Order');
const Transaction = require('../models/Transaction');
const User        = require('../models/User');
const Product     = require('../models/Product');

const TZ = 'Asia/Rangoon';
const MMT_OFFSET_MS = 6.5 * 3600_000; // UTC+6:30

// ── Date range builder ────────────────────────────────────────────────────────

function toMmtDate(date) {
  return new Date(date).toLocaleDateString('en-GB', { timeZone: TZ });
}

function getDateRange(period, customStart = null, customEnd = null) {
  const now = new Date();

  if (period === 'custom' && customStart && customEnd) {
    const end = new Date(customEnd);
    end.setUTCHours(23, 59, 59, 999);
    return { start: customStart, end, label: `${toMmtDate(customStart)} – ${toMmtDate(end)}` };
  }

  if (period === 'today') {
    const mmtNow      = new Date(now.getTime() + MMT_OFFSET_MS);
    const dateStr     = mmtNow.toISOString().split('T')[0];
    const start       = new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - MMT_OFFSET_MS);
    return { start, end: now, label: `Today (${dateStr} MMT)` };
  }

  if (period === 'yesterday') {
    const mmtYest     = new Date(now.getTime() + MMT_OFFSET_MS - 86_400_000);
    const dateStr     = mmtYest.toISOString().split('T')[0];
    const start       = new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - MMT_OFFSET_MS);
    const end         = new Date(start.getTime() + 86_400_000 - 1);
    return { start, end, label: `Yesterday (${dateStr} MMT)` };
  }

  if (period === 'week') {
    const start = new Date(now.getTime() - 7 * 86_400_000);
    return { start, end: now, label: `Last 7 Days (${toMmtDate(start)} – ${toMmtDate(now)})` };
  }

  // Default: month (last 30 days)
  const start = new Date(now.getTime() - 30 * 86_400_000);
  return { start, end: now, label: `Last 30 Days (${toMmtDate(start)} – ${toMmtDate(now)})` };
}

// ── Revenue & Net Profit ──────────────────────────────────────────────────────
//
// Net Profit is estimated per order using product margin settings:
//   baseProfitKS set → profit = baseProfitKS × quantity
//   profitMode = 'percentage' → profit = amount × profitMargin%
//   otherwise → assume 25% fallback margin

async function getRevenueMetrics(from, to) {
  const dateMatch = { timestamp: { $gte: from, $lte: to } };

  const [orders, refundData, topupData] = await Promise.all([
    Order.find({ ...dateMatch, status: 'Success' })
      .populate('productId', 'baseProfitKS profitMargin profitMode quantity')
      .lean(),
    Transaction.aggregate([
      { $match: { ...dateMatch, type: 'Refund' } },
      { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { ...dateMatch, type: 'Topup', status: 'Completed' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  let grossRevenue     = 0;
  let estimatedCOGS    = 0;
  let promoDiscountSum = 0;
  let tierDiscountSum  = 0;

  for (const order of orders) {
    grossRevenue     += order.amount;
    promoDiscountSum += order.promoDiscount || 0;
    tierDiscountSum  += order.tierDiscount  || 0;

    const p = order.productId;
    if (!p) { estimatedCOGS += order.amount * 0.75; continue; }

    if (p.baseProfitKS) {
      const profit = p.baseProfitKS * (p.quantity || 1);
      estimatedCOGS += Math.max(0, order.amount - profit);
    } else if (p.profitMode === 'percentage' && p.profitMargin > 0) {
      estimatedCOGS += order.amount * (1 - p.profitMargin / 100);
    } else {
      estimatedCOGS += order.amount * 0.75;
    }
  }

  const refunds    = refundData[0] || { total: 0, count: 0 };
  const topups     = topupData[0]  || { total: 0, count: 0 };
  const netRevenue = grossRevenue - refunds.total;
  const netProfit  = netRevenue - estimatedCOGS;

  return {
    grossRevenue,
    estimatedCOGS,
    netRevenue,
    netProfit,
    estimatedMarginPct: grossRevenue > 0 ? Math.round((netProfit / grossRevenue) * 100) : 0,
    refunds:     { total: refunds.total, count: refunds.count },
    topups:      { total: topups.total,  count: topups.count  },
    orderCount:  orders.length,
    discounts:   { promo: promoDiscountSum, tier: tierDiscountSum },
  };
}

// ── Top-selling products ──────────────────────────────────────────────────────

async function getTopProducts(from, to, limit = 10) {
  return Order.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, status: 'Success' } },
    { $group: { _id: '$productId', revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
    { $limit: limit },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        name:     { $ifNull: ['$product.name', 'Unknown'] },
        category: { $ifNull: ['$product.category', '—'] },
        region:   { $ifNull: ['$product.region', '—'] },
        revenue:  1,
        count:    1,
        avgOrder: { $divide: ['$revenue', '$count'] },
      },
    },
  ]);
}

// ── Category breakdown ────────────────────────────────────────────────────────

async function getCategoryBreakdown(from, to) {
  return Order.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, status: 'Success' } },
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id:     { $ifNull: ['$product.category', 'Unknown'] },
        revenue: { $sum: '$amount' },
        count:   { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
  ]);
}

// ── User growth & retention ───────────────────────────────────────────────────

async function getUserGrowthMetrics(from, to) {
  // Period before "from" of equal duration (for % comparison)
  const duration   = to.getTime() - from.getTime();
  const prevFrom   = new Date(from.getTime() - duration);
  const prevTo     = new Date(from.getTime() - 1);

  const [
    newUsers,
    prevNewUsers,
    totalUsers,
    activeUserIds,
    tierBreakdown,
    joinSources,
  ] = await Promise.all([
    User.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    User.countDocuments({ createdAt: { $gte: prevFrom, $lte: prevTo } }),
    User.countDocuments({}),
    // Active = placed at least 1 order in period
    Order.distinct('userId', { timestamp: { $gte: from, $lte: to } }),
    User.aggregate([
      { $group: { _id: '$membershipTier', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    User.aggregate([
      { $group: { _id: '$joinSource', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const activeUsers      = activeUserIds.length;
  const growthRate       = prevNewUsers > 0
    ? Math.round(((newUsers - prevNewUsers) / prevNewUsers) * 100)
    : null;

  // Retention: users who joined before "from" AND placed an order in period
  const existingActiveCount = await Order.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $match: { 'user.createdAt': { $lt: from } } },
    { $group: { _id: '$userId' } },
    { $count: 'total' },
  ]);
  const existingBase     = totalUsers - newUsers;
  const retained         = existingActiveCount[0]?.total || 0;
  const retentionRate    = existingBase > 0 ? Math.round((retained / existingBase) * 100) : null;

  return {
    newUsers,
    prevNewUsers,
    growthRate,
    activeUsers,
    totalUsers,
    retentionRate,
    tierBreakdown,
    joinSources,
  };
}

// ── Order velocity by hour-of-day ─────────────────────────────────────────────

async function getOrderVelocity(from, to) {
  return Order.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, status: 'Success' } },
    {
      $group: {
        _id: {
          $mod: [
            { $add: [{ $hour: { date: '$timestamp', timezone: TZ } }, 1] },
            24,
          ],
        },
        count:   { $sum: 1 },
        revenue: { $sum: '$amount' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

// ── Payment gateway breakdown ─────────────────────────────────────────────────

async function getPaymentGatewayBreakdown(from, to) {
  return Transaction.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, type: 'Topup', status: 'Completed' } },
    {
      $group: {
        _id:       { $ifNull: ['$paymentMethod', 'Unknown'] },
        total:     { $sum: '$amount' },
        count:     { $sum: 1 },
        avgAmount: { $avg: '$amount' },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

// ── Daily trend (for AI forecasting) ─────────────────────────────────────────

async function getDailyTrend(from, to) {
  const [orders, topups] = await Promise.all([
    Order.aggregate([
      { $match: { timestamp: { $gte: from, $lte: to }, status: 'Success' } },
      {
        $group: {
          _id:     { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: TZ } },
          revenue: { $sum: '$amount' },
          count:   { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { timestamp: { $gte: from, $lte: to }, type: 'Topup', status: 'Completed' } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: TZ } },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const map = {};
  for (const o of orders)  map[o._id] = { date: o._id, revenue: o.revenue, orders: o.count, topups: 0, topupCount: 0 };
  for (const t of topups)  {
    if (!map[t._id]) map[t._id] = { date: t._id, revenue: 0, orders: 0, topups: 0, topupCount: 0 };
    map[t._id].topups     = t.total;
    map[t._id].topupCount = t.count;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Peak hour finder ──────────────────────────────────────────────────────────

async function getPeakOrderHours(from, to) {
  const velocity = await getOrderVelocity(from, to);
  if (!velocity.length) return null;
  const peak = velocity.reduce((a, b) => (a.count >= b.count ? a : b));
  return { hour: peak._id, count: peak.count, revenue: peak.revenue };
}

// ── Cancellation analysis ─────────────────────────────────────────────────────

async function getCancellationMetrics(from, to) {
  const [cancelled, total] = await Promise.all([
    Order.countDocuments({ timestamp: { $gte: from, $lte: to }, status: { $in: ['Cancelled', 'Refunded'] } }),
    Order.countDocuments({ timestamp: { $gte: from, $lte: to } }),
  ]);
  return {
    cancelled,
    total,
    rate: total > 0 ? Math.round((cancelled / total) * 100) : 0,
  };
}

// ── Full comprehensive report ─────────────────────────────────────────────────

async function getFullReport(period, customStart = null, customEnd = null) {
  const { start, end, label } = getDateRange(period, customStart, customEnd);

  const [revenue, products, categories, users, gateway, trend, cancellation, peak] = await Promise.all([
    getRevenueMetrics(start, end),
    getTopProducts(start, end, 10),
    getCategoryBreakdown(start, end),
    getUserGrowthMetrics(start, end),
    getPaymentGatewayBreakdown(start, end),
    getDailyTrend(start, end),
    getCancellationMetrics(start, end),
    getPeakOrderHours(start, end),
  ]);

  return {
    meta:         { period, label, from: start, to: end, generatedAt: new Date() },
    revenue,
    products,
    categories,
    users,
    gateway,
    trend,
    cancellation,
    peak,
  };
}

// ── Historical data for AI forecasting (last 90 days daily) ──────────────────

async function getHistoricalTrend(days = 90) {
  const from = new Date(Date.now() - days * 86_400_000);
  const to   = new Date();
  return getDailyTrend(from, to);
}

module.exports = {
  getDateRange,
  getRevenueMetrics,
  getTopProducts,
  getCategoryBreakdown,
  getUserGrowthMetrics,
  getOrderVelocity,
  getPaymentGatewayBreakdown,
  getDailyTrend,
  getPeakOrderHours,
  getCancellationMetrics,
  getFullReport,
  getHistoricalTrend,
};
