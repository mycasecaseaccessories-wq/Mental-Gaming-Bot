import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { logger } from "../lib/logger";
import { adminProductServiceAuth } from "../middlewares/adminProductServiceAuth";

type Row = {
  _id: ObjectId; userId?: ObjectId; timestamp?: Date; createdAt?: Date; joinDate?: Date;
  status?: string; type?: string; amount?: number; totalKS?: number; txId?: string;
  paymentMethod?: string; note?: string; screenshotUrl?: string;
  telegramId?: number; username?: string | null; first_name?: string | null; firstName?: string | null;
  balanceKS?: number; balanceCoin?: number; totalDeposited?: number; membershipTier?: string;
  isBlocked?: boolean; shortId?: string; productName?: string | null; productType?: string | null;
};
const router = Router();
const pageOf = (v: unknown) => { const n = Number(v ?? 1); return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100000) : 1; };
const userLabel = (u?: Row) => u ? ({ id: u._id.toString(), name: u.first_name ?? u.firstName ?? u.username ?? "User", username: u.username ?? null, telegramId: u.telegramId }) : null;

router.get("/summary", adminProductServiceAuth, async (_req, res) => {
  try {
    const orders = await getCollection<Row>("orders");
    const txs = await getCollection<Row>("transactions");
    const users = await getCollection<Row>("users");
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const [pendingOrders, processingOrders, pendingTopups, ordersToday, sales, totalUsers, wallets] = await Promise.all([
      orders.countDocuments({ status: "Pending" }), orders.countDocuments({ status: "Processing" }),
      txs.countDocuments({ type: "Topup", status: "Pending" }), orders.countDocuments({ timestamp: { $gte: day } }),
      orders.aggregate([{ $match: { timestamp: { $gte: day }, status: "Success" } }, { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", "$totalKS"] } } } }]).toArray(),
      users.countDocuments({}), users.aggregate([{ $group: { _id: null, balanceKS: { $sum: "$balanceKS" }, balanceCoin: { $sum: "$balanceCoin" } } }]).toArray(),
    ]);
    const w = (wallets[0] as { balanceKS?: number; balanceCoin?: number } | undefined) ?? {};
    res.setHeader("Cache-Control", "no-store").json({ pendingOrders, processingOrders, pendingTopups, ordersToday, salesToday: (sales[0] as { total?: number } | undefined)?.total ?? 0, totalUsers, walletKS: w.balanceKS ?? 0, walletCoin: w.balanceCoin ?? 0, generatedAt: new Date().toISOString() });
  } catch (err) { logger.error({ err }, "admin portal summary read error"); res.status(500).json({ error: "Could not load summary" }); }
});

router.get("/orders", adminProductServiceAuth, async (req, res) => {
  try {
    const page = pageOf(req.query["page"]), limit = 20, status = String(req.query["status"] ?? "Pending");
    if (!["Pending", "Processing", "Success", "Cancelled", "Refunded", "all"].includes(status)) { res.status(400).json({ error: "Invalid status" }); return; }
    const filter = status === "all" ? {} : { status };
    const orders = await getCollection<Row>("orders"), users = await getCollection<Row>("users");
    const [docs, total] = await Promise.all([orders.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).toArray(), orders.countDocuments(filter)]);
    const ids = [...new Set(docs.map((d) => d.userId?.toString()).filter((id): id is string => !!id))].map((id) => new ObjectId(id));
    const userDocs = ids.length ? await users.find({ _id: { $in: ids } } as never).toArray() : [];
    const map = new Map(userDocs.map((u) => [u._id.toString(), u]));
    const items = docs.map((o) => ({ id: o._id.toString(), shortId: o.shortId ?? null, status: o.status, productName: o.productName ?? null, productType: o.productType ?? null, amountKS: o.amount ?? o.totalKS ?? 0, timestamp: o.timestamp, user: userLabel(o.userId ? map.get(o.userId.toString()) : undefined) }));
    res.setHeader("Cache-Control", "no-store").json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { logger.error({ err }, "admin portal orders read error"); res.status(500).json({ error: "Could not load orders" }); }
});

router.get("/users", adminProductServiceAuth, async (req, res) => {
  try {
    const page = pageOf(req.query["page"]), limit = 20, q = String(req.query["q"] ?? "").trim().slice(0, 80);
    const clauses: Record<string, unknown>[] = [];
    if (q) {
      const escaped = [...q].map((char) => ".*+?^${}()|[]\\\\".includes(char) ? "\\" + char : char).join("");
      const or: Record<string, unknown>[] = [{ username: { $regex: escaped, $options: "i" } }, { first_name: { $regex: escaped, $options: "i" } }, { firstName: { $regex: escaped, $options: "i" } }];
      if (q !== "" && Number.isSafeInteger(Number(q))) or.push({ telegramId: Number(q) });
      clauses.push({ $or: or });
    }
    const filter = clauses.length ? { $and: clauses } : {};
    const users = await getCollection<Row>("users");
    const [docs, total] = await Promise.all([users.find(filter as never).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(), users.countDocuments(filter as never)]);
    const items = docs.map((u) => ({ id: u._id.toString(), telegramId: u.telegramId, name: u.first_name ?? u.firstName ?? u.username ?? "User", username: u.username ?? null, balanceKS: u.balanceKS ?? 0, balanceCoin: u.balanceCoin ?? 0, totalDeposited: u.totalDeposited ?? 0, tier: u.membershipTier ?? "Silver", isBlocked: !!u.isBlocked, joinedAt: u.createdAt ?? u.joinDate ?? null }));
    res.setHeader("Cache-Control", "no-store").json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { logger.error({ err }, "admin portal users read error"); res.status(500).json({ error: "Could not load customers" }); }
});

router.get("/transactions", adminProductServiceAuth, async (req, res) => {
  try {
    const page = pageOf(req.query["page"]), limit = 20, type = String(req.query["type"] ?? "all"), status = String(req.query["status"] ?? "all");
    if (!["Topup", "Refund", "AdminCredit", "AdminDebit", "all"].includes(type) || !["Pending", "Completed", "Rejected", "all"].includes(status)) { res.status(400).json({ error: "Invalid transaction filter" }); return; }
    const filter: Record<string, unknown> = {}; if (type !== "all") filter.type = type; if (status !== "all") filter.status = status;
    const txs = await getCollection<Row>("transactions"), users = await getCollection<Row>("users");
    const [docs, total] = await Promise.all([txs.find(filter as never).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).toArray(), txs.countDocuments(filter as never)]);
    const ids = [...new Set(docs.map((d) => d.userId?.toString()).filter((id): id is string => !!id))].map((id) => new ObjectId(id));
    const userDocs = ids.length ? await users.find({ _id: { $in: ids } } as never).toArray() : [];
    const map = new Map(userDocs.map((u) => [u._id.toString(), u]));
    const items = docs.map((t) => ({ id: t._id.toString(), txId: t.txId ?? null, type: t.type, amount: t.amount, status: t.status, paymentMethod: t.paymentMethod ?? null, note: t.note ?? null, timestamp: t.timestamp, user: userLabel(t.userId ? map.get(t.userId.toString()) : undefined) }));
    res.setHeader("Cache-Control", "no-store").json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { logger.error({ err }, "admin portal transactions read error"); res.status(500).json({ error: "Could not load transactions" }); }
});

router.get("/topups", adminProductServiceAuth, async (req, res) => {
  try {
    const page = pageOf(req.query["page"]), limit = 20, filter = { type: "Topup", status: "Pending" };
    const txs = await getCollection<Row>("transactions"), users = await getCollection<Row>("users");
    const [docs, total] = await Promise.all([txs.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).toArray(), txs.countDocuments(filter)]);
    const ids = [...new Set(docs.map((d) => d.userId?.toString()).filter((id): id is string => !!id))].map((id) => new ObjectId(id));
    const userDocs = ids.length ? await users.find({ _id: { $in: ids } } as never).toArray() : [];
    const map = new Map(userDocs.map((u) => [u._id.toString(), u]));
    const items = docs.map((t) => ({ id: t._id.toString(), txId: t.txId ?? null, amount: t.amount, paymentMethod: t.paymentMethod ?? null, screenshotUrl: t.screenshotUrl ?? null, timestamp: t.timestamp, user: userLabel(t.userId ? map.get(t.userId.toString()) : undefined) }));
    res.setHeader("Cache-Control", "no-store").json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { logger.error({ err }, "admin portal topups read error"); res.status(500).json({ error: "Could not load pending top-ups" }); }
});

export default router;
