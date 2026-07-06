/**
 * Gamification routes — Spin Wheel, Daily Check-In, Referral
 * Replicates bot logic directly against the shared MongoDB.
 */
import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectId } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(telegramAuth);

// ── Shared helpers ────────────────────────────────────────────────────────────

function asUser(req: Request): StoreUser {
  return req.storeUser as StoreUser;
}

function getMSTDate(d = new Date()): string {
  const mst = new Date(d.getTime() + 6.5 * 60 * 60 * 1000);
  return mst.toISOString().slice(0, 10);
}
function getMSTToday() { return getMSTDate(); }
function getMSTYesterday() { return getMSTDate(new Date(Date.now() - 24 * 60 * 60 * 1000)); }

// ── Spin Wheel ────────────────────────────────────────────────────────────────
// Prize pool + weights + cost are read live from the shared `gameconfigs`
// singleton so admin edits (bot OR mini app) take effect immediately. Mirrors
// bot GameService.getEffectivePrizePool().

const SPIN_COST_COINS_DEFAULT = 50;

type PrizeType = "none" | "coin" | "ks" | "spin";
interface Prize {
  id: string;
  label: string;
  type: PrizeType;
  value: number;
  weight: number;
}

const DEFAULT_PRIZE_POOL: Prize[] = [
  { id: "thanks",    label: "🎉 Thank You!",      type: "none", value: 0,    weight: 55 },
  { id: "coins_50",  label: "🪙 50 Mental Coins",  type: "coin", value: 50,   weight: 25 },
  { id: "coins_200", label: "🪙 200 Coins",         type: "coin", value: 200,  weight: 10 },
  { id: "coins_500", label: "🪙 500 Coins",         type: "coin", value: 500,  weight: 5  },
  { id: "ks_1000",   label: "🪙 1,000 Coins",       type: "coin", value: 1000, weight: 3  },
  { id: "ks_5000",   label: "🪙 5,000 Coins",       type: "coin", value: 5000, weight: 1  },
  { id: "free_spin", label: "🎰 Free Spin!",        type: "spin", value: 1,    weight: 1  },
];

// Map default prize id → GameConfig weight field (admin-editable weights).
const SPIN_WEIGHT_FIELDS: Record<string, keyof GameConfigDoc> = {
  thanks:    "spinWeightThanks",
  coins_50:  "spinWeightCoins50",
  coins_200: "spinWeightCoins200",
  coins_500: "spinWeightCoins500",
  ks_1000:   "spinWeightKS1000",
  ks_5000:   "spinWeightKS5000",
  free_spin: "spinWeightFreeSpin",
};

interface CustomSpinPrize {
  _id?: ObjectId;
  label: string;
  type: PrizeType;
  value?: number;
  weight?: number;
}

interface GameConfigDoc {
  _id: string;
  spinCostCoins?: number;
  spinWeightThanks?: number;
  spinWeightCoins50?: number;
  spinWeightCoins200?: number;
  spinWeightCoins500?: number;
  spinWeightKS1000?: number;
  spinWeightKS5000?: number;
  spinWeightFreeSpin?: number;
  customSpinPrizes?: CustomSpinPrize[];
}

// Build effective spin config (cost + weighted pool) from `gameconfigs`.
async function getSpinConfig(): Promise<{ spinCostCoins: number; pool: Prize[] }> {
  const coll = await getCollection<GameConfigDoc>("gameconfigs");
  const cfg = await coll.findOne({ _id: "global" });

  const spinCostCoins =
    typeof cfg?.spinCostCoins === "number" ? cfg.spinCostCoins : SPIN_COST_COINS_DEFAULT;

  const pool: Prize[] = DEFAULT_PRIZE_POOL.map((p) => {
    const field = SPIN_WEIGHT_FIELDS[p.id];
    const w = field ? cfg?.[field] : undefined;
    return { ...p, weight: typeof w === "number" ? w : p.weight };
  });

  for (const c of cfg?.customSpinPrizes ?? []) {
    pool.push({
      id: `custom_${c._id?.toString() ?? ""}`,
      label: c.label,
      type: c.type,
      value: c.value ?? 0,
      weight: c.weight ?? 0,
    });
  }

  return { spinCostCoins, pool };
}

