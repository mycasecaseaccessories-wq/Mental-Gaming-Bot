/**
 * Coin Rewards & Redeem Codes — mini-app routes.
 * Replicates bot RewardService logic directly against the shared MongoDB.
 *
 *   product reward → creates a coin-paid Order (amount 0, paidWith 'coin')
 *   coupon reward  → issues a personal Promo restricted to the redeemer
 *
 * Reward items cost Mental Coins (balanceCoin). Redeem codes are free.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectId } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(telegramAuth);

function asUser(req: Request): StoreUser {
  return req.storeUser as StoreUser;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type RewardType = "product" | "coupon";
type DiscountType = "Flat" | "Percentage";

interface CheckoutField {
  key: string;
  label: string;
  fieldType?: string;
  required?: boolean;
  placeholder?: string;
  sortOrder?: number;
}

interface ProductDoc {
  _id: ObjectId;
  name: string;
  productType?: string;
  category?: string;
  catalogId?: ObjectId | null;
  checkoutFieldsOverride?: CheckoutField[] | null;
  stockCount?: number;
  isActive?: boolean;
  status?: string;
}

interface CatalogDoc {
  _id: ObjectId;
  checkoutFields?: CheckoutField[];
  parentCategory?: ObjectId | null;
}

interface RewardItemDoc {
  _id: ObjectId;
  name: string;
  description?: string;
  imageUrl?: string | null;
  coinPrice: number;
  rewardType: RewardType;
  productId?: ObjectId | null;
  couponDiscountType?: DiscountType | null;
  couponValue?: number | null;
  couponMinOrder?: number;
  couponExpiryDays?: number | null;
  stockCount?: number;
  perUserLimit?: number;
  redeemCount?: number;
  redeemedBy?: { userId: ObjectId; at: Date }[];
  status?: string;
  sortOrder?: number;
}

interface RedeemCodeDoc {
  _id: ObjectId;
  code: string;
  description?: string;
  rewardType: RewardType;
  productId?: ObjectId | null;
  couponDiscountType?: DiscountType | null;
  couponValue?: number | null;
  couponMinOrder?: number;
  couponExpiryDays?: number | null;
  maxUses?: number | null;
  currentUses?: number;
  perUserLimit?: number;
  expiryDate?: Date | null;
  usedBy?: { userId: ObjectId; at: Date }[];
  isActive?: boolean;
}

interface PromoDoc {
  _id: ObjectId;
  code: string;
  discountType: DiscountType;
  value: number;
  maxUses?: number | null;
  currentUses?: number;
  expiryDate?: Date | null;
  minOrderAmount?: number;
  restrictedToUserId?: ObjectId | null;
  isActive?: boolean;
  createdBy?: number | null;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface CheckoutValue {
  key: string;
  label: string;
  value: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const ZONE_REQUIRED = ["mobile legends", "ml", "moonton"];
function needsZone(gameName = ""): boolean {
  return ZONE_REQUIRED.some((g) => gameName.toLowerCase().includes(g));
}

async function resolveCheckoutFields(product: ProductDoc): Promise<CheckoutField[]> {
  if (Array.isArray(product.checkoutFieldsOverride)) {
    return product.checkoutFieldsOverride
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }
  if (product.catalogId) {
    const catalogs = await getCollection<CatalogDoc>("catalogs");
    const catalog = await catalogs.findOne({ _id: product.catalogId });
    if (catalog?.checkoutFields?.length) {
      return catalog.checkoutFields.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }
    if (catalog?.parentCategory) {
      const parent = await catalogs.findOne({ _id: catalog.parentCategory });
      if (parent?.checkoutFields?.length) {
        return parent.checkoutFields.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      }
    }
  }
  if (product.productType === "DirectTopup") {
    return [
      { key: "game_id", label: "Game ID", fieldType: "text", required: true, placeholder: "Enter your Player ID" },
      ...(needsZone(product.category || product.name)
        ? [{ key: "zone_id", label: "Server ID", fieldType: "number", required: true, placeholder: "Your Server / Zone ID" }]
        : []),
    ];
  }
  return [];
}

function productInStock(p: ProductDoc): boolean {
  return p.stockCount === -1 || (typeof p.stockCount === "number" ? p.stockCount > 0 : true);
}
function productAvailable(p: ProductDoc | null): p is ProductDoc {
  return !!p && p.isActive !== false && p.status !== "hidden";
}

function couponSummary(d: { couponDiscountType?: DiscountType | null; couponValue?: number | null; couponMinOrder?: number }) {
  return {
    discountType: d.couponDiscountType ?? null,
    value: d.couponValue ?? null,
    minOrder: d.couponMinOrder ?? 0,
  };
}

async function uniqueCouponCode(): Promise<string> {
  const promos = await getCollection<PromoDoc>("promos");
  for (let i = 0; i < 12; i++) {
    const code = "RW" + Math.random().toString(36).slice(2, 8).toUpperCase();
    if (!(await promos.findOne({ code }))) return code;
  }
  throw new Error("Could not generate a unique coupon code");
}

async function debitCoins(userId: ObjectId, cost: number, note: string, balanceBefore: number): Promise<number> {
  const users = await getCollection<{ _id: ObjectId; balanceCoin: number }>("users");
  const debited = await users.findOneAndUpdate(
    { _id: userId, balanceCoin: { $gte: cost } },
    { $inc: { balanceCoin: -cost } },
    { returnDocument: "after" }
  );
  if (!debited) throw new Error("Not enough Mental Coins.");
  const now = new Date();
  const txs = await getCollection<Record<string, unknown>>("transactions");
  await txs.insertOne({
    _id: new ObjectId(), userId, type: "Debit", wallet: "Coin",
    amount: -cost, balanceBefore, balanceAfter: debited.balanceCoin,
    status: "Completed", note, createdAt: now, timestamp: now,
  });
  return debited.balanceCoin;
}

async function creditCoins(userId: ObjectId, amount: number, note: string): Promise<void> {
  const users = await getCollection<{ _id: ObjectId; balanceCoin: number }>("users");
  const after = await users.findOneAndUpdate(
    { _id: userId }, { $inc: { balanceCoin: amount } }, { returnDocument: "after" }
  );
  const now = new Date();
  const txs = await getCollection<Record<string, unknown>>("transactions");
  await txs.insertOne({
    _id: new ObjectId(), userId, type: "Refund", wallet: "Coin",
    amount, balanceBefore: (after?.balanceCoin ?? amount) - amount,
    balanceAfter: after?.balanceCoin ?? amount, status: "Completed", note, createdAt: now, timestamp: now,
  });
}

async function issuePersonalCoupon(
  userId: ObjectId,
  spec: { discountType: DiscountType; value: number; minOrder?: number; expiryDays?: number | null },
  source: string
): Promise<PromoDoc> {
  if (!["Flat", "Percentage"].includes(spec.discountType)) throw new Error("Invalid coupon discount type");
  if (!(spec.value > 0)) throw new Error("Coupon value must be positive");
  const code = await uniqueCouponCode();
  const now = new Date();
  const doc: PromoDoc = {
    _id: new ObjectId(),
    code,
    discountType: spec.discountType,
    value: spec.value,
    maxUses: 1,
    currentUses: 0,
    expiryDate: spec.expiryDays ? new Date(Date.now() + spec.expiryDays * 86400000) : null,
    minOrderAmount: spec.minOrder || 0,
    restrictedToUserId: userId,
    isActive: true,
    createdBy: null,
    description: `Reward coupon (${source})`,
    createdAt: now,
    updatedAt: now,
  };
  const promos = await getCollection<PromoDoc>("promos");
  await promos.insertOne(doc);
  return doc;
}

async function createRedemptionOrder(
  userId: ObjectId, product: ProductDoc, checkoutData: CheckoutValue[], coinCost: number, source: string
): Promise<{ _id: ObjectId; shortId: string }> {
  if (coinCost > 0) {
    const users = await getCollection<{ _id: ObjectId; balanceCoin: number }>("users");
    const u = await users.findOne({ _id: userId });
    await debitCoins(userId, coinCost, `Coin reward: ${product.name}`, u?.balanceCoin ?? 0);
  }
  try {
    const now = new Date();
    const orderId = new ObjectId();
    const orders = await getCollection<Record<string, unknown>>("orders");
    await orders.insertOne({
      _id: orderId,
      userId,
      productId: product._id,
      productType: product.productType,
      amount: 0,
      originalAmount: 0,
      quantity: 1,
      paidWith: "coin",
      coinCost,
      rewardSource: source,
      catalogId: product.catalogId ?? null,
      checkoutData,
      status: "Pending",
      statusHistory: [{ status: "Pending", at: now, note: `Coin redemption (${coinCost} MC)` }],
      timestamp: now,
      createdAt: now,
      updatedAt: now,
    });
    if (product.stockCount !== -1) {
      const products = await getCollection<ProductDoc>("products");
      await products.updateOne({ _id: product._id }, { $inc: { stockCount: -1 } });
    }
    return { _id: orderId, shortId: orderId.toString().slice(-8).toUpperCase() };
  } catch (err) {
    if (coinCost > 0) {
      await creditCoins(userId, coinCost, "Reward redemption failed — coin refund").catch(() => {});
    }
    throw err;
  }
}

function userCount(list: { userId: ObjectId }[] | undefined, userId: ObjectId): number {
  if (!list) return 0;
  return list.filter((e) => e.userId?.toString() === userId.toString()).length;
}

// ── GET /rewards/items — active coin-reward catalog ─────────────────────────────
router.get("/items", async (req: Request, res: Response) => {
  const u = asUser(req);
  const items = await getCollection<RewardItemDoc>("rewarditems");
  const products = await getCollection<ProductDoc>("products");

  const list = await items.find({ status: "active" }).sort({ sortOrder: 1, createdAt: -1 }).toArray();

  const out = await Promise.all(
    list.map(async (it) => {
      const inStock = it.stockCount === -1 || (typeof it.stockCount === "number" ? it.stockCount > 0 : true);
      const alreadyRedeemed = userCount(it.redeemedBy, u._id);
      const perUserLimit = it.perUserLimit ?? 0;
      let productName: string | null = null;
      let fields: CheckoutField[] = [];
      if (it.rewardType === "product" && it.productId) {
        const p = await products.findOne({ _id: it.productId });
        productName = p?.name ?? null;
        if (p) fields = await resolveCheckoutFields(p);
      }
      return {
        id: it._id.toString(),
        name: it.name,
        description: it.description ?? "",
        imageUrl: it.imageUrl ?? null,
        coinPrice: it.coinPrice,
        rewardType: it.rewardType,
        productName,
        coupon: it.rewardType === "coupon" ? couponSummary(it) : null,
        checkoutFields: fields.map((f) => ({
          key: f.key, label: f.label, fieldType: f.fieldType ?? "text",
          required: f.required !== false, placeholder: f.placeholder ?? "",
        })),
        stockCount: it.stockCount ?? -1,
        perUserLimit,
        redeemedByUser: alreadyRedeemed,
        canRedeem: inStock && (perUserLimit === 0 || alreadyRedeemed < perUserLimit) && u.balanceCoin >= it.coinPrice,
      };
    })
  );

  res.json({ coinBalance: u.balanceCoin, items: out });
});

// ── POST /rewards/items/:id/redeem ──────────────────────────────────────────────
router.post("/items/:id/redeem", async (req: Request, res: Response) => {
  const u = asUser(req);
  const idParam = String(req.params["id"] ?? "");
  if (!idParam || !ObjectId.isValid(idParam)) return res.status(400).json({ error: "Invalid reward id" });

  const items = await getCollection<RewardItemDoc>("rewarditems");
  const item = await items.findOne({ _id: new ObjectId(idParam) });
  if (!item) return res.status(404).json({ error: "Reward not found." });

  const inStock = item.stockCount === -1 || (typeof item.stockCount === "number" ? item.stockCount > 0 : true);
  if (item.status !== "active" || !inStock) return res.status(409).json({ error: "This reward is not available right now." });
  const perUserLimit = item.perUserLimit ?? 0;
  if (perUserLimit > 0 && userCount(item.redeemedBy, u._id) >= perUserLimit) {
    return res.status(409).json({ error: "You have reached the redemption limit for this reward." });
  }
  if (u.balanceCoin < item.coinPrice) {
    return res.status(402).json({ error: "not_enough_coins", needed: item.coinPrice, balance: u.balanceCoin });
  }

  try {
    if (item.rewardType === "coupon") {
      if (!item.couponDiscountType || !item.couponValue) return res.status(500).json({ error: "Reward is misconfigured." });
      const newBal = await debitCoins(u._id, item.coinPrice, `Coin reward: ${item.name}`, u.balanceCoin);
      let promo: PromoDoc;
      try {
        promo = await issuePersonalCoupon(
          u._id,
          { discountType: item.couponDiscountType, value: item.couponValue, minOrder: item.couponMinOrder ?? 0, expiryDays: item.couponExpiryDays ?? null },
          "reward_item"
        );
      } catch (e) {
        await creditCoins(u._id, item.coinPrice, "Reward coupon failed — coin refund").catch(() => {});
        throw e;
      }
      await recordItemRedemption(item, u._id);
      return res.json({
        type: "coupon",
        coupon: { code: promo.code, discountType: promo.discountType, value: promo.value, minOrderAmount: promo.minOrderAmount ?? 0, expiryDate: promo.expiryDate ?? null },
        newBalanceCoin: newBal,
      });
    }

    // product reward
    if (!item.productId) return res.status(500).json({ error: "Reward is misconfigured." });
    const products = await getCollection<ProductDoc>("products");
    const product = await products.findOne({ _id: item.productId });
    if (!productAvailable(product)) return res.status(409).json({ error: "The linked product is no longer available." });
    if (!productInStock(product)) return res.status(409).json({ error: "The linked product is out of stock." });

    const fields = await resolveCheckoutFields(product);
    const checkoutData = collectCheckout(fields, req.body);
    if (checkoutData.error) return res.status(400).json({ error: checkoutData.error });

    const order = await createRedemptionOrder(u._id, product, checkoutData.values, item.coinPrice, "reward_item");
    await recordItemRedemption(item, u._id);
    return res.json({
      type: "product",
      order: { id: order._id.toString(), shortId: order.shortId, productName: product.name, status: "Pending" },
      newBalanceCoin: u.balanceCoin - item.coinPrice,
    });
  } catch (err) {
    logger.error({ err }, "reward item redeem failed");
    return res.status(500).json({ error: (err as Error).message || "Redemption failed." });
  }
});

async function recordItemRedemption(item: RewardItemDoc, userId: ObjectId): Promise<void> {
  const items = await getCollection<RewardItemDoc>("rewarditems");
  const update: Record<string, unknown> = {
    $inc: { redeemCount: 1 },
    $push: { redeemedBy: { userId, at: new Date() } },
  };
  if (item.stockCount !== -1) (update["$inc"] as Record<string, number>)["stockCount"] = -1;
  await items.updateOne({ _id: item._id }, update);
}

// ── GET /rewards/codes/:code/preview ────────────────────────────────────────────
router.get("/codes/:code/preview", async (req: Request, res: Response) => {
  const u = asUser(req);
  const raw = String(req.params["code"] ?? "").toUpperCase().trim();
  if (!raw) return res.status(400).json({ error: "Enter a code." });

  const codes = await getCollection<RedeemCodeDoc>("redeemcodes");
  const code = await codes.findOne({ code: raw });
  if (!code) return res.status(404).json({ error: "Invalid redeem code." });
  if (!codeValid(code)) return res.status(409).json({ error: "This code has expired or is no longer active." });
  if ((code.perUserLimit ?? 1) > 0 && userCount(code.usedBy, u._id) >= (code.perUserLimit ?? 1)) {
    return res.status(409).json({ error: "You have already redeemed this code." });
  }

  let productName: string | null = null;
  let fields: CheckoutField[] = [];
  if (code.rewardType === "product" && code.productId) {
    const products = await getCollection<ProductDoc>("products");
    const p = await products.findOne({ _id: code.productId });
    if (!productAvailable(p)) return res.status(409).json({ error: "The linked product is no longer available." });
    if (!productInStock(p)) return res.status(409).json({ error: "The linked product is out of stock." });
    productName = p.name;
    fields = await resolveCheckoutFields(p);
  }

  return res.json({
    code: code.code,
    description: code.description ?? "",
    rewardType: code.rewardType,
    productName,
    coupon: code.rewardType === "coupon" ? couponSummary(code) : null,
    checkoutFields: fields.map((f) => ({
      key: f.key, label: f.label, fieldType: f.fieldType ?? "text",
      required: f.required !== false, placeholder: f.placeholder ?? "",
    })),
  });
});

// ── POST /rewards/codes/redeem — body { code, ...fields } ────────────────────────
router.post("/codes/redeem", async (req: Request, res: Response) => {
  const u = asUser(req);
  const raw = String((req.body as { code?: string }).code ?? "").toUpperCase().trim();
  if (!raw) return res.status(400).json({ error: "Enter a code." });

  const codes = await getCollection<RedeemCodeDoc>("redeemcodes");
  const code = await codes.findOne({ code: raw });
  if (!code) return res.status(404).json({ error: "Invalid redeem code." });
  if (!codeValid(code)) return res.status(409).json({ error: "This code has expired or is no longer active." });
  if ((code.perUserLimit ?? 1) > 0 && userCount(code.usedBy, u._id) >= (code.perUserLimit ?? 1)) {
    return res.status(409).json({ error: "You have already redeemed this code." });
  }

  // Validate any required product fields BEFORE consuming the code so a bad
  // submission never burns a use.
  let product: ProductDoc | null = null;
  let checkoutValues: CheckoutValue[] = [];
  if (code.rewardType === "product") {
    if (!code.productId) return res.status(500).json({ error: "Code is misconfigured." });
    const products = await getCollection<ProductDoc>("products");
    product = await products.findOne({ _id: code.productId });
    if (!productAvailable(product)) return res.status(409).json({ error: "The linked product is no longer available." });
    if (!productInStock(product)) return res.status(409).json({ error: "The linked product is out of stock." });
    const fields = await resolveCheckoutFields(product);
    const collected = collectCheckout(fields, req.body);
    if (collected.error) return res.status(400).json({ error: collected.error });
    checkoutValues = collected.values;
  } else if (!code.couponDiscountType || !code.couponValue) {
    return res.status(500).json({ error: "Code is misconfigured." });
  }

  // Atomically consume one use (guards isActive/expiry/maxUses/per-user in the
  // filter itself) so concurrent requests can never over-redeem a free code.
  const consumed = await tryConsumeCode(code, u._id);
  if (!consumed) return res.status(409).json({ error: "This code has expired or is no longer available." });

  try {
    if (code.rewardType === "coupon") {
      const promo = await issuePersonalCoupon(
        u._id,
        { discountType: code.couponDiscountType!, value: code.couponValue!, minOrder: code.couponMinOrder ?? 0, expiryDays: code.couponExpiryDays ?? null },
        "redeem_code"
      );
      return res.json({
        type: "coupon",
        coupon: { code: promo.code, discountType: promo.discountType, value: promo.value, minOrderAmount: promo.minOrderAmount ?? 0, expiryDate: promo.expiryDate ?? null },
      });
    }

    const order = await createRedemptionOrder(u._id, product!, checkoutValues, 0, "redeem_code");
    return res.json({
      type: "product",
      order: { id: order._id.toString(), shortId: order.shortId, productName: product!.name, status: "Pending" },
    });
  } catch (err) {
    await rollbackCodeUse(code, u._id).catch(() => {});
    logger.error({ err }, "redeem code failed");
    return res.status(500).json({ error: (err as Error).message || "Redemption failed." });
  }
});

function codeValid(c: RedeemCodeDoc): boolean {
  if (c.isActive === false) return false;
  if (c.expiryDate && new Date() > new Date(c.expiryDate)) return false;
  if (c.maxUses !== null && c.maxUses !== undefined && (c.currentUses ?? 0) >= c.maxUses) return false;
  return true;
}

/**
 * Atomically reserve one use of a redeem code. Returns false when the code is
 * inactive, expired, exhausted, or (when single-use per user) already used by
 * this user — enforced in the filter so simultaneous requests can't both win.
 */
