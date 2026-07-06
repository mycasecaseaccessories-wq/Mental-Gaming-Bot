import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { telegramAuth } from "../middlewares/telegramAuth";
import { logger } from "../lib/logger";

const router = Router();

// ── Types ────────────────────────────────────────────────────────────────────

interface AdminDoc {
  _id: ObjectId;
  telegramId: number;
  role: string;
  isActive: boolean;
}

interface UserDoc {
  _id: ObjectId;
  telegramId: number;
  username?: string | null;
  first_name?: string | null;
  firstName?: string | null;
  balanceKS: number;
  balanceCoin: number;
  totalDeposited: number;
  membershipTier: "Silver" | "Gold" | "Platinum";
  warningsCount?: number;
  restrictedRights?: string[];
  isBlocked?: boolean;
  createdAt?: Date;
  joinDate?: Date;
}

interface TxDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: string;
  amount: number;
  txId?: string | null;
  status: string;
  paymentMethod?: string | null;
  screenshotUrl?: string | null;
  screenshotHash?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  processedBy?: number | null;
  balanceAfter?: number | null;
  timestamp: Date;
}

interface OrderDoc {
  _id: ObjectId;
  userId: ObjectId;
  status: string;
  productName?: string | null;
  productType?: string | null;
  gameId?: string | null;
  totalKS?: number | null;
  shortId?: string | null;
  trackingMsgId?: number | null;
  statusHistory?: Array<{ status: string; at: Date; byAdminId?: number; note?: string }>;
  timestamp: Date;
}

// ── Admin auth middleware ─────────────────────────────────────────────────────