function pickPrize(pool: Prize[]): { prize: Prize; prizeIndex: number } {
  const total = pool.reduce((s, p) => s + p.weight, 0) || 1;
  let rand = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    rand -= pool[i].weight;
    if (rand <= 0) return { prize: pool[i], prizeIndex: i };
  }
  return { prize: pool[0], prizeIndex: 0 };
}

function canFreeSpinToday(lastSpinAt: Date | null): boolean {
  if (!lastSpinAt) return true;
  return getMSTDate(lastSpinAt) !== getMSTToday();
}

function nextFreeSpinMs(lastSpinAt: Date | null): number {
  if (!lastSpinAt || canFreeSpinToday(lastSpinAt)) return 0;
  const next = new Date(lastSpinAt);
  next.setUTCHours(17, 30, 0, 0); // midnight MST = 17:30 UTC
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(0, next.getTime() - Date.now());
}

interface UserDoc {
  _id: ObjectId;
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  first_name?: string | null;
  balanceKS: number;
  balanceCoin: number;
  lastSpinAt?: Date | null;
  checkInStreak?: number;
  longestStreak?: number;
  totalCheckIns?: number;
  lastCheckInDate?: string | null;
  referralCode?: string | null;
  membershipTier?: string;
}

interface TxDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: string;
  wallet: "KS" | "Coin";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  note?: string;
  createdAt?: Date;
  timestamp?: Date;
}

// GET /gamification/spin/status
router.get("/spin/status", async (req: Request, res: Response) => {
  const u = asUser(req);
  const users = await getCollection<UserDoc>("users");
  const dbUser = await users.findOne({ _id: u._id });
  const lastSpin = dbUser?.lastSpinAt ?? null;
  const freeSpin = canFreeSpinToday(lastSpin);
  const { spinCostCoins, pool } = await getSpinConfig();

  res.json({
    canFreeSpin: freeSpin,
    nextFreeSpinMs: freeSpin ? 0 : nextFreeSpinMs(lastSpin),
    coinBalance: u.balanceCoin,
    spinCostCoins,
    prizePool: pool.map((p) => ({ id: p.id, label: p.label, type: p.type, value: p.value })),
  });
});