async function tryConsumeCode(code: RedeemCodeDoc, userId: ObjectId): Promise<boolean> {
  const codes = await getCollection<RedeemCodeDoc>("redeemcodes");
  const now = new Date();
  const perUserLimit = code.perUserLimit ?? 1;
  const filter: Record<string, unknown> = {
    _id: code._id,
    isActive: { $ne: false },
    $or: [{ expiryDate: null }, { expiryDate: { $exists: false } }, { expiryDate: { $gt: now } }],
    $expr: {
      $or: [
        { $eq: [{ $ifNull: ["$maxUses", null] }, null] },
        { $lt: [{ $ifNull: ["$currentUses", 0] }, "$maxUses"] },
      ],
    },
  };
  if (perUserLimit <= 1) filter["usedBy.userId"] = { $ne: userId };
  const updated = await codes.findOneAndUpdate(
    filter,
    { $inc: { currentUses: 1 }, $push: { usedBy: { userId, at: now } } } as never,
    { returnDocument: "after" }
  );
  return !!updated;
}

async function rollbackCodeUse(code: RedeemCodeDoc, userId: ObjectId): Promise<void> {
  const codes = await getCollection<RedeemCodeDoc>("redeemcodes");
  await codes.updateOne(
    { _id: code._id },
    { $inc: { currentUses: -1 }, $pull: { usedBy: { userId } } } as never
  );
}

function collectCheckout(
  fields: CheckoutField[], body: unknown
): { values: CheckoutValue[]; error?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const incoming = (b["checkoutData"] && typeof b["checkoutData"] === "object")
    ? (b["checkoutData"] as Record<string, unknown>)
    : b;
  const values: CheckoutValue[] = [];
  for (const f of fields) {
    const rawVal = incoming[f.key];
    const val = rawVal === undefined || rawVal === null ? "" : String(rawVal).trim();
    if (f.required !== false && !val) return { values, error: `Missing required field: ${f.label}` };
    if (f.fieldType === "number" && val && isNaN(Number(val))) return { values, error: `${f.label} must be a number` };
    if (val) values.push({ key: f.key, label: f.label, value: val });
  }
  return { values };
}

export default router;
