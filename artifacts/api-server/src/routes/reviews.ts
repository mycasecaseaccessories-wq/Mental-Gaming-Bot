/**
 * Reviews routes — post-order feedback + public review wall.
 *
 * Shares the SAME `reviews` collection the bot owns (Mongoose model `Review`),
 * so ratings submitted in the mini app and the bot are one dataset.
 *
 * Mirrors the bot's FeedbackService rules:
 *   - one review per order (unique orderId)
 *   - rating 1–5, optional comment (max 500 chars)
 *   - rating >= 4 → isPublic (appears on the public wall)
 *
 * NOTE: The bot forwards 4–5★ reviews with a comment to a Telegram channel.
 * That side effect requires the bot's Telegram instance and stays bot-only; the
 * mini app just persists the review (forwardedToChannel stays false). Data
 * parity (shared reviews) is preserved.
 *
 * Route mounting: the PUBLIC wall (GET /reviews) has no auth, so this router is
 * mounted before storeRouter (see routes/index.ts). Authenticated routes attach
 * telegramAuth per-route rather than router-wide, to avoid 401-ing the wall.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectId, type Filter } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";

interface ReviewDoc {
  _id: ObjectId;
  userId: ObjectId;
  telegramId: number;
  orderId: ObjectId;
  productName: string;
  rating: number | null;
  comment: string | null;
  skipped: boolean;
  isPublic: boolean;
  forwardedToChannel: boolean;
  respondedAt: Date | null;
  feedbackRequestSentAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface OrderLite {
  _id: ObjectId;
  userId: ObjectId;
  productId: ObjectId;
  status: string;
  gameName: string | null;
  timestamp: Date;
}

interface ProductLite {
  _id: ObjectId;
  name: string;
}

interface UserLite {
  _id: ObjectId;
  telegramId: number;
  username?: string | null;
  first_name?: string | null;
}

const router: IRouter = Router();

function safeId(s: string): ObjectId | null {
  return ObjectId.isValid(s) ? new ObjectId(s) : null;
}

function displayName(u: UserLite | null): string {
  if (!u) return "Anonymous";
  if (u.username) return `@${u.username}`;
  return u.first_name || "Anonymous";
}

// ── GET /reviews  (PUBLIC wall + stats) ──────────────────────────────────────
router.get("/reviews", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query["limit"] ?? "10"), 10) || 10, 1), 30);
  const col = await getCollection<ReviewDoc>("reviews");

  const docs = await col
    .find({ isPublic: true, rating: { $gte: 4 }, comment: { $ne: null } })
    .sort({ rating: -1, createdAt: -1 })
    .limit(limit)
    .toArray();

  // Resolve reviewer display names.
  const users = await getCollection<UserLite>("users");
  const tgIds = [...new Set(docs.map((d) => d.telegramId))];
  const userDocs = tgIds.length
    ? await users.find({ telegramId: { $in: tgIds } }).toArray()
    : [];
  const nameByTg = new Map(userDocs.map((u) => [u.telegramId, displayName(u)]));

  // Aggregate stats (mirror FeedbackService.getStats).
  const agg = await col
    .aggregate<{ _id: null; avg: number; rated: number; fiveStars: number }>([
      { $match: { rating: { $ne: null } } },
      {
        $group: {
          _id: null,
          avg: { $avg: "$rating" },
          rated: { $sum: 1 },
          fiveStars: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  const stats = agg[0] ?? { avg: 0, rated: 0, fiveStars: 0 };

  res.json({
    reviews: docs.map((d) => ({
      id: d._id.toString(),
      rating: d.rating ?? 0,
      comment: d.comment ?? "",
      productName: d.productName ?? "Order",
      author: nameByTg.get(d.telegramId) ?? "Anonymous",
      createdAt: d.createdAt ?? null,
    })),
    stats: {
      avgRating: stats.avg ? Math.round(stats.avg * 10) / 10 : 0,
      rated: stats.rated ?? 0,
      fiveStars: stats.fiveStars ?? 0,
    },
  });
});

// ── GET /reviews/mine  (auth) ────────────────────────────────────────────────
router.get("/reviews/mine", telegramAuth, async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const col = await getCollection<ReviewDoc>("reviews");
  const docs = await col
    .find({ userId: u._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  res.json({
    reviews: docs.map((d) => ({
      orderId: d.orderId.toString(),
      productName: d.productName ?? "Order",
      rating: d.rating ?? null,
      comment: d.comment ?? null,
      isPublic: !!d.isPublic,
      createdAt: d.createdAt ?? null,
    })),
  });
});

// ── GET /reviews/ratable  (auth) ─────────────────────────────────────────────
// Success orders the user owns that don't yet have a rating.
router.get("/reviews/ratable", telegramAuth, async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const orders = await getCollection<OrderLite>("orders");
  const reviews = await getCollection<ReviewDoc>("reviews");
  const products = await getCollection<ProductLite>("products");

  const successOrders = await orders
    .find({ userId: u._id, status: "Success" })
    .sort({ timestamp: -1 })
    .limit(50)
    .toArray();

  if (!successOrders.length) {
    res.json({ orders: [] });
    return;
  }

  // Exclude orders that already have a rating (unrated placeholders are still ratable).
  const orderIds = successOrders.map((o) => o._id);
  const existing = await reviews
    .find({ orderId: { $in: orderIds }, rating: { $ne: null } })
    .toArray();
  const ratedSet = new Set(existing.map((r) => r.orderId.toString()));

  const productIds = [...new Set(successOrders.map((o) => o.productId?.toString()).filter(Boolean))]
    .map((s) => new ObjectId(s));
  const prodDocs = productIds.length
    ? await products.find({ _id: { $in: productIds } }).toArray()
    : [];
  const nameById = new Map(prodDocs.map((p) => [p._id.toString(), p.name]));

  const ratable = successOrders
    .filter((o) => !ratedSet.has(o._id.toString()))
    .map((o) => ({
      orderId: o._id.toString(),
      productName: nameById.get(o.productId?.toString() ?? "") || o.gameName || "Order",
      date: o.timestamp ?? null,
    }));

  res.json({ orders: ratable });
});

// ── POST /reviews  (auth) ────────────────────────────────────────────────────
// body: { orderId, rating (1–5), comment? }
router.post("/reviews", telegramAuth, async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const body = (req.body ?? {}) as { orderId?: string; rating?: number; comment?: string };

  const orderId = safeId(body.orderId ?? "");
  if (!orderId) {
    res.status(400).json({ error: "Invalid orderId" });
    return;
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: "Rating must be an integer 1–5" });
    return;
  }

  const commentRaw = typeof body.comment === "string" ? body.comment.trim().slice(0, 500) : "";
  const comment = commentRaw.length > 0 ? commentRaw : null;

  // Verify the order belongs to this user and is completed.
  const orders = await getCollection<OrderLite>("orders");
  const order = await orders.findOne({ _id: orderId, userId: u._id });
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (order.status !== "Success") {
    res.status(400).json({ error: "Only completed orders can be reviewed" });
    return;
  }

  // Resolve product name for the review card.
  let productName = order.gameName || "Order";
  if (order.productId) {
    const products = await getCollection<ProductLite>("products");
    const p = await products.findOne({ _id: order.productId });
    if (p?.name) productName = p.name;
  }

  const reviews = await getCollection<ReviewDoc>("reviews");
  const now = new Date();
  const isPublic = rating >= 4;

  // Upsert: bot may have pre-created a placeholder; one review per order.
  await reviews.updateOne(
    { orderId },
    {
      $set: {
        userId: u._id,
        telegramId: u.telegramId,
        productName,
        rating,
        comment,
        isPublic,
        skipped: false,
        respondedAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        orderId,
        forwardedToChannel: false,
        feedbackRequestSentAt: now,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  res.json({ ok: true, rating, isPublic });
});

export default router;