// POST /gamification/spin
// body: { usePaid?: boolean }
router.post("/spin", async (req: Request, res: Response) => {
  const u = asUser(req);
  const usePaid = !!(req.body as { usePaid?: boolean }).usePaid;

  const users = await getCollection<UserDoc>("users");
  const dbUser = await users.findOne({ _id: u._id });
  if (!dbUser) return res.status(404).json({ error: "User not found" });

  const freeSpin = canFreeSpinToday(dbUser.lastSpinAt ?? null);
  const { spinCostCoins, pool } = await getSpinConfig();

  if (!freeSpin && !usePaid) {
    const ms = nextFreeSpinMs(dbUser.lastSpinAt ?? null);
    return res.status(429).json({ error: "daily_limit", nextFreeSpinMs: ms });
  }

  if (!freeSpin && usePaid) {
    if (dbUser.balanceCoin < spinCostCoins) {
      return res.status(402).json({
        error: "not_enough_coins",
        needed: spinCostCoins,
        balance: dbUser.balanceCoin,
      });
    }
  }

  const txs = await getCollection<TxDoc>("transactions");
  const now = new Date();

  // Deduct coins for paid spin
  if (!freeSpin && usePaid) {
    const debited = await users.findOneAndUpdate(
      { _id: u._id, balanceCoin: { $gte: spinCostCoins } },
      { $inc: { balanceCoin: -spinCostCoins } },
      { returnDocument: "after" }
    );
    if (!debited) return res.status(402).json({ error: "Balance changed, please retry" });
    await txs.insertOne({
      _id: new ObjectId(), userId: u._id, type: "Debit", wallet: "Coin",
      amount: -spinCostCoins, balanceBefore: dbUser.balanceCoin,
      balanceAfter: debited.balanceCoin, status: "Completed",
      note: "Paid spin", createdAt: now, timestamp: now,
    });
  }

  // Mark lastSpinAt before awarding prize (prevents double-spin on crash)
  await users.updateOne({ _id: u._id }, { $set: { lastSpinAt: now } });

  const { prize, prizeIndex } = pickPrize(pool);

  // Award prize
  let newBalanceKS = dbUser.balanceKS;
  let newBalanceCoin = (usePaid ? dbUser.balanceCoin - spinCostCoins : dbUser.balanceCoin);

  if ((prize.type === "coin" || prize.type === "ks") && prize.value > 0) {
    // Policy: all spin rewards are paid in Mental Coins (legacy "ks" prizes included).
    const after = await users.findOneAndUpdate(
      { _id: u._id }, { $inc: { balanceCoin: prize.value } }, { returnDocument: "after" }
    );
    newBalanceCoin = after?.balanceCoin ?? newBalanceCoin;
    await txs.insertOne({
      _id: new ObjectId(), userId: u._id, type: "Bonus", wallet: "Coin",
      amount: prize.value, balanceBefore: dbUser.balanceCoin, balanceAfter: newBalanceCoin,
      status: "Completed", note: `Spin prize: ${prize.label}`, createdAt: now, timestamp: now,
    });
  } else if (prize.type === "spin") {
    // Free spin: reset lastSpinAt so they can spin again immediately
    await users.updateOne({ _id: u._id }, { $set: { lastSpinAt: null } });
  }

  return res.json({
    prize: { id: prize.id, label: prize.label, type: prize.type, value: prize.value },
    prizeIndex,
    usedFreeSpin: freeSpin,
    newBalanceKS,
    newBalanceCoin,
  });
});

// ── Daily Check-In ────────────────────────────────────────────────────────────

const DAILY_REWARDS = [
  { coins: 10,  ks: 0,   label: "Day 1" },
  { coins: 15,  ks: 0,   label: "Day 2" },
  { coins: 25,  ks: 0,   label: "Day 3" },
  { coins: 40,  ks: 0,   label: "Day 4" },
  { coins: 60,  ks: 0,   label: "Day 5" },
  { coins: 90,  ks: 0,   label: "Day 6" },
  { coins: 250, ks: 0,   label: "Day 7 🎉", milestone: true },
];

const MILESTONES = [
  { streak: 14,  coins: 450,  ks: 0, label: "🏅 Two-Week Champion!" },
  { streak: 30,  coins: 1000, ks: 0, label: "🏆 Monthly Legend!" },
  { streak: 100, coins: 2000, ks: 0, label: "💎 Centurion!" },
];

function getDayReward(streakDay: number) {
  return DAILY_REWARDS[(streakDay - 1) % 7];
}

interface CheckInDoc {
  _id: ObjectId;
  userId: ObjectId;
  date: string;
  streakDay: number;
  coinsReward?: number;
  ksReward?: number;
  createdAt?: Date;
}

// GET /gamification/checkin/status
router.get("/checkin/status", async (req: Request, res: Response) => {
  const u = asUser(req);
  const users = await getCollection<UserDoc>("users");
  const checkins = await getCollection<CheckInDoc>("checkins");

  const dbUser = await users.findOne({ _id: u._id });
  const today = getMSTToday();
  const alreadyCheckedIn = !!(await checkins.findOne({ userId: u._id, date: today }));

  const streak = dbUser?.checkInStreak ?? 0;
  const nextReward = getDayReward(streak + 1);
  const milestone = MILESTONES.find((m) => m.streak === streak + 1) ?? null;

  // Last 30 days history for calendar
  const month = today.slice(0, 7);
  const monthCheckins = await checkins
    .find({ userId: u._id, date: { $gte: month + "-01", $lte: month + "-31" } })
    .toArray();
  const checkedDays = monthCheckins.map((c) => Number(c.date.slice(8)));

  res.json({
    canCheckIn: !alreadyCheckedIn,
    alreadyCheckedIn,
    streak,
    longestStreak: dbUser?.longestStreak ?? 0,
    totalCheckIns: dbUser?.totalCheckIns ?? 0,
    nextReward,
    milestoneBonus: milestone,
    checkedDays,
    todayDate: today,
    rewardSchedule: DAILY_REWARDS,
  });
});

