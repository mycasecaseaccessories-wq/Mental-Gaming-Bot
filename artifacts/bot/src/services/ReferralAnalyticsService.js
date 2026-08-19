const Referral = require('../models/Referral');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const FraudFlag = require('../models/FraudFlag');

function periodStart(days = 30) {
  const safeDays = Math.min(3650, Math.max(1, Number(days) || 30));
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
}

async function getReferralReport({ days = 30, tag = null } = {}) {
  const since = periodStart(days);
  const userMatch = {
    joinSource: 'referral',
    createdAt: { $gte: since },
    ...(tag ? { joinTag: String(tag).trim().toLowerCase() } : {}),
  };
  const [joinedUsers, referrals, tagBreakdown, unresolvedFraud] = await Promise.all([
    User.find(userMatch).select('_id joinTag').lean(),
    Referral.find({ createdAt: { $gte: since } }).select('refereeId status isFraudSuspected commissionHistory').lean(),
    User.aggregate([
      { $match: userMatch },
      { $group: { _id: { $ifNull: ['$joinTag', '(untagged)'] }, users: { $sum: 1 } } },
      { $sort: { users: -1 } },
    ]),
    FraudFlag.countDocuments({ resolved: false, createdAt: { $gte: since } }),
  ]);

  const refereeIds = referrals.map((r) => r.refereeId).filter(Boolean);
  const [topupSummary, commissionSummary] = await Promise.all([
    refereeIds.length
      ? Transaction.aggregate([
          { $match: { userId: { $in: refereeIds }, type: 'Topup', status: 'Completed', timestamp: { $gte: since } } },
          { $group: { _id: null, amountKS: { $sum: '$amount' }, topups: { $sum: 1 } } },
        ])
      : [],
    Referral.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $unwind: '$commissionHistory' },
      { $match: { 'commissionHistory.paidAt': { $gte: since } } },
      { $group: {
        _id: null,
        events: { $sum: 1 },
        commissionCoins: { $sum: { $cond: [{ $eq: ['$commissionHistory.reversed', true] }, 0, '$commissionHistory.commissionCoins'] } },
        reversedCoins: { $sum: { $cond: [{ $eq: ['$commissionHistory.reversed', true] }, '$commissionHistory.commissionCoins', 0] } },
      } },
    ]),
  ]);

  const counts = referrals.reduce((acc, referral) => {
    acc.total += 1;
    if (['Active', 'Completed'].includes(referral.status)) acc.completed += 1;
    if (referral.status === 'Pending') acc.pending += 1;
    if (referral.status === 'Frozen' || referral.isFraudSuspected) acc.frozen += 1;
    return acc;
  }, { total: 0, completed: 0, pending: 0, frozen: 0 });
  const topups = topupSummary[0] || { amountKS: 0, topups: 0 };
  const commissions = commissionSummary[0] || { events: 0, commissionCoins: 0, reversedCoins: 0 };

  return {
    days: Number(days) || 30,
    since,
    joined: joinedUsers.length,
    ...counts,
    conversionRate: counts.total ? Math.round((counts.completed / counts.total) * 1000) / 10 : 0,
    topups: topups.topups || 0,
    topupAmountKS: topups.amountKS || 0,
    commissionEvents: commissions.events || 0,
    commissionCoins: commissions.commissionCoins || 0,
    reversedCommissionCoins: commissions.reversedCoins || 0,
    unresolvedFraud,
    byTag: tagBreakdown.map((row) => ({ tag: row._id, users: row.users })),
  };
}

function reportToCsv(report) {
  const rows = [
    ['Metric', 'Value'],
    ['Period days', report.days],
    ['Referral joins', report.joined],
    ['Referral records', report.total],
    ['Completed/active', report.completed],
    ['Pending', report.pending],
    ['Frozen', report.frozen],
    ['Conversion rate %', report.conversionRate],
    ['Referred-user top-ups', report.topups],
    ['Referred-user top-up amount KS', report.topupAmountKS],
    ['Commission events', report.commissionEvents],
    ['Commission coins', report.commissionCoins],
    ['Reversed commission coins', report.reversedCommissionCoins],
    ['Unresolved fraud flags', report.unresolvedFraud],
    ...report.byTag.map((row) => [`Attribution tag: ${row.tag}`, row.users]),
  ];
  return rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

module.exports = { getReferralReport, reportToCsv };

// Export helpers kept pure for unit tests.
module.exports.periodStart = periodStart;