async function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.tgUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const tid = req.tgUser.id;
  const rawAdminId = process.env["ADMIN_ID"];
  if (rawAdminId && Number(rawAdminId) === tid) {
    return next();
  }
  try {
    const admins = await getCollection<AdminDoc>("admins");
    const rec = await admins.findOne({ telegramId: tid, isActive: true });
    if (rec) return next();
  } catch (err) {
    logger.error({ err }, "adminAuth DB error");
  }
  res.status(403).json({ error: "Forbidden" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const COIN_BONUS_RATE: Record<string, number> = {
  Silver: 0.01,
  Gold: 0.015,
  Platinum: 0.02,
};

function calcTier(totalDeposited: number): "Silver" | "Gold" | "Platinum" {
  if (totalDeposited >= 2_000_000) return "Platinum";
  if (totalDeposited >= 500_000) return "Gold";
  return "Silver";
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /store/admin/me
router.get("/admin/me", telegramAuth, adminAuth, async (req, res) => {
  const tid = req.tgUser!.id;
  const rawAdminId = process.env["ADMIN_ID"];
  if (rawAdminId && Number(rawAdminId) === tid) {
    res.json({ isAdmin: true, role: "Owner" });
    return;
  }
  const admins = await getCollection<AdminDoc>("admins");
  const rec = await admins.findOne({ telegramId: tid, isActive: true });
  res.json({ isAdmin: true, role: rec?.role ?? "Staff" });
});

// GET /store/admin/summary
router.get("/admin/summary", telegramAuth, adminAuth, async (_req, res) => {
  try {
    const orders = await getCollection<OrderDoc>("orders");
    const txs = await getCollection<TxDoc>("transactions");
    const [pendingOrders, processingOrders, pendingTopups] = await Promise.all([
      orders.countDocuments({ status: "Pending" }),
      orders.countDocuments({ status: "Processing" }),
      txs.countDocuments({ type: "Topup", status: "Pending" }),
    ]);
    res.json({ pendingOrders, processingOrders, pendingTopups });
  } catch (err) {
    logger.error({ err }, "admin summary error");
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /store/admin/orders?status=Pending&page=1
router.get("/admin/orders", telegramAuth, adminAuth, async (req, res) => {
  try {
    const status = (req.query["status"] as string) || "Pending";
    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")));
    const limit = 20;
    const skip = (page - 1) * limit;

    const orders = await getCollection<OrderDoc>("orders");
    const users = await getCollection<UserDoc>("users");

    const docs = await orders.find({ status }).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray();

    const userObjIds: ObjectId[] = Array.from(new Set(docs.map((o) => o.userId.toString()))).map(
      (s) => new ObjectId(s),
    );
    const userDocs = await users.find({ _id: { $in: userObjIds } } as never).toArray();
    const userMap = Object.fromEntries(userDocs.map((u) => [u._id.toString(), u]));

    const items = docs.map((o) => {
      const u = userMap[o.userId.toString()];
      return {
        id: o._id.toString(),
        shortId: o.shortId,
        status: o.status,
        productName: o.productName,
        productType: o.productType,
        gameId: o.gameId,
        zoneId: o.zoneId,
        checkoutData: o.checkoutData ?? [],
        totalKS: o.totalKS,
        timestamp: o.timestamp,
        statusHistory: o.statusHistory ?? [],
        user: u
          ? {
              id: u._id.toString(),
              telegramId: u.telegramId,
              name: u.first_name ?? u.firstName ?? u.username ?? "User",
              username: u.username,
              tier: u.membershipTier,
            }
          : null,
      };
    });

    const total = await orders.countDocuments({ status });
    res.json({ items, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error({ err }, "admin orders list error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /store/admin/orders/:id
router.patch("/admin/orders/:id", telegramAuth, adminAuth, async (req, res) => {
  try {
    const id = String(req.params["id"]);
    const { status, note } = req.body as { status: string; note?: string };
    const allowed = ["Processing", "Success", "Cancelled", "Refunded"];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    const orders = await getCollection<OrderDoc>("orders");
    const order = await orders.findOne({ _id: new ObjectId(id) });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const historyEntry = { status, at: new Date(), byAdminId: req.tgUser!.id, note: note ?? "" };
    await orders.updateOne(
      { _id: order._id },
      { $set: { status }, $push: { statusHistory: historyEntry } as never },
    );

    // Restore stock when an order first transitions to a terminal state, to
    // match the bot's OrderService.cancelAndRefund (mini-app data parity). The
    // `!terminal.includes(order.status)` guard prevents double-restoring if an
    // admin re-applies Cancelled/Refunded.
    const terminal = ["Cancelled", "Refunded"];
    if (terminal.includes(status) && !terminal.includes(order.status)) {
      const oExt = order as OrderDoc & { productId?: ObjectId; quantity?: number };
      if (oExt.productId) {
        const products = await getCollection<{ _id: ObjectId; stockCount: number }>("products");
        const prod = await products.findOne({ _id: oExt.productId });
        if (prod && prod.stockCount !== -1) {
          const qty = oExt.quantity && oExt.quantity > 0 ? oExt.quantity : 1;
          await products.updateOne({ _id: oExt.productId }, { $inc: { stockCount: qty } });
        }
      }
    }

    res.json({ ok: true, status });
  } catch (err) {
    logger.error({ err }, "admin order patch error");
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /store/admin/topups
router.get("/admin/topups", telegramAuth, adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")));
    const limit = 20;
    const skip = (page - 1) * limit;

    const txs = await getCollection<TxDoc>("transactions");
    const users = await getCollection<UserDoc>("users");

    const docs = await txs
      .find({ type: "Topup", status: "Pending" })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const userObjIds: ObjectId[] = Array.from(new Set(docs.map((t) => t.userId.toString()))).map(
      (s) => new ObjectId(s),
    );
    const userDocs = await users.find({ _id: { $in: userObjIds } } as never).toArray();
    const userMap = Object.fromEntries(userDocs.map((u) => [u._id.toString(), u]));

    const items = docs.map((t) => {
      const u = userMap[t.userId.toString()];
      return {
        id: t._id.toString(),
        txId: t.txId,
        amount: t.amount,
        amountDisplay: `${Math.round(t.amount).toLocaleString()} Ks`,
        paymentMethod: t.paymentMethod,
        screenshotUrl: t.screenshotUrl,
        timestamp: t.timestamp,
        user: u
          ? {
              id: u._id.toString(),
              telegramId: u.telegramId,
              name: u.first_name ?? u.firstName ?? u.username ?? "User",
              username: u.username,
              tier: u.membershipTier,
              balanceKS: u.balanceKS,
            }
          : null,
      };
    });

    const total = await txs.countDocuments({ type: "Topup", status: "Pending" });
    res.json({ items, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error({ err }, "admin topups list error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /store/admin/topups/:id/approve
router.patch("/admin/topups/:id/approve", telegramAuth, adminAuth, async (req, res) => {
  try {
    const id = String(req.params["id"]);
    const adminTid = req.tgUser!.id;

    const txs = await getCollection<TxDoc>("transactions");
    const users = await getCollection<UserDoc>("users");

    const tx = await txs.findOne({ _id: new ObjectId(id), type: "Topup", status: "Pending" });
    if (!tx) {
      res.status(404).json({ error: "Pending top-up not found" });
      return;
    }

    const originalTxId = tx.txId;
    const dupKey = `${originalTxId}_approved`;
    const dup = await txs.findOne({ txId: dupKey });
    if (dup) {
      res.status(409).json({ error: "Already approved" });
      return;
    }

    const user = await users.findOne({ _id: tx.userId });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const amountKS = tx.amount;
    const rate = COIN_BONUS_RATE[user.membershipTier] ?? COIN_BONUS_RATE["Silver"]!;
    const bonusCoins = Math.floor(amountKS * rate);
    const newBalance = user.balanceKS + amountKS;
    const newCoin = user.balanceCoin + bonusCoins;
    const newTotalDeposited = (user.totalDeposited ?? 0) + amountKS;
    const newTier = calcTier(newTotalDeposited);

    await txs.updateOne(
      { _id: tx._id },
      {
        $set: {
          status: "Completed",
          processedBy: adminTid,
          balanceAfter: newBalance,
          note: "Approved by admin (Mini App)",
          txId: dupKey,
        },
      },
    );

    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          balanceKS: newBalance,
          balanceCoin: newCoin,
          totalDeposited: newTotalDeposited,
          membershipTier: newTier,
        },
      },
    );

    await txs.insertOne({
      _id: new ObjectId(),
      userId: user._id,
      type: "Topup",
      amount: amountKS,
      txId: dupKey,
      status: "Completed",
      paymentMethod: tx.paymentMethod ?? null,
      screenshotUrl: tx.screenshotUrl ?? null,
      screenshotHash: tx.screenshotHash ?? null,
      note: `Top-up approved — ${tx.paymentMethod ?? ""}`,
      processedBy: adminTid,
      balanceAfter: newBalance,
      rejectionReason: null,
      timestamp: new Date(),
    } as never);

    res.json({ ok: true, amountKS, bonusCoins, newTier });
  } catch (err) {
    // Race condition: two concurrent approve requests — treat as already approved
    if ((err as any)?.code === 11000) {
      res.status(409).json({ error: "Already approved" });
      return;
    }
    logger.error({ err }, "admin topup approve error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /store/admin/topups/:id/reject
router.patch("/admin/topups/:id/reject", telegramAuth, adminAuth, async (req, res) => {
  try {
    const id = String(req.params["id"]);
    const { reason } = req.body as { reason?: string };
    const adminTid = req.tgUser!.id;

    const txs = await getCollection<TxDoc>("transactions");
    const tx = await txs.findOne({ _id: new ObjectId(id), type: "Topup", status: "Pending" });
    if (!tx) {
      res.status(404).json({ error: "Pending top-up not found" });
      return;
    }

    await txs.updateOne(
      { _id: tx._id },
      {
        $set: {
          status: "Rejected",
          processedBy: adminTid,
          rejectionReason: reason ?? "Rejected by admin",
          note: `Rejected: ${reason ?? "no reason given"}`,
        },
      },
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin topup reject error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── User management helpers ───────────────────────────────────────────────────

function genTxId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MGS-${date}-${rand}`;
}

async function uniqueTxId(txs: Awaited<ReturnType<typeof getCollection<TxDoc>>>): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const id = genTxId();
    // eslint-disable-next-line no-await-in-loop
    const dup = await txs.findOne({ txId: id });
    if (!dup) return id;
  }
  throw new Error("Could not generate unique txId");
}

async function writeAudit(
  adminId: number,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const logs = await getCollection("auditlogs");
    await logs.insertOne({
      adminId,
      action,
      targetId,
      targetType: "User",
      details,
      timestamp: new Date(),
    } as never);
  } catch (err) {
    logger.error({ err }, "writeAudit failed");
  }
}

function publicUser(u: UserDoc) {
  return {
    id: u._id.toString(),
    telegramId: u.telegramId,
    name: u.first_name ?? u.firstName ?? u.username ?? "User",
    username: u.username ?? null,
    balanceKS: u.balanceKS ?? 0,
    balanceCoin: u.balanceCoin ?? 0,
    totalDeposited: u.totalDeposited ?? 0,
    tier: u.membershipTier,
    warningsCount: u.warningsCount ?? 0,
    restrictedRights: u.restrictedRights ?? [],
    isBlocked: !!u.isBlocked,
    joinDate: u.joinDate ?? u.createdAt ?? null,
  };
}

// GET /store/admin/users?q=&page=  — search + paginate
router.get("/admin/users", telegramAuth, adminAuth, async (req, res) => {
  try {
    const q = String(req.query["q"] ?? "").trim();
    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")));
    const limit = 20;
    const skip = (page - 1) * limit;

    const users = await getCollection<UserDoc>("users");

    let filter: Record<string, unknown> = {};
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const or: Record<string, unknown>[] = [{ username: { $regex: safe, $options: "i" } }];
      const asNumber = parseInt(q, 10);
      if (!isNaN(asNumber)) or.push({ telegramId: asNumber });
      filter = { $or: or };
    }

    const [docs, total] = await Promise.all([
      users.find(filter as never).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      users.countDocuments(filter as never),
    ]);

    res.json({
      items: docs.map(publicUser),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error({ err }, "admin users list error");
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /store/admin/users/:id  — full user info card
router.get("/admin/users/:id", telegramAuth, adminAuth, async (req, res) => {
  try {
    const id = String(req.params["id"]);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const users = await getCollection<UserDoc>("users");
    const orders = await getCollection<OrderDoc>("orders");
    const txs = await getCollection<TxDoc>("transactions");

    const user = await users.findOne({ _id: new ObjectId(id) });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const [orderCount, pendingOrders, spentAgg, pendingTopup] = await Promise.all([
      orders.countDocuments({ userId: user._id }),
      orders.countDocuments({ userId: user._id, status: "Pending" }),
      orders
        .aggregate([
          { $match: { userId: user._id, status: "Success" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
      txs.findOne({ userId: user._id, type: "Topup", status: "Pending" }),
    ]);

    res.json({
      user: publicUser(user),
      orderCount,
      pendingOrders,
      totalSpent: (spentAgg[0] as { total?: number } | undefined)?.total ?? 0,
      hasPendingTopup: !!pendingTopup,
    });
  } catch (err) {
    logger.error({ err }, "admin user info error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /store/admin/users/:id  — { action, amount?, note?, reason? }
// actions: ban | unban | warn | unwarn | adjustBalance
router.patch("/admin/users/:id", telegramAuth, adminAuth, async (req, res) => {
  try {
    const id = String(req.params["id"]);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const adminTid = req.tgUser!.id;
    const body = (req.body ?? {}) as {
      action?: string;
      amount?: number;
      note?: string;
      reason?: string;
    };
    const action = String(body.action ?? "");

    const users = await getCollection<UserDoc>("users");
    const user = await users.findOne({ _id: new ObjectId(id) });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.telegramId === adminTid && (action === "ban" || action === "warn")) {
      res.status(400).json({ error: "Cannot ban or warn yourself" });
      return;
    }

    if (action === "ban") {
      await users.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
      await writeAudit(adminTid, "BAN_USER", String(user.telegramId), {
        reason: body.reason ?? "No reason given",
      });
      res.json({ ok: true, isBlocked: true });
      return;
    }

    if (action === "unban") {
      await users.updateOne(
        { _id: user._id },
        { $set: { isBlocked: false, warningsCount: 0 } },
      );
      await writeAudit(adminTid, "UNBAN_USER", String(user.telegramId), {});
      res.json({ ok: true, isBlocked: false, warningsCount: 0 });
      return;
    }

    if (action === "warn") {
      const newCount = (user.warningsCount ?? 0) + 1;
      const autoBanned = newCount >= 3;
      await users.updateOne(
        { _id: user._id },
        { $set: { warningsCount: newCount, ...(autoBanned ? { isBlocked: true } : {}) } },
      );
      await writeAudit(adminTid, "WARN_USER", String(user.telegramId), {
        reason: body.reason ?? "No reason given",
        warningsCount: newCount,
        autoBanned,
      });
      res.json({ ok: true, warningsCount: newCount, autoBanned });
      return;
    }

    if (action === "unwarn") {
      const newCount = Math.max(0, (user.warningsCount ?? 1) - 1);
      const unblock = newCount < 3 && user.isBlocked;
      await users.updateOne(
        { _id: user._id },
        { $set: { warningsCount: newCount, ...(unblock ? { isBlocked: false } : {}) } },
      );
      await writeAudit(adminTid, "UNWARN_USER", String(user.telegramId), { newCount });
      res.json({ ok: true, warningsCount: newCount });
      return;
    }

    if (action === "adjustBalance") {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        res.status(400).json({ error: "amount must be a non-zero number" });
        return;
      }
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : "Admin adjustment";

      // Atomic balance mutation: for debits, guard balanceKS >= |amount| inside
      // the filter so concurrent adjustments cannot drive the balance negative
      // or lose an update. balanceBefore/After are derived from the returned doc.
      const filter =
        amount < 0
          ? { _id: user._id, balanceKS: { $gte: Math.abs(amount) } }
          : { _id: user._id };
      const updated = await users.findOneAndUpdate(
        filter as never,
        { $inc: { balanceKS: amount } },
        { returnDocument: "after" },
      );
      if (!updated) {
        res.status(400).json({
          error: `Insufficient balance. Need: ${Math.abs(amount)}`,
        });
        return;
      }
      const after = updated.balanceKS;
      const before = after - amount;

      const txs = await getCollection<TxDoc>("transactions");
      const txId = await uniqueTxId(txs);

      await txs.insertOne({
        _id: new ObjectId(),
        userId: user._id,
        type: amount > 0 ? "AdminCredit" : "AdminDebit",
        wallet: "KS",
        amount,
        balanceBefore: before,
        balanceAfter: after,
        txId,
        status: "Completed",
        note,
        timestamp: new Date(),
      } as never);

      await writeAudit(adminTid, amount > 0 ? "ADMIN_CREDIT" : "ADMIN_DEBIT", String(user.telegramId), {
        amount,
        note,
      });

      res.json({ ok: true, balanceKS: after, amount });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    logger.error({ err }, "admin user patch error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Analytics (parity with bot AnalyticsService) ──────────────────────────────

const TZ = "Asia/Rangoon";
const MMT_OFFSET_MS = 6.5 * 3_600_000; // UTC+6:30

interface ProductProfitDoc {
  _id: ObjectId;
  name?: string | null;
  category?: string | null;
  region?: string | null;
  baseProfitKS?: number | null;
  profitMargin?: number | null;
  profitMode?: string | null;
}

function analyticsDateRange(period: string): { start: Date; end: Date; label: string } {
  const now = new Date();
  if (period === "today") {
    const mmtNow = new Date(now.getTime() + MMT_OFFSET_MS);
    const dateStr = mmtNow.toISOString().split("T")[0]!;
    const start = new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - MMT_OFFSET_MS);
    return { start, end: now, label: `Today (${dateStr} MMT)` };
  }
  if (period === "yesterday") {
    const mmtYest = new Date(now.getTime() + MMT_OFFSET_MS - 86_400_000);
    const dateStr = mmtYest.toISOString().split("T")[0]!;
    const start = new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - MMT_OFFSET_MS);
    const end = new Date(start.getTime() + 86_400_000 - 1);
    return { start, end, label: `Yesterday (${dateStr} MMT)` };
  }
  if (period === "week") {
    const start = new Date(now.getTime() - 7 * 86_400_000);
    return { start, end: now, label: "Last 7 Days" };
  }
  const start = new Date(now.getTime() - 30 * 86_400_000);
  return { start, end: now, label: "Last 30 Days" };
}

// GET /store/admin/analytics?period=today|yesterday|week|month
router.get("/admin/analytics", telegramAuth, adminAuth, async (req, res) => {
  try {
    const allowed = new Set(["today", "yesterday", "week", "month"]);
    const period = allowed.has(String(req.query["period"])) ? String(req.query["period"]) : "month";
    const { start, end, label } = analyticsDateRange(period);
    const dateMatch = { timestamp: { $gte: start, $lte: end } };

    const orders = await getCollection<OrderDoc & { amount?: number; productId?: ObjectId; promoDiscount?: number; tierDiscount?: number; quantity?: number }>("orders");
    const txs = await getCollection<TxDoc>("transactions");
    const users = await getCollection<UserDoc>("users");
    const products = await getCollection<ProductProfitDoc>("products");

    const [
      successOrders,
      refundAgg,
      topupAgg,
      topProducts,
      categories,
      gateway,
      trendOrders,
      trendTopups,
      velocity,
      cancelled,
      totalInRange,
      newUsers,
      totalUsers,
      activeUserIds,
      tierBreakdown,
    ] = await Promise.all([
      orders.find({ ...dateMatch, status: "Success" }).project({ amount: 1, productId: 1, promoDiscount: 1, tierDiscount: 1, quantity: 1 }).toArray(),
      txs.aggregate([
        { $match: { ...dateMatch, type: "Refund" } },
        { $group: { _id: null, total: { $sum: { $abs: "$amount" } }, count: { $sum: 1 } } },
      ]).toArray(),
      txs.aggregate([
        { $match: { ...dateMatch, type: "Topup", status: "Completed" } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]).toArray(),
      orders.aggregate([
        { $match: { ...dateMatch, status: "Success" } },
        { $group: { _id: "$productId", revenue: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" } },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            name: { $ifNull: ["$product.name", "Unknown"] },
            category: { $ifNull: ["$product.category", "—"] },
            revenue: 1,
            count: 1,
            avgOrder: { $divide: ["$revenue", "$count"] },
          },
        },
      ]).toArray(),
      orders.aggregate([
        { $match: { ...dateMatch, status: "Success" } },
        { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $ifNull: ["$product.category", "Unknown"] }, revenue: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
      ]).toArray(),
      txs.aggregate([
        { $match: { ...dateMatch, type: "Topup", status: "Completed" } },
        { $group: { _id: { $ifNull: ["$paymentMethod", "Unknown"] }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]).toArray(),
      orders.aggregate([
        { $match: { ...dateMatch, status: "Success" } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: TZ } }, revenue: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      txs.aggregate([
        { $match: { ...dateMatch, type: "Topup", status: "Completed" } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: TZ } }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      orders.aggregate([
        { $match: { ...dateMatch, status: "Success" } },
        { $group: { _id: { $mod: [{ $add: [{ $hour: { date: "$timestamp", timezone: TZ } }, 1] }, 24] }, count: { $sum: 1 }, revenue: { $sum: "$amount" } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]).toArray(),
      orders.countDocuments({ ...dateMatch, status: { $in: ["Cancelled", "Refunded"] } }),
      orders.countDocuments({ ...dateMatch }),
      users.countDocuments({ createdAt: { $gte: start, $lte: end } }),
      users.countDocuments({}),
      orders.distinct("userId", { ...dateMatch }),
      users.aggregate([
        { $group: { _id: "$membershipTier", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
    ]);

    // Profit estimate (mirror bot logic): profit per order via product margin
    const pids = [...new Set(successOrders.map((o) => o.productId?.toString()).filter(Boolean))].map((s) => new ObjectId(s as string));
    const prodDocs = pids.length ? await products.find({ _id: { $in: pids } }).toArray() : [];
    const profitById = new Map(prodDocs.map((p) => [p._id.toString(), p]));

    let grossRevenue = 0;
    let estimatedCOGS = 0;
    let promoDiscountSum = 0;
    let tierDiscountSum = 0;
    for (const o of successOrders) {
      const amt = o.amount ?? 0;
      grossRevenue += amt;
      promoDiscountSum += o.promoDiscount ?? 0;
      tierDiscountSum += o.tierDiscount ?? 0;
      const p = o.productId ? profitById.get(o.productId.toString()) : undefined;
      if (!p) { estimatedCOGS += amt * 0.75; continue; }
      if (p.baseProfitKS) {
        const profit = p.baseProfitKS * (o.quantity || 1);
        estimatedCOGS += Math.max(0, amt - profit);
      } else if (p.profitMode === "percentage" && (p.profitMargin ?? 0) > 0) {
        estimatedCOGS += amt * (1 - (p.profitMargin ?? 0) / 100);
      } else {
        estimatedCOGS += amt * 0.75;
      }
    }

    const refunds = (refundAgg[0] as { total: number; count: number } | undefined) ?? { total: 0, count: 0 };
    const topups = (topupAgg[0] as { total: number; count: number } | undefined) ?? { total: 0, count: 0 };
    const netRevenue = grossRevenue - refunds.total;
    const netProfit = netRevenue - estimatedCOGS;

    // Merge daily trend
    const trendMap = new Map<string, { date: string; revenue: number; orders: number; topups: number }>();
    for (const o of trendOrders as Array<{ _id: string; revenue: number; count: number }>) {
      trendMap.set(o._id, { date: o._id, revenue: o.revenue, orders: o.count, topups: 0 });
    }
    for (const t of trendTopups as Array<{ _id: string; total: number }>) {
      const cur = trendMap.get(t._id) ?? { date: t._id, revenue: 0, orders: 0, topups: 0 };
      cur.topups = t.total;
      trendMap.set(t._id, cur);
    }
    const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    const peakRow = velocity[0] as { _id: number; count: number; revenue: number } | undefined;

    res.json({
      meta: { period, label, from: start, to: end, generatedAt: new Date() },
      revenue: {
        grossRevenue,
        estimatedCOGS: Math.round(estimatedCOGS),
        netRevenue,
        netProfit: Math.round(netProfit),
        estimatedMarginPct: grossRevenue > 0 ? Math.round((netProfit / grossRevenue) * 100) : 0,
        refunds,
        topups,
        orderCount: successOrders.length,
        discounts: { promo: promoDiscountSum, tier: tierDiscountSum },
      },
      products: topProducts,
      categories: categories.map((c) => ({ category: c["_id"], revenue: c["revenue"], count: c["count"] })),
      users: {
        newUsers,
        totalUsers,
        activeUsers: activeUserIds.length,
        tierBreakdown: tierBreakdown.map((t) => ({ tier: t["_id"] ?? "Unknown", count: t["count"] })),
      },
      gateway: gateway.map((g) => ({ method: g["_id"], total: g["total"], count: g["count"] })),
      trend,
      cancellation: { cancelled, total: totalInRange, rate: totalInRange > 0 ? Math.round((cancelled / totalInRange) * 100) : 0 },
      peak: peakRow ? { hour: peakRow._id, count: peakRow.count, revenue: peakRow.revenue } : null,
    });
  } catch (err) {
    logger.error({ err }, "admin analytics error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Config: Referral Tiers + Spin Rewards ────────────────────────────────────
// Reads/writes the SAME shared singletons the bot uses:
//   • referral tiers  → `systemstatuses` { _id: "global" }.referralTiers
//   • spin rewards    → `gameconfigs`    { _id: "global" } (weights + custom prizes)
// Any edit here is honored live by both the bot and the mini app.

interface ReferralTier {
  minRefs: number;
  rate: number;
  label: string;
  emoji: string;
}

interface SystemStatusConfigDoc {
  _id: string;
  referralTiers?: ReferralTier[];
}

interface CustomSpinPrizeDoc {
  _id?: ObjectId;
  label: string;
  type: "coin" | "ks" | "spin" | "none";
  value?: number;
  weight?: number;
}

interface GameConfigConfigDoc {
  _id: string;
  spinCostCoins?: number;
  spinWeightThanks?: number;
  spinWeightCoins50?: number;
  spinWeightCoins200?: number;
  spinWeightCoins500?: number;
  spinWeightKS1000?: number;
  spinWeightKS5000?: number;
  spinWeightFreeSpin?: number;
  customSpinPrizes?: CustomSpinPrizeDoc[];
}

const DEFAULT_REFERRAL_TIERS: ReferralTier[] = [
  { minRefs: 1, rate: 2, label: "Bronze", emoji: "🥉" },
  { minRefs: 6, rate: 3, label: "Silver", emoji: "🥈" },
  { minRefs: 16, rate: 5, label: "Gold", emoji: "🥇" },
];

// Default weight for each of the seven built-in spin prizes (matches bot).
const SPIN_WEIGHT_DEFAULTS: Record<string, number> = {
  spinWeightThanks: 55,
  spinWeightCoins50: 25,
  spinWeightCoins200: 10,
  spinWeightCoins500: 5,
  spinWeightKS1000: 3,
  spinWeightKS5000: 1,
  spinWeightFreeSpin: 1,
};

const SPIN_PRIZE_TYPES = ["coin", "ks", "spin", "none"] as const;

// GET /store/admin/config — current referral tiers + spin config
router.get("/admin/config", telegramAuth, adminAuth, async (_req, res) => {
  try {
    const statusColl = await getCollection<SystemStatusConfigDoc>("systemstatuses");
    const gameColl = await getCollection<GameConfigConfigDoc>("gameconfigs");
    const [status, game] = await Promise.all([
      statusColl.findOne({ _id: "global" }),
      gameColl.findOne({ _id: "global" }),
    ]);

    const referralTiers =
      Array.isArray(status?.referralTiers) && status.referralTiers.length > 0
        ? status.referralTiers
        : DEFAULT_REFERRAL_TIERS;

    res.json({
      referralTiers: referralTiers.map((t) => ({
        minRefs: t.minRefs,
        rate: t.rate,
        label: t.label,
        emoji: t.emoji ?? "🏅",
      })),
      spin: {
        spinCostCoins:
          typeof game?.spinCostCoins === "number" ? game.spinCostCoins : 50,
        weights: {
          thanks: game?.spinWeightThanks ?? SPIN_WEIGHT_DEFAULTS["spinWeightThanks"],
          coins50: game?.spinWeightCoins50 ?? SPIN_WEIGHT_DEFAULTS["spinWeightCoins50"],
          coins200: game?.spinWeightCoins200 ?? SPIN_WEIGHT_DEFAULTS["spinWeightCoins200"],
          coins500: game?.spinWeightCoins500 ?? SPIN_WEIGHT_DEFAULTS["spinWeightCoins500"],
          ks1000: game?.spinWeightKS1000 ?? SPIN_WEIGHT_DEFAULTS["spinWeightKS1000"],
          ks5000: game?.spinWeightKS5000 ?? SPIN_WEIGHT_DEFAULTS["spinWeightKS5000"],
          freeSpin: game?.spinWeightFreeSpin ?? SPIN_WEIGHT_DEFAULTS["spinWeightFreeSpin"],
        },
        customPrizes: (game?.customSpinPrizes ?? []).map((c) => ({
          id: c._id?.toString() ?? "",
          label: c.label,
          type: c.type,
          value: c.value ?? 0,
          weight: c.weight ?? 0,
        })),
      },
    });
  } catch (err) {
    logger.error({ err }, "admin get config error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /store/admin/config/referral-tiers — { tiers: [{minRefs,rate,label,emoji}] }
router.put("/admin/config/referral-tiers", telegramAuth, adminAuth, async (req, res) => {
  try {
    const body = req.body as { tiers?: unknown };
    if (!Array.isArray(body.tiers) || body.tiers.length === 0) {
      res.status(400).json({ error: "tiers must be a non-empty array" });
      return;
    }
    if (body.tiers.length > 10) {
      res.status(400).json({ error: "Too many tiers (max 10)" });
      return;
    }

    const cleaned: ReferralTier[] = [];
    for (const raw of body.tiers) {
      const t = raw as Record<string, unknown>;
      const minRefs = Math.floor(Number(t["minRefs"]));
      const rate = Number(t["rate"]);
      const label = String(t["label"] ?? "").trim();
      const emoji = String(t["emoji"] ?? "🏅").trim() || "🏅";
      if (!Number.isFinite(minRefs) || minRefs < 0) {
        res.status(400).json({ error: "Each tier needs a valid minRefs (>= 0)" });
        return;
      }
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        res.status(400).json({ error: "Each tier needs a valid rate (0-100)" });
        return;
      }
      if (!label) {
        res.status(400).json({ error: "Each tier needs a label" });
        return;
      }
      cleaned.push({ minRefs, rate, label, emoji });
    }
    cleaned.sort((a, b) => a.minRefs - b.minRefs);

    const statusColl = await getCollection<SystemStatusConfigDoc>("systemstatuses");
    await statusColl.updateOne(
      { _id: "global" },
      { $set: { referralTiers: cleaned } },
      { upsert: true },
    );

    const admin = req.tgUser as { id: number } | undefined;
    await writeAudit(admin?.id ?? 0, "config_referral_tiers", "global", { tiers: cleaned });

    res.json({ ok: true, referralTiers: cleaned });
  } catch (err) {
    logger.error({ err }, "admin put referral-tiers error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /store/admin/config/spin — { spinCostCoins?, weights?:{thanks,coins50,...} }
router.put("/admin/config/spin", telegramAuth, adminAuth, async (req, res) => {
  try {
    const body = req.body as {
      spinCostCoins?: unknown;
      weights?: Record<string, unknown>;
    };

    const update: Partial<GameConfigConfigDoc> = {};

    if (body.spinCostCoins !== undefined) {
      const cost = Math.floor(Number(body.spinCostCoins));
      if (!Number.isFinite(cost) || cost < 0) {
        res.status(400).json({ error: "spinCostCoins must be >= 0" });
        return;
      }
      update.spinCostCoins = cost;
    }

    if (body.weights && typeof body.weights === "object") {
      const map: Record<string, keyof GameConfigConfigDoc> = {
        thanks: "spinWeightThanks",
        coins50: "spinWeightCoins50",
        coins200: "spinWeightCoins200",
        coins500: "spinWeightCoins500",
        ks1000: "spinWeightKS1000",
        ks5000: "spinWeightKS5000",
        freeSpin: "spinWeightFreeSpin",
      };
      for (const [key, field] of Object.entries(map)) {
        const v = body.weights[key];
        if (v === undefined) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          res.status(400).json({ error: `Weight "${key}" must be >= 0` });
          return;
        }
        (update as Record<string, number>)[field] = n;
      }
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const gameColl = await getCollection<GameConfigConfigDoc>("gameconfigs");
    await gameColl.updateOne({ _id: "global" }, { $set: update }, { upsert: true });

    const admin = req.tgUser as { id: number } | undefined;
    await writeAudit(admin?.id ?? 0, "config_spin", "global", update as Record<string, unknown>);

    res.json({ ok: true, updated: update });
  } catch (err) {
    logger.error({ err }, "admin put spin config error");
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /store/admin/config/spin/prizes — add a custom prize
router.post("/admin/config/spin/prizes", telegramAuth, adminAuth, async (req, res) => {
  try {
    const body = req.body as {
      label?: unknown;
      type?: unknown;
      value?: unknown;
      weight?: unknown;
    };
    const label = String(body.label ?? "").trim();
    const type = String(body.type ?? "");
    const value = Math.floor(Number(body.value ?? 0));
    const weight = Number(body.weight ?? 1);

    if (!label) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    if (!SPIN_PRIZE_TYPES.includes(type as (typeof SPIN_PRIZE_TYPES)[number])) {
      res.status(400).json({ error: "type must be coin, ks, spin or none" });
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      res.status(400).json({ error: "value must be >= 0" });
      return;
    }
    if (!Number.isFinite(weight) || weight < 0) {
      res.status(400).json({ error: "weight must be >= 0" });
      return;
    }

    const prize: CustomSpinPrizeDoc = {
      _id: new ObjectId(),
      label,
      type: type as CustomSpinPrizeDoc["type"],
      value,
      weight,
    };

    const gameColl = await getCollection<GameConfigConfigDoc>("gameconfigs");
    await gameColl.updateOne(
      { _id: "global" },
      { $push: { customSpinPrizes: prize } },
      { upsert: true },
    );

    const admin = req.tgUser as { id: number } | undefined;
    await writeAudit(admin?.id ?? 0, "config_spin_prize_add", "global", { prize });

    res.json({
      ok: true,
      prize: {
        id: prize._id?.toString() ?? "",
        label: prize.label,
        type: prize.type,
        value: prize.value,
        weight: prize.weight,
      },
    });
  } catch (err) {
    logger.error({ err }, "admin add spin prize error");
    res.status(500).json({ error: "Internal error" });
  }
});

// DELETE /store/admin/config/spin/prizes/:prizeId — remove a custom prize
router.delete("/admin/config/spin/prizes/:prizeId", telegramAuth, adminAuth, async (req, res) => {
  try {
    const prizeId = String(req.params["prizeId"]);
    if (!ObjectId.isValid(prizeId)) {
      res.status(400).json({ error: "Invalid prize id" });
      return;
    }

    const gameColl = await getCollection<GameConfigConfigDoc>("gameconfigs");
    const result = await gameColl.updateOne(
      { _id: "global" },
      { $pull: { customSpinPrizes: { _id: new ObjectId(prizeId) } } },
    );

    if (result.modifiedCount === 0) {
      res.status(404).json({ error: "Prize not found" });
      return;
    }

    const admin = req.tgUser as { id: number } | undefined;
    await writeAudit(admin?.id ?? 0, "config_spin_prize_remove", "global", { prizeId });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin remove spin prize error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Gateway Control (payment on/off) — mirrors bot /setgateway + /setgatewaynote.
// Reads/writes the SHARED `systemstatuses` { _id: "global" } singleton so the
// bot and mini-app enforce the same gateway availability.
// ═══════════════════════════════════════════════════════════════════════════

type GatewayStatus = "Online" | "Busy" | "Offline";

interface GatewayStatusDoc {
  _id: string;
  kpayStatus?: GatewayStatus;
  waveStatus?: GatewayStatus;
  ayaStatus?: GatewayStatus;
  cbStatus?: GatewayStatus;
  gatewayNote?: string | null;
}

const GATEWAY_STATUSES: GatewayStatus[] = ["Online", "Busy", "Offline"];

// method key → SystemStatus field
const GATEWAY_FIELDS: Record<string, keyof GatewayStatusDoc> = {
  kpay: "kpayStatus",
  wave: "waveStatus",
  aya: "ayaStatus",
  cb: "cbStatus",
};

// GET /store/admin/gateways — current gateway statuses + note
router.get("/admin/gateways", telegramAuth, adminAuth, async (_req, res) => {
  try {
    const statusColl = await getCollection<GatewayStatusDoc>("systemstatuses");
    const doc = await statusColl.findOne({ _id: "global" });
    res.json({
      gateways: {
        kpay: doc?.kpayStatus ?? "Online",
        wave: doc?.waveStatus ?? "Online",
        aya: doc?.ayaStatus ?? "Online",
        cb: doc?.cbStatus ?? "Online",
      },
      note: doc?.gatewayNote ?? null,
    });
  } catch (err) {
    logger.error({ err }, "admin get gateways error");
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /store/admin/gateways — { gateways?: {kpay,wave,aya,cb}, note?: string|null }
router.put("/admin/gateways", telegramAuth, adminAuth, async (req, res) => {
  try {
    const body = req.body as {
      gateways?: Record<string, unknown>;
      note?: unknown;
    };

    const update: Partial<GatewayStatusDoc> = {};

    if (body.gateways && typeof body.gateways === "object") {
      for (const [key, field] of Object.entries(GATEWAY_FIELDS)) {
        const v = body.gateways[key];
        if (v === undefined) continue;
        const status = String(v);
        if (!GATEWAY_STATUSES.includes(status as GatewayStatus)) {
          res.status(400).json({ error: `Invalid status for ${key}` });
          return;
        }
        (update as Record<string, GatewayStatus>)[field] = status as GatewayStatus;
      }
    }

    if (body.note !== undefined) {
      const note = body.note === null ? null : String(body.note).trim();
      update.gatewayNote = note && note.length > 0 ? note : null;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const statusColl = await getCollection<GatewayStatusDoc>("systemstatuses");
    await statusColl.updateOne({ _id: "global" }, { $set: update }, { upsert: true });

    const admin = req.tgUser as { id: number } | undefined;
    await writeAudit(admin?.id ?? 0, "config_gateways", "global", update as Record<string, unknown>);

    res.json({ ok: true, updated: update });
  } catch (err) {
    logger.error({ err }, "admin put gateways error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Financial Export (CSV) — mirrors bot FinancialExportService. Builds a
// period-based financial report from the SHARED `orders`/`transactions`/`users`
// collections and returns it as a downloadable CSV (UTF-8 with BOM).
// Order revenue uses status "Success"; top-ups use type Topup + status Completed
// (same conventions as GET /admin/analytics).
// ═══════════════════════════════════════════════════════════════════════════

interface OrderExportDoc {
  _id: ObjectId;
  userId: ObjectId;
  productId?: ObjectId;
  productName?: string | null;
  status: string;
  amount?: number;
  originalAmount?: number;
  promoDiscount?: number;
  tierDiscount?: number;
  quantity?: number;
  timestamp: Date;
}

const EXPORT_TZ = "Asia/Rangoon";

function mmtDate(d: Date): string {
  return new Date(d).toLocaleDateString("en-GB", { timeZone: EXPORT_TZ });
}
function mmtDatetime(d: Date): string {
  return new Date(d).toLocaleString("en-GB", { timeZone: EXPORT_TZ });
}

function exportDateRange(
  period: string,
  from?: string,
  to?: string,
): { start: Date; end: Date; label: string } {
  const now = new Date();
  if (period === "custom" && from && to) {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T23:59:59.999Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { start, end, label: `${mmtDate(start)} – ${mmtDate(end)}` };
    }
  }
  if (period === "today") {
    const mmtNow = new Date(now.getTime() + 6.5 * 3600_000);
    const midnight = mmtNow.toISOString().split("T")[0] + "T00:00:00.000Z";
    const start = new Date(new Date(midnight).getTime() - 6.5 * 3600_000);
    return { start, end: now, label: `Today (${mmtDate(now)} MMT)` };
  }
  if (period === "week") {
    const start = new Date(now.getTime() - 7 * 86_400_000);
    return { start, end: now, label: `Last 7 Days (${mmtDate(start)} – ${mmtDate(now)} MMT)` };
  }
  const start = new Date(now.getTime() - 30 * 86_400_000);
  return { start, end: now, label: `Last 30 Days (${mmtDate(start)} – ${mmtDate(now)} MMT)` };
}

function csvEsc(val: unknown): string {
  if (val === null || val === undefined) return "";
  let s = String(val);
  // Neutralize spreadsheet formula injection (cells starting with = + - @ tab CR).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}
function csvRow(...cols: unknown[]): string {
  return cols.map(csvEsc).join(",");
}

// GET /store/admin/export?period=today|week|month|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/admin/export", telegramAuth, adminAuth, async (req, res) => {
  try {
    const period = String(req.query["period"] ?? "month");
    const allowed = ["today", "week", "month", "custom"];
    if (!allowed.includes(period)) {
      res.status(400).json({ error: "Invalid period" });
      return;
    }
    const from = req.query["from"] ? String(req.query["from"]) : undefined;
    const to = req.query["to"] ? String(req.query["to"]) : undefined;
    const { start, end, label } = exportDateRange(period, from, to);

    const dateMatch = { timestamp: { $gte: start, $lte: end } };

    const orders = await getCollection<OrderExportDoc>("orders");
    const txs = await getCollection<TxDoc>("transactions");
    const usersColl = await getCollection<UserDoc>("users");
    const productsColl = await getCollection<{ _id: ObjectId; baseProfitKS?: number | null }>(
      "products",
    );

    const [
      byStatus,
      topupAgg,
      refundAgg,
      successOrders,
      topProductsAgg,
      topCustomersAgg,
      pmAgg,
      trendOrders,
      trendTopups,
      newUsers,
    ] = await Promise.all([
      orders
        .aggregate<{ _id: string; count: number; amount: number }>([
          { $match: dateMatch },
          { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
        ])
        .toArray(),
      txs
        .aggregate<{ total: number; count: number }>([
          { $match: { ...dateMatch, type: "Topup", status: "Completed" } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ])
        .toArray(),
      txs
        .aggregate<{ total: number; count: number }>([
          { $match: { ...dateMatch, type: "Refund" } },
          { $group: { _id: null, total: { $sum: { $abs: "$amount" } }, count: { $sum: 1 } } },
        ])
        .toArray(),
      orders
        .find({ ...dateMatch, status: "Success" })
        .project<{
          amount?: number;
          originalAmount?: number;
          promoDiscount?: number;
          tierDiscount?: number;
        }>({ amount: 1, originalAmount: 1, promoDiscount: 1, tierDiscount: 1 })
        .toArray(),
      orders
        .aggregate<{ _id: ObjectId; revenue: number; count: number; name: string }>([
          { $match: { ...dateMatch, status: "Success" } },
          { $group: { _id: "$productId", revenue: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
          { $limit: 10 },
          { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" } },
          { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              name: { $ifNull: ["$product.name", "$productName", "Unknown"] },
              revenue: 1,
              count: 1,
            },
          },
        ])
        .toArray(),
      orders
        .aggregate<{
          spent: number;
          orders: number;
          username: string;
          telegramId: number | string;
          tier: string;
        }>([
          { $match: { ...dateMatch, status: "Success" } },
          { $group: { _id: "$userId", spent: { $sum: "$amount" }, orders: { $sum: 1 } } },
          { $sort: { spent: -1 } },
          { $limit: 10 },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
          { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              username: { $ifNull: ["$user.username", "—"] },
              telegramId: { $ifNull: ["$user.telegramId", "—"] },
              tier: { $ifNull: ["$user.membershipTier", "—"] },
              spent: 1,
              orders: 1,
            },
          },
        ])
        .toArray(),
      txs
        .aggregate<{ _id: string; total: number; count: number }>([
          { $match: { ...dateMatch, type: "Topup", status: "Completed" } },
          { $group: { _id: "$paymentMethod", total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ])
        .toArray(),
      orders
        .aggregate<{ _id: string; revenue: number; orders: number }>([
          { $match: { ...dateMatch, status: "Success" } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: EXPORT_TZ } },
              revenue: { $sum: "$amount" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      txs
        .aggregate<{ _id: string; amount: number; count: number }>([
          { $match: { ...dateMatch, type: "Topup", status: "Completed" } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: EXPORT_TZ } },
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      usersColl.countDocuments({
        $or: [{ createdAt: { $gte: start, $lte: end } }, { joinDate: { $gte: start, $lte: end } }],
      }),
    ]);

    void productsColl;

    const statusMap: Record<string, { count: number; amount: number }> = {};
    for (const r of byStatus) statusMap[r._id] = { count: r.count, amount: r.amount };
    const completed = statusMap["Success"] ?? { count: 0, amount: 0 };
    const cancelled = statusMap["Cancelled"] ?? { count: 0, amount: 0 };
    const refundedStatus = statusMap["Refunded"] ?? { count: 0, amount: 0 };
    const pending = statusMap["Pending"] ?? { count: 0, amount: 0 };
    const processing = statusMap["Processing"] ?? { count: 0, amount: 0 };

    const topup = topupAgg[0] ?? { total: 0, count: 0 };
    const refund = refundAgg[0] ?? { total: 0, count: 0 };

    let grossOrderValue = 0;
    let totalPromoDisc = 0;
    let totalTierDisc = 0;
    let ordersWithPromo = 0;
    let ordersWithTier = 0;
    for (const o of successOrders) {
      grossOrderValue += o.originalAmount ?? o.amount ?? 0;
      totalPromoDisc += o.promoDiscount ?? 0;
      totalTierDisc += o.tierDiscount ?? 0;
      if ((o.promoDiscount ?? 0) > 0) ordersWithPromo += 1;
      if ((o.tierDiscount ?? 0) > 0) ordersWithTier += 1;
    }

    const netRevenue = completed.amount - refund.total;
    const totalOrders =
      completed.count + cancelled.count + refundedStatus.count + pending.count + processing.count;

    const fmt = (n: number) => Math.round(n).toLocaleString();
    const dash = csvRow("--------------------");
    const lines: string[] = [];

    lines.push(csvRow("Mental Gaming Store — Financial Report"));
    lines.push(csvRow("Period", label));
    lines.push(csvRow("Generated", mmtDatetime(new Date()) + " MMT"));
    lines.push(csvRow("From", mmtDatetime(start) + " MMT"));
    lines.push(csvRow("To", mmtDatetime(end) + " MMT"));

    lines.push("", "REVENUE SUMMARY", dash);
    lines.push(csvRow("Metric", "Amount (KS)", "Count"));
    lines.push(csvRow("Gross Revenue (Completed Orders)", fmt(completed.amount), completed.count));
    lines.push(csvRow("Total Refunds", fmt(refund.total), refund.count));
    lines.push(csvRow("Net Revenue", fmt(netRevenue), ""));
    lines.push(csvRow("Top-ups Collected", fmt(topup.total), topup.count));
    lines.push(csvRow("New Users", "", newUsers));

    lines.push("", "ORDERS BREAKDOWN", dash);
    lines.push(csvRow("Status", "Count", "Amount (KS)"));
    lines.push(csvRow("Completed (Success)", completed.count, fmt(completed.amount)));
    lines.push(csvRow("Processing", processing.count, "—"));
    lines.push(csvRow("Cancelled", cancelled.count, fmt(cancelled.amount)));
    lines.push(csvRow("Refunded", refundedStatus.count, fmt(refundedStatus.amount)));
    lines.push(csvRow("Pending", pending.count, "—"));
    lines.push(csvRow("TOTAL", totalOrders, fmt(completed.amount + cancelled.amount + refundedStatus.amount)));

    lines.push("", "DISCOUNT ANALYSIS", dash);
    lines.push(csvRow("Metric", "Amount (KS)", "Orders"));
    lines.push(csvRow("Gross Order Value (pre-discount)", fmt(grossOrderValue), ""));
    lines.push(csvRow("Tier Discounts Applied", fmt(totalTierDisc), ordersWithTier));
    lines.push(csvRow("Promo Discounts Applied", fmt(totalPromoDisc), ordersWithPromo));
    lines.push(csvRow("Total Discounts", fmt(totalTierDisc + totalPromoDisc), ""));

    lines.push("", "TOP PRODUCTS BY REVENUE", dash);
    lines.push(csvRow("Rank", "Product Name", "Orders", "Revenue (KS)"));
    topProductsAgg.forEach((p, i) => lines.push(csvRow(i + 1, p.name, p.count, fmt(p.revenue))));

    lines.push("", "TOP CUSTOMERS BY SPENDING", dash);
    lines.push(csvRow("Rank", "Username", "Telegram ID", "Tier", "Orders", "Total Spent (KS)"));
    topCustomersAgg.forEach((c, i) =>
      lines.push(csvRow(i + 1, c.username, c.telegramId, c.tier, c.orders, fmt(c.spent))),
    );

    lines.push("", "PAYMENT METHODS (TOP-UPS)", dash);
    lines.push(csvRow("Method", "Transactions", "Total Collected (KS)"));
    for (const pm of pmAgg) lines.push(csvRow(pm._id || "Unknown", pm.count, fmt(pm.total)));

    lines.push("", "DAILY REVENUE TREND", dash);
    lines.push(csvRow("Date (MMT)", "Orders Completed", "Order Revenue (KS)", "Top-ups", "Topup Amount (KS)"));
    const trendMap: Record<string, { revenue: number; orders: number; topups: number; topupCount: number }> = {};
    for (const o of trendOrders)
      trendMap[o._id] = { revenue: o.revenue, orders: o.orders, topups: 0, topupCount: 0 };
    for (const t of trendTopups) {
      if (!trendMap[t._id]) trendMap[t._id] = { revenue: 0, orders: 0, topups: 0, topupCount: 0 };
      trendMap[t._id]!.topups = t.amount;
      trendMap[t._id]!.topupCount = t.count;
    }
    Object.keys(trendMap)
      .sort()
      .forEach((d) => {
        const row = trendMap[d]!;
        lines.push(csvRow(d, row.orders, fmt(row.revenue), row.topupCount, fmt(row.topups)));
      });

    lines.push("", csvRow("--- End of Report ---"));

    const csv = "\uFEFF" + lines.join("\r\n");

    const admin = req.tgUser as { id: number } | undefined;
    await writeAudit(admin?.id ?? 0, "financial_export", "global", { period, label });

    const stamp = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const filename = `MGS_Report_${period}_${stamp}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, "admin financial export error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