// POST /gamification/checkin
router.post("/checkin", async (req: Request, res: Response) => {
  const u = asUser(req);
  const users = await getCollection<UserDoc>("users");
  const checkins = await getCollection<CheckInDoc>("checkins");
  const txs = await getCollection<TxDoc>("transactions");

  const dbUser = await users.findOne({ _id: u._id });
  if (!dbUser) return res.status(404).json({ error: "User not found" });

  const today = getMSTToday();
  const yesterday = getMSTYesterday();
  const existing = await checkins.findOne({ userId: u._id, date: today });
  if (existing) return res.status(409).json({ error: "already_checked_in" });

  const lastDate = dbUser.lastCheckInDate ?? null;
  let newStreak = lastDate === yesterday ? (dbUser.checkInStreak ?? 0) + 1 : 1;
  const reward = getDayReward(newStreak);
  const milestone = MILESTONES.find((m) => m.streak === newStreak) ?? null;

  const now = new Date();
  await checkins.insertOne({
    _id: new ObjectId(), userId: u._id, date: today, streakDay: newStreak,
    coinsReward: reward.coins + (milestone?.coins ?? 0),
    ksReward: reward.ks + (milestone?.ks ?? 0),
    createdAt: now,
  });

  const longestStreak = Math.max(dbUser.longestStreak ?? 0, newStreak);
  await users.updateOne({ _id: u._id }, {
    $set: { checkInStreak: newStreak, lastCheckInDate: today, longestStreak },
    $inc: { totalCheckIns: 1, balanceCoin: reward.coins + (milestone?.coins ?? 0), balanceKS: reward.ks + (milestone?.ks ?? 0) },
  });

  const now2 = new Date();
  if (reward.coins > 0 || milestone?.coins) {
    const totalCoins = reward.coins + (milestone?.coins ?? 0);
    await txs.insertOne({
      _id: new ObjectId(), userId: u._id, type: "Bonus", wallet: "Coin",
      amount: totalCoins, balanceBefore: dbUser.balanceCoin,
      balanceAfter: dbUser.balanceCoin + totalCoins,
      status: "Completed", note: `Daily check-in day ${newStreak}`, createdAt: now2, timestamp: now2,
    });
  }
  if (reward.ks > 0 || milestone?.ks) {
    const totalKS = reward.ks + (milestone?.ks ?? 0);
    await txs.insertOne({
      _id: new ObjectId(), userId: u._id, type: "Bonus", wallet: "KS",
      amount: totalKS, balanceBefore: dbUser.balanceKS,
      balanceAfter: dbUser.balanceKS + totalKS,
      status: "Completed", note: `Daily check-in day ${newStreak}`, createdAt: now2, timestamp: now2,
    });
  }

  return res.json({
    streak: newStreak,
    reward,
    milestone,
    newBalanceCoin: dbUser.balanceCoin + reward.coins + (milestone?.coins ?? 0),
    newBalanceKS: dbUser.balanceKS + reward.ks + (milestone?.ks ?? 0),
  });
});

// ── Referral ──────────────────────────────────────────────────────────────────

const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function buildRefCode(telegramId: number): string {
  const suffix = Array.from({ length: 4 }, () => REF_CHARS[Math.floor(Math.random() * REF_CHARS.length)]).join("");
  return String(telegramId).slice(-3) + suffix;
}

interface ReferralDoc {
  _id: ObjectId;
  referrerId: ObjectId;
  refereeId: ObjectId;
  referralCode: string;
  status: string;
  createdAt?: Date;
}

// GET /gamification/referral
router.get("/referral", async (req: Request, res: Response) => {
  const u = asUser(req);
  const users = await getCollection<UserDoc>("users");
  const referrals = await getCollection<ReferralDoc>("referrals");

  let dbUser = await users.findOne({ _id: u._id });
  if (!dbUser) return res.status(404).json({ error: "User not found" });

  // Create referral code if missing
  if (!dbUser.referralCode) {
    let code: string;
    let attempts = 0;
    do {
      code = buildRefCode(u.telegramId);
      attempts++;
      if (attempts > 20) { logger.error("Could not generate unique referral code"); break; }
    } while (await users.findOne({ referralCode: code }));
    await users.updateOne({ _id: u._id }, { $set: { referralCode: code! } });
    dbUser = await users.findOne({ _id: u._id });
  }

  const code = dbUser?.referralCode ?? "";
  const link = `https://t.me/mentalgamingstorebot?start=ref_${code}`;

  const allRefs = await referrals.find({ referrerId: u._id }).sort({ createdAt: -1 }).limit(20).toArray();
  const completedCount = allRefs.filter((r) => ["Active", "Completed"].includes(r.status)).length;

  // Tier logic — read live from shared `systemstatuses` singleton (admin-editable,
  // honored by both bot and mini-app). Falls back to bot defaults when unset.
  const DEFAULT_TIERS = [
    { minRefs: 1,  rate: 2, label: "Bronze", emoji: "🥉" },
    { minRefs: 6,  rate: 3, label: "Silver", emoji: "🥈" },
    { minRefs: 16, rate: 5, label: "Gold",   emoji: "🥇" },
  ];
  const statusColl = await getCollection<{ _id: string; referralTiers?: typeof DEFAULT_TIERS }>("systemstatuses");
  const statusDoc = await statusColl.findOne({ _id: "global" });
  const TIERS =
    Array.isArray(statusDoc?.referralTiers) && statusDoc.referralTiers.length > 0
      ? statusDoc.referralTiers.map((t) => ({
          minRefs: t.minRefs,
          rate: t.rate,
          label: t.label,
          emoji: t.emoji ?? "🏅",
        }))
      : DEFAULT_TIERS;
  const sorted = [...TIERS].sort((a, b) => b.minRefs - a.minRefs);
  const currentTier = sorted.find((t) => completedCount >= t.minRefs) ?? null;
  const ascending = [...TIERS].sort((a, b) => a.minRefs - b.minRefs);
  const idx = currentTier ? ascending.findIndex((t) => t.minRefs === currentTier.minRefs) : -1;
  const nextTier = idx >= 0 ? ascending[idx + 1] ?? null : ascending[0] ?? null;

  // Fetch referee details for recent referrals
  const refereeIds = allRefs.slice(0, 10).map((r) => r.refereeId);
  const refereeUsers = refereeIds.length
    ? await users.find({ _id: { $in: refereeIds } }, { projection: { telegramId: 1, username: 1, firstName: 1 } }).toArray()
    : [];
  const refereeMap = new Map(refereeUsers.map((u) => [u._id.toString(), u]));

  const recentReferrals = allRefs.slice(0, 10).map((r) => {
    const referee = refereeMap.get(r.refereeId.toString());
    const name = referee?.username || referee?.firstName || "User";
    const masked = name.length <= 2 ? name + "***" : name.slice(0, 2) + "***";
    return { id: r._id.toString(), status: r.status, maskedName: masked, at: r.createdAt ?? null };
  });

  return res.json({
    code,
    link,
    totalReferrals: allRefs.length,
    completedCount,
    currentTier,
    nextTier,
    recentReferrals,
  });
});

export default router;
