import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectId, type Filter, type WithId } from "mongodb";
import multer from "multer";
import { getClient, getCollection } from "../lib/mongodb";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";
import { sendPhoto } from "../lib/telegramApi";
import { logger } from "../lib/logger";
import { validatePromo, calcPromoDiscount, type PromoDoc } from "../lib/promo";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB — Telegram photo cap
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPEG, or WebP images allowed"));
  },
});

function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

function adminChatId(): number | null {
  const raw = process.env["ADMIN_ID"];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const router: IRouter = Router();
router.use(telegramAuth);

// ── Types mirroring bot Mongoose models ─────────────────────────────────────

interface CheckoutFieldDef {
  key: string;
  label: string;
  fieldType: "text" | "number" | "email" | "textarea";
  required: boolean;
  placeholder?: string;
  helpText?: string;
  sortOrder?: number;
}

interface CatalogDoc {
  _id: ObjectId;
  name: string;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  parentCategory?: ObjectId | null;  // MongoDB field name (bot uses this)
  checkoutFields: CheckoutFieldDef[];
}

interface ProductDoc {
  _id: ObjectId;
  name: string;
  category: string;
  region: string;
  productType: "DirectTopup" | "DigitalCode";
  finalPrice: number;
  flashSalePrice: number | null;
  flashSaleStart: Date | null;
  flashSaleEnd: Date | null;
  stockCount: number;
  isActive: boolean;
  status?: "active" | "out_of_stock" | "coming_soon" | "hidden";
  imageUrl: string | null;
  description: string;
  catalogId?: ObjectId | null;
  sortOrder?: number;
  checkoutFieldsOverride?: CheckoutFieldDef[] | null;
}

interface BannerDoc {
  _id: ObjectId;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  targetType: "shop" | "category" | "product" | "url" | "none";
  targetId: string | null;
  buttonText: string | null;
  startAt: Date | null;
  endAt: Date | null;
  isActive: boolean;
  priority: number;
}

interface NotificationDoc {
  _id: ObjectId;
  userId: ObjectId;
  telegramId: number;
  type: string;
  title: string;
  body: string | null;
  imageUrl: string | null;
  targetType: string;
  targetId: string | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt?: Date;
}

interface SystemStatusDoc {
  _id: string;
  featureGateEnabled?: boolean;
  unlockTargetUsers?: number;
  manuallyUnlockedFeatures?: string[];
  manuallyLockedFeatures?: string[];
  mcRedeemEnabled?: boolean;
  mcExchangeRate?: number;
  mcMinRedeem?: number;
  mcMaxDiscountPct?: number;
}

interface OrderDoc {
  _id: ObjectId;
  userId: ObjectId;
  productId: ObjectId;
  amount: number;
  originalAmount: number | null;
  tierDiscount: number;
  tierDiscountPct: number;
  status: "Pending" | "Processing" | "Success" | "Cancelled" | "Refunded";
  productType: "DirectTopup" | "DigitalCode";
  gameId: string | null;
  zoneId: string | null;
  gameName: string | null;
  catalogId?: ObjectId | null;
  catalogName?: string | null;
  promoCode?: string | null;
  promoDiscount?: number;
  quantity?: number;
  unitPrice?: number | null;
  checkoutData?: Array<{ key: string; label: string; value: string }>;
  timestamp: Date;
  notes: string;
}

interface TxDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: string;
  wallet: "KS" | "Coin";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: "Pending" | "Completed" | "Rejected";
  paymentMethod: string | null;
  description?: string;
  note?: string;
  txId?: string;
  screenshotUrl?: string | null;
  screenshotHash?: string | null;
  createdAt?: Date;
  timestamp?: Date;
}

function shortCodeFor(method: string): string {
  const m = method.toUpperCase();
  if (m === "KPAY" || m === "KBZPAY") return "KPAY";
  if (m === "WAVE" || m === "WAVEPAY") return "WAVE";
  if (m === "AYA" || m === "AYAPAY") return "AYA";
  if (m === "CB" || m === "CBPAY") return "CB";
  return m;
}

async function ensureUniqueTxId(
  txs: Awaited<ReturnType<typeof getCollection<TxDoc>>>
): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const id = "TX" + crypto.randomBytes(6).toString("hex").toUpperCase();
    const existing = await txs.findOne({ txId: id });
    if (!existing) return id;
  }
  throw new Error("Could not generate unique txId");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function effectivePrice(p: ProductDoc): number {
  const now = Date.now();
  if (
    p.flashSalePrice &&
    p.flashSaleStart &&
    p.flashSaleEnd &&
    new Date(p.flashSaleStart).getTime() <= now &&
    new Date(p.flashSaleEnd).getTime() >= now
  ) {
    return p.flashSalePrice;
  }
  return p.finalPrice;
}

function tierDiscountPct(tier: StoreUser["membershipTier"]): number {
  if (tier === "Platinum") return 5;
  if (tier === "Gold") return 2;
  return 0;
}

function publicProduct(p: ProductDoc) {
  const effective = effectivePrice(p);
  const onSale = effective < p.finalPrice;
  const status = p.status ?? (p.isActive ? "active" : "hidden");
  return {
    id: p._id.toString(),
    name: p.name,
    category: p.category,
    region: p.region,
    productType: p.productType,
    price: p.finalPrice,
    effectivePrice: effective,
    onSale,
    flashSaleEnd: onSale ? p.flashSaleEnd : null,
    inStock: p.stockCount === -1 || p.stockCount > 0,
    imageUrl: p.imageUrl,
    description: p.description,
    catalogId: p.catalogId?.toString() ?? null,
    sortOrder: p.sortOrder ?? 0,
    checkoutFields: p.checkoutFieldsOverride ?? null,
    status,
  };
}

function safeId(s: string): ObjectId | null {
  return ObjectId.isValid(s) ? new ObjectId(s) : null;
}

function asUser(req: Request): StoreUser {
  return req.storeUser as StoreUser;
}

// ── GET /me ────────────────────────────────────────────────────────────────

router.get("/me", (req: Request, res: Response) => {
  const u = asUser(req) as StoreUser & {
    lifetimeTier?: string;
    activeTier?: string;
    lifetimeSpend?: number;
    yearlySpend?: number;
  };
  res.json({
    id: u._id.toString(),
    telegramId: u.telegramId,
    username: u.username,
    firstName: u.first_name,
    balanceKS: u.balanceKS,
    balanceCoin: u.balanceCoin,
    totalDeposited: u.totalDeposited,
    tier: u.membershipTier,
    language: u.language,
    theme: (u as StoreUser).theme ?? "auto",
    photoUrl: req.tgUser?.photo_url || null,
    tierDiscountPct: tierDiscountPct(u.membershipTier),
    lifetimeTier:  u.lifetimeTier  ?? "Bronze",
    activeTier:    u.activeTier    ?? "Bronze",
    lifetimeSpend: u.lifetimeSpend ?? 0,
    yearlySpend:   u.yearlySpend   ?? 0,
  });
});

// ── PATCH /me — update user preferences (language + theme) ───────────────────
// Writes to the shared `users` doc so the bot honors the same preferences.
router.patch("/me", async (req: Request, res: Response) => {
  const u = asUser(req);
  const body = (req.body ?? {}) as { language?: string; theme?: string };

  const update: Record<string, unknown> = {};
  if (body.language !== undefined) {
    if (body.language !== "en" && body.language !== "mm") {
      res.status(400).json({ error: "language must be 'en' or 'mm'" });
      return;
    }
    update["language"] = body.language;
  }
  if (body.theme !== undefined) {
    if (!["light", "dark", "auto"].includes(body.theme)) {
      res.status(400).json({ error: "theme must be 'light', 'dark', or 'auto'" });
      return;
    }
    update["theme"] = body.theme;
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  update["updatedAt"] = new Date();

  const users = await getCollection<StoreUser>("users");
  await users.updateOne({ _id: u._id }, { $set: update });

  res.json({
    ok: true,
    language: (update["language"] as string) ?? u.language,
    theme: (update["theme"] as string) ?? (u as StoreUser).theme ?? "auto",
  });
});

// ── GET /catalogs ──────────────────────────────────────────────────────────

router.get("/catalogs", async (req: Request, res: Response) => {
  const catalogs = await getCollection<CatalogDoc>("catalogs");
  const docs = await catalogs
    .find({ isActive: true })
    .sort({ sortOrder: 1, name: 1 })
    .toArray();

  // Count products per catalog — match by catalogId OR by category name (legacy products without catalogId)
  const products = await getCollection<ProductDoc>("products");
  const countMap = new Map<string, number>();
  for (const cat of docs) {
    const n = await products.countDocuments({
      isActive: true,
      $or: [
        { catalogId: cat._id },
        { catalogId: { $in: [null, undefined] }, category: cat.name },
      ],
    });
    countMap.set(cat._id.toString(), n);
  }

  // Build sub-catalog map (parentId → children)
  const subMap = new Map<string, typeof docs>();
  for (const c of docs) {
    if (c.parentCategory) {
      const pid = c.parentCategory.toString();
      if (!subMap.has(pid)) subMap.set(pid, []);
      subMap.get(pid)!.push(c);
    }
  }

  const toItem = (c: (typeof docs)[0]) => ({
    id: c._id.toString(),
    name: c.name,
    imageUrl: c.imageUrl ?? null,
    sortOrder: c.sortOrder,
    parentCategoryId: c.parentCategory?.toString() ?? null,
    checkoutFields: c.checkoutFields,
    productCount: countMap.get(c._id.toString()) ?? 0,
  });

  // Only root catalogs (no parent) at top level; include sub-catalog counts
  const rootDocs = docs.filter((c) => !c.parentCategory);
  res.json({
    catalogs: rootDocs.map((c) => ({
      ...toItem(c),
      subCatalogs: (subMap.get(c._id.toString()) ?? []).map(toItem),
    })),
  });
});

// ── GET /catalogs/:id ──────────────────────────────────────────────────────

router.get("/catalogs/:id", async (req: Request, res: Response) => {
  const id = safeId(String(req.params["id"] ?? ""));
  if (!id) { res.status(400).json({ error: "Bad catalog id" }); return; }

  const catalogs = await getCollection<CatalogDoc>("catalogs");
  const cat = await catalogs.findOne({ _id: id, isActive: true });
  if (!cat) { res.status(404).json({ error: "Catalog not found" }); return; }

  // Sub-catalogs of this catalog
  const subDocs = await catalogs
    .find({ parentCategory: id, isActive: true })
    .sort({ sortOrder: 1, name: 1 })
    .toArray();

  const products = await getCollection<ProductDoc>("products");
  // Match by catalogId OR by category name (for legacy products without catalogId)
  const productDocs = await products
    .find({
      isActive: true,
      $or: [
        { catalogId: id },
        { catalogId: { $in: [null, undefined] }, category: cat.name },
      ],
    })
    .sort({ sortOrder: 1, name: 1 })
    .toArray();

  // Resolve effective checkout fields: own → parent
  let effectiveFields = cat.checkoutFields;
  if (!effectiveFields.length && cat.parentCategoryId) {
    const parent = await catalogs.findOne({ _id: cat.parentCategoryId });
    if (parent?.checkoutFields?.length) effectiveFields = parent.checkoutFields;
  }

  res.json({
    id: cat._id.toString(),
    name: cat.name,
    imageUrl: cat.imageUrl ?? null,
    parentCategoryId: cat.parentCategory?.toString() ?? null,
    checkoutFields: effectiveFields,
    subCatalogs: subDocs.map((s) => ({
      id: s._id.toString(),
      name: s.name,
      imageUrl: s.imageUrl ?? null,
      sortOrder: s.sortOrder,
      parentCategoryId: id.toString(),
      checkoutFields: s.checkoutFields,
      productCount: 0,
    })),
    products: productDocs.map(publicProduct),
  });
});

// ── GET /products ──────────────────────────────────────────────────────────

router.get("/products", async (req: Request, res: Response) => {
  const products = await getCollection<ProductDoc>("products");
  const filter: Filter<ProductDoc> = {
    isActive: true,
    status: { $nin: ["hidden"] } as Filter<ProductDoc>["status"],
  };
  const cat = req.query["category"];
  if (typeof cat === "string" && cat) filter.category = cat;
  const search = req.query["search"];
  if (typeof search === "string" && search) {
    filter.name = { $regex: search, $options: "i" };
  }
  const docs = await products
    .find(filter)
    .sort({ category: 1, name: 1 })
    .limit(200)
    .toArray();

  // Categories (distinct + counts)
  const allActive = await products
    .find({ isActive: true }, { projection: { category: 1 } })
    .toArray();
  const catMap = new Map<string, number>();
  for (const p of allActive) catMap.set(p.category, (catMap.get(p.category) || 0) + 1);
  const categories = [...catMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  res.json({ products: docs.map(publicProduct), categories });
});

// ── GET /products/:id ──────────────────────────────────────────────────────

router.get("/products/:id", async (req: Request, res: Response) => {
  const id = safeId(String(req.params["id"] ?? ""));
  if (!id) return res.status(400).json({ error: "Bad product id" });

  const products = await getCollection<ProductDoc>("products");
  const p = await products.findOne({ _id: id, isActive: true });
  if (!p) return res.status(404).json({ error: "Product not found" });

  // Resolve checkout fields: product override → catalog → parent catalog → null
  let resolvedFields: CheckoutFieldDef[] | null = null;
  if (p.checkoutFieldsOverride != null && Array.isArray(p.checkoutFieldsOverride)) {
    resolvedFields = p.checkoutFieldsOverride;
  } else if (p.catalogId) {
    const catalogs = await getCollection<CatalogDoc>("catalogs");
    const cat = await catalogs.findOne({ _id: p.catalogId });
    if (cat?.checkoutFields?.length) {
      resolvedFields = cat.checkoutFields;
    } else if (cat?.parentCategory) {
      const parent = await catalogs.findOne({ _id: cat.parentCategory });
      if (parent?.checkoutFields?.length) resolvedFields = parent.checkoutFields;
    }
  }

  return res.json({ ...publicProduct(p), checkoutFields: resolvedFields });
});

// ── GET /flashsale ─────────────────────────────────────────────────────────

router.get("/flashsale", async (_req: Request, res: Response) => {
  const products = await getCollection<ProductDoc>("products");
  const now = new Date();
  const docs = await products
    .find({
      isActive: true,
      flashSalePrice: { $gt: 0 },
      flashSaleStart: { $lte: now },
      flashSaleEnd: { $gte: now },
    })
    .limit(20)
    .toArray();
  res.json({ products: docs.map(publicProduct) });
});

// ── POST /orders ───────────────────────────────────────────────────────────
// body: { productId, checkoutData?, gameId?, zoneId?, quantity?, paymentMethod: "wallet" | "coin" }
// checkoutData: [{key, label, value}] — dynamic checkout fields from catalog
// gameId/zoneId kept for backward-compat with older Mini App clients

router.post("/orders", async (req: Request, res: Response) => {
  const u = asUser(req);
  const body = req.body as {
    productId?: string;
    checkoutData?: Array<{ key: string; label: string; value: string }>;
    gameId?: string;
    zoneId?: string;
    quantity?: number;
    promoCode?: string;
    paymentMethod?: "wallet" | "coin";
  };

  const pid = safeId(body.productId || "");
  if (!pid) return res.status(400).json({ error: "Bad product id" });

  const quantity = Math.max(1, Math.min(10, Number(body.quantity) || 1));

  const products = await getCollection<ProductDoc>("products");
  const catalogs = await getCollection<CatalogDoc>("catalogs");
  const product = await products.findOne({ _id: pid, isActive: true });
  if (!product) return res.status(404).json({ error: "Product not found" });
  if (!(product.stockCount === -1 || product.stockCount > 0)) {
    return res.status(409).json({ error: "Out of stock" });
  }

  // Block Mental Coins payment — wallet only
  if (body.paymentMethod === "coin") {
    return res.status(400).json({ error: "Mental Coins cannot be used for purchases" });
  }

  // ── Resolve checkout fields and validate required fields ──────────────────
  let checkoutFields: CheckoutFieldDef[] = [];
  if (product.checkoutFieldsOverride != null && Array.isArray(product.checkoutFieldsOverride)) {
    checkoutFields = product.checkoutFieldsOverride;
  } else if (product.catalogId) {
    const cat = await catalogs.findOne({ _id: product.catalogId });
    if (cat?.checkoutFields?.length) {
      checkoutFields = cat.checkoutFields;
    } else if (cat?.parentCategory) {
      // Inherit from parent catalog if sub-catalog has no fields set
      const parent = await catalogs.findOne({ _id: cat.parentCategory });
      checkoutFields = parent?.checkoutFields ?? [];
    }
  } else if (product.productType === "DirectTopup") {
    // Legacy: require gameId
    if (!body.gameId?.trim()) {
      return res.status(400).json({ error: "Game ID is required" });
    }
  }

  // Validate required checkout fields
  const submittedData = Array.isArray(body.checkoutData) ? body.checkoutData : [];
  const dataMap = new Map(submittedData.map((d) => [d.key, d.value?.trim() ?? ""]));

  for (const field of checkoutFields) {
    if (field.required) {
      const val = dataMap.get(field.key) ?? "";
      if (!val) {
        return res.status(400).json({ error: `${field.label} is required`, field: field.key });
      }
    }
  }

  // Build normalized checkoutData array (merge with legacy gameId/zoneId if needed)
  let checkoutData: Array<{ key: string; label: string; value: string }> = submittedData
    .filter((d) => d.key && d.value?.trim())
    .map((d) => ({ key: d.key, label: d.label || d.key, value: d.value.trim() }));

  // Backward compat: if no checkoutData but gameId provided, synthesize it
  if (!checkoutData.length && body.gameId?.trim()) {
    checkoutData = [{ key: "game_id", label: "Game ID", value: body.gameId.trim() }];
    if (body.zoneId?.trim()) {
      checkoutData.push({ key: "zone_id", label: "Zone ID", value: body.zoneId.trim() });
    }
  }

  // Resolve catalog name for order record
  let catalogName: string | null = null;
  if (product.catalogId) {
    const cat = await catalogs.findOne({ _id: product.catalogId }, { projection: { name: 1 } });
    catalogName = cat?.name ?? null;
  }

  const baseAmount = effectivePrice(product);
  const tierPct = tierDiscountPct(u.membershipTier);
  const tierDiscount = Math.round((baseAmount * tierPct) / 100);
  const unitFinalAmount = Math.max(0, baseAmount - tierDiscount);
  const totalFinalAmount = unitFinalAmount * quantity;

  const wallet: "KS" = "KS";
  const balanceField = "balanceKS";
  const currentBalance = u.balanceKS;

  const users = await getCollection<StoreUser>("users");
  const orders = await getCollection<OrderDoc>("orders");
  const txs = await getCollection<TxDoc>("transactions");
  const promos = await getCollection<PromoDoc>("promos");
  const now = new Date();
  const orderId = new ObjectId();

  // ── Promo code (optional) ───────────────────────────────────────────────────
  // Consume atomically BEFORE debiting so a race can never double-apply a code.
  let promoDiscount = 0;
  let promoCodeApplied: string | null = null;
  let consumedPromoId: ObjectId | null = null;
  const rawPromo = typeof body.promoCode === "string" ? body.promoCode.trim() : "";
  if (rawPromo) {
    const v = await validatePromo(rawPromo, u._id, totalFinalAmount);
    if (!v.valid || !v.promo) {
      return res.status(400).json({ error: v.error || "Invalid promo code" });
    }
    // Atomic consume — every rule (active, not-yet-used, max uses, expiry, min
    // order) is enforced in the filter itself so admin edits or races between
    // validate and consume cannot slip through.
    const consumed = await promos.findOneAndUpdate(
      {
        _id: v.promo._id,
        isActive: true,
        "usedBy.userId": { $ne: u._id },
        $and: [
          { $or: [{ restrictedToUserId: null }, { restrictedToUserId: { $exists: false } }, { restrictedToUserId: u._id }] },
        ],
        $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }],
        $expr: {
          $and: [
            {
              $or: [
                { $eq: [{ $ifNull: ["$maxUses", null] }, null] },
                { $lt: [{ $ifNull: ["$currentUses", 0] }, "$maxUses"] },
              ],
            },
            { $lte: [{ $ifNull: ["$minOrderAmount", 0] }, totalFinalAmount] },
          ],
        },
      },
      { $push: { usedBy: { userId: u._id, usedAt: now } }, $inc: { currentUses: 1 } },
      { returnDocument: "after" }
    );
    if (!consumed) {
      return res.status(409).json({ error: "Promo code is no longer available" });
    }
    // Recompute the discount from the authoritative post-consume document, not
    // the pre-consume validation snapshot, so the charged amount always matches
    // the promo's current value/type.
    promoDiscount = Math.min(calcPromoDiscount(consumed, totalFinalAmount), totalFinalAmount);
    promoCodeApplied = consumed.code;
    consumedPromoId = consumed._id;
  }

  const rollbackPromo = async (): Promise<void> => {
    if (!consumedPromoId) return;
    try {
      await promos.updateOne(
        { _id: consumedPromoId },
        { $pull: { usedBy: { userId: u._id } }, $inc: { currentUses: -1 } }
      );
    } catch {
      /* best effort */
    }
  };

  const payableAmount = Math.max(0, totalFinalAmount - promoDiscount);

  if (currentBalance < payableAmount) {
    await rollbackPromo();
    return res.status(402).json({
      error: "Not enough wallet balance",
      needed: payableAmount,
      balance: currentBalance,
    });
  }

  // Atomic debit: conditional update on balance prevents overspend race.
  const debited = await users.findOneAndUpdate(
    { _id: u._id, [balanceField]: { $gte: payableAmount } },
    { $inc: { [balanceField]: -payableAmount }, $set: { lastActive: now } },
    { returnDocument: "after" }
  );
  if (!debited) {
    await rollbackPromo();
    return res.status(402).json({ error: "Balance changed, please retry" });
  }
  const balanceAfter = debited.balanceKS;
  const balanceBefore = balanceAfter + payableAmount;

  // Legacy gameId/zoneId: extract from checkoutData for backward-compat fields
  const legacyGameId = checkoutData.find((d) => d.key === "game_id")?.value
    ?? body.gameId?.trim()
    ?? null;
  const legacyZoneId = checkoutData.find((d) => d.key === "zone_id")?.value
    ?? body.zoneId?.trim()
    ?? null;

  const unitPrice = baseAmount;

  const orderDoc: OrderDoc = {
    _id: orderId,
    userId: u._id,
    productId: product._id,
    amount: payableAmount,
    originalAmount: baseAmount * quantity,
    tierDiscount: tierDiscount * quantity,
    tierDiscountPct: tierPct,
    promoCode: promoCodeApplied,
    promoDiscount,
    status: "Pending",
    productType: product.productType,
    gameId: legacyGameId,
    zoneId: legacyZoneId,
    gameName: product.name,
    catalogId: product.catalogId ?? null,
    catalogName,
    quantity,
    unitPrice,
    checkoutData,
    timestamp: now,
    notes: "Placed via Mini App",
  };

  try {
    await orders.insertOne(orderDoc);
    await txs.insertOne({
      _id: new ObjectId(),
      userId: u._id,
      type: "Purchase",
      wallet,
      amount: -payableAmount,
      balanceBefore,
      balanceAfter,
      status: "Completed",
      paymentMethod: null,
      description: `Order ${orderId.toString()} — ${product.name}${quantity > 1 ? ` x${quantity}` : ""}${promoCodeApplied ? ` (promo ${promoCodeApplied})` : ""}`,
      createdAt: now,
      timestamp: now,
    });

    // Decrement stock to match the bot's OrderService (mini-app data parity).
    // Guarded so it can never drive stockCount below zero.
    if (product.stockCount !== -1) {
      await products.updateOne(
        { _id: product._id, stockCount: { $gt: 0 } },
        { $inc: { stockCount: -1 } },
      );
    }
  } catch (err) {
    // Compensating refund — keep wallet whole if order/tx writes fail.
    try {
      await users.updateOne(
        { _id: u._id },
        { $inc: { [balanceField]: payableAmount } }
      );
      await orders.deleteOne({ _id: orderId }).catch(() => {});
      await rollbackPromo();
    } catch {
      /* best effort */
    }
    // Re-throw so the global error handler logs it and the client sees 500.
    throw err;
  }

  // Touch client only for connection liveness check (no-op if already there).
  void getClient();

  return res.json({
    orderId: orderId.toString(),
    amount: payableAmount,
    promoDiscount,
    promoCode: promoCodeApplied,
    status: "Pending",
  });
});

// ── GET /orders ────────────────────────────────────────────────────────────

router.get("/orders", async (req: Request, res: Response) => {
  const u = asUser(req);
  const orders = await getCollection<OrderDoc>("orders");
  const filter: Filter<OrderDoc> = { userId: u._id };
  const statusQ = req.query["status"];
  const status = typeof statusQ === "string" ? statusQ : "";
  if (["Pending", "Processing", "Success", "Cancelled", "Refunded"].includes(status)) {
    filter.status = status as OrderDoc["status"];
  }

  const docs = await orders
    .find(filter)
    .sort({ timestamp: -1 })
    .limit(50)
    .toArray();

  const productIds = [...new Set(docs.map((o) => o.productId.toString()))]
    .map((s) => new ObjectId(s));
  const products = await getCollection<ProductDoc>("products");
  const pDocs = productIds.length
    ? await products
        .find({ _id: { $in: productIds } }, { projection: { name: 1, category: 1, imageUrl: 1 } })
        .toArray()
    : [];
  const pMap = new Map(pDocs.map((p) => [p._id.toString(), p]));

  res.json({
    orders: docs.map((o) => ({
      id: o._id.toString(),
      shortId: o._id.toString().slice(-6).toUpperCase(),
      productName: pMap.get(o.productId.toString())?.name || o.gameName || "Order",
      productImage: pMap.get(o.productId.toString())?.imageUrl || null,
      amount: o.amount,
      status: o.status,
      gameId: o.gameId,
      zoneId: o.zoneId,
      timestamp: o.timestamp,
    })),
  });
});

// ── GET /orders/:id ────────────────────────────────────────────────────────

router.get("/orders/:id", async (req: Request, res: Response) => {
  const u = asUser(req);
  const id = safeId(String(req.params["id"] ?? ""));
  if (!id) return res.status(400).json({ error: "Bad order id" });

  const orders = await getCollection<OrderDoc>("orders");
  const o = await orders.findOne({ _id: id, userId: u._id });
  if (!o) return res.status(404).json({ error: "Order not found" });

  const products = await getCollection<ProductDoc>("products");
  const p = await products.findOne({ _id: o.productId });

  return res.json({
    id: o._id.toString(),
    shortId: o._id.toString().slice(-6).toUpperCase(),
    product: p ? publicProduct(p) : null,
    amount: o.amount,
    originalAmount: o.originalAmount,
    tierDiscount: o.tierDiscount,
    status: o.status,
    gameId: o.gameId,
    zoneId: o.zoneId,
    timestamp: o.timestamp,
    notes: o.notes,
  });
});

// ── GET /wallet ────────────────────────────────────────────────────────────

router.get("/wallet", async (req: Request, res: Response) => {
  const u = asUser(req);
  const txs = await getCollection<TxDoc>("transactions");
  const docs = await txs
    .find({ userId: u._id })
    .sort({ createdAt: -1, timestamp: -1 })
    .limit(30)
    .toArray();

  res.json({
    balanceKS: u.balanceKS,
    balanceCoin: u.balanceCoin,
    tier: u.membershipTier,
    totalDeposited: u.totalDeposited,
    history: docs.map((t: WithId<TxDoc>) => ({
      id: t._id.toString(),
      type: t.type,
      wallet: t.wallet,
      amount: t.amount,
      status: t.status,
      paymentMethod: t.paymentMethod,
      description: t.description || null,
      at: t.createdAt || t.timestamp || null,
    })),
  });
});

// ── POST /topups ───────────────────────────────────────────────────────────
// multipart/form-data: { amount, paymentMethod, screenshot (file) }
// Forwards screenshot to admin via Bot API (gets a Telegram file_id), then
// creates a Pending Topup transaction matching the bot's own format. Admin
// approval is handled by the existing bot `topup_approve:<txId>` callback.

router.post(
  "/topups",
  upload.single("screenshot"),
  async (req: Request, res: Response) => {
    const u = asUser(req);
    const body = req.body as {
      amount?: string | number;
      paymentMethod?: string;
    };
    const file = req.file;

    const amount = Number(body.amount);
    const methodRaw = String(body.paymentMethod || "").trim();
    const shortCode = shortCodeFor(methodRaw);

    if (!Number.isFinite(amount) || amount < 1000) {
      return res.status(400).json({ error: "Minimum top-up is 1,000 KS" });
    }
    if (amount > 5_000_000) {
      return res
        .status(400)
        .json({ error: "Maximum top-up is 5,000,000 KS. Contact support." });
    }
    if (!["KPAY", "WAVE", "AYA", "CB"].includes(shortCode)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }
    if (!file) {
      return res.status(400).json({ error: "Payment screenshot is required" });
    }

    // Gateway control — block top-ups for gateways the admin has set Offline.
    // Reads the SHARED `systemstatuses` singleton (same as bot enforcement).
    {
      const statusColl = await getCollection<{
        _id: string;
        kpayStatus?: string;
        waveStatus?: string;
        ayaStatus?: string;
        cbStatus?: string;
        gatewayNote?: string | null;
      }>("systemstatuses");
      const st = await statusColl.findOne({ _id: "global" });
      const gwField: Record<string, "kpayStatus" | "waveStatus" | "ayaStatus" | "cbStatus"> = {
        KPAY: "kpayStatus",
        WAVE: "waveStatus",
        AYA: "ayaStatus",
        CB: "cbStatus",
      };
      const gwStatus = st?.[gwField[shortCode]] ?? "Online";
      if (gwStatus === "Offline") {
        return res.status(409).json({
          error:
            st?.gatewayNote ||
            `${shortCode} payments are temporarily unavailable. Please try another method.`,
        });
      }
    }

    const admin = adminChatId();
    if (!admin) {
      logger.error("ADMIN_ID is not configured — cannot forward top-up proof");
      return res
        .status(500)
        .json({ error: "Payment proof routing not configured" });
    }

    const txs = await getCollection<TxDoc>("transactions");

    // Prevent multiple pending top-ups per user (matches bot behaviour).
    const pending = await txs.findOne({
      userId: u._id,
      type: "Topup",
      status: "Pending",
    });
    if (pending) {
      return res.status(409).json({
        error:
          "You already have a pending top-up. Wait for it to be processed.",
      });
    }

    // Forward photo to admin first — Telegram returns a stable file_id we
    // store on the tx. Hash of the file_id is the fraud fingerprint.
    let fileId: string;
    let adminMessageId: number | null = null;
    try {
      const txIdPreview = "TX" + crypto.randomBytes(6).toString("hex").toUpperCase();
      const caption =
        `🆕 *Mini App Top-Up Request*\n\n` +
        `👤 User: ${u.first_name || u.username || u.telegramId} ` +
        `(\`${u.telegramId}\`)\n` +
        `💰 Amount: *${amount.toLocaleString()} KS*\n` +
        `💳 Method: *${shortCode}*\n` +
        `🧾 Ref: \`${txIdPreview}\`\n\n` +
        `_Tap a button below to process._`;

      const sent = await sendPhoto({
        chatId: admin,
        photo: file.buffer,
        filename: file.originalname || "screenshot.jpg",
        contentType: file.mimetype,
        caption,
        parseMode: "Markdown",
        inlineKeyboard: [
          [{ text: "✅ Approve", callback_data: `topup_approve:${txIdPreview}` }],
          [{ text: "❌ Reject", callback_data: `topup_reject:${txIdPreview}` }],
          [
            {
              text: "💬 Ask for Info",
              callback_data: `topup_askinfo:${txIdPreview}`,
            },
          ],
        ],
      });
      fileId = sent.fileId;
      adminMessageId = sent.messageId;

      // Duplicate / fraud check using Telegram's file_id (same logic as bot).
      const hash = md5Hex(fileId);
      const existing = await txs.findOne({
        $or: [{ screenshotUrl: fileId }, { screenshotHash: hash }],
      });
      if (existing) {
        const sameUser = existing.userId.toString() === u._id.toString();
        return res.status(409).json({
          error: sameUser
            ? "You've already submitted this exact screenshot."
            : "This screenshot was already used. Admin has been notified.",
        });
      }

      const now = new Date();
      await txs.insertOne({
        _id: new ObjectId(),
        userId: u._id,
        type: "Topup",
        wallet: "KS",
        amount,
        balanceBefore: u.balanceKS,
        balanceAfter: u.balanceKS,
        status: "Pending",
        paymentMethod: shortCode,
        screenshotUrl: fileId,
        screenshotHash: hash,
        txId: txIdPreview,
        note: "Awaiting admin approval (Mini App)",
        createdAt: now,
        timestamp: now,
      });

      return res.json({
        requestId: txIdPreview,
        txId: txIdPreview,
        status: "Pending",
        message:
          "Top-up request submitted! An admin will review your screenshot — usually within minutes.",
      });
    } catch (err) {
      logger.error(
        { err, adminMessageId },
        "Failed to forward top-up screenshot"
      );
      return res
        .status(502)
        .json({ error: "Could not deliver screenshot to admin. Please retry." });
    }
  }
);

// ── GET /payment-methods ───────────────────────────────────────────────────

router.get("/payment-methods", async (_req: Request, res: Response) => {
  type PMDoc = {
    _id: ObjectId;
    name: string;
    shortCode: string;
    accountName: string;
    accountNumber: string;
    emoji?: string;
    isActive: boolean;
    displayOrder?: number;
  };
  const pms = await getCollection<PMDoc>("paymentmethods");
  const statusColl = await getCollection<{
    _id: string;
    kpayStatus?: string;
    waveStatus?: string;
    ayaStatus?: string;
    cbStatus?: string;
    gatewayNote?: string | null;
  }>("systemstatuses");
  const [docs, st] = await Promise.all([
    pms.find({ isActive: true }).sort({ displayOrder: 1, name: 1 }).toArray(),
    statusColl.findOne({ _id: "global" }),
  ]);
  const gwField: Record<string, "kpayStatus" | "waveStatus" | "ayaStatus" | "cbStatus"> = {
    KPAY: "kpayStatus",
    WAVE: "waveStatus",
    AYA: "ayaStatus",
    CB: "cbStatus",
  };
  res.json({
    note: st?.gatewayNote ?? null,
    methods: docs.map((m) => {
      const field = gwField[(m.shortCode || "").toUpperCase()];
      const status = (field ? st?.[field] : undefined) ?? "Online";
      return {
        id: m._id.toString(),
        label: m.name,
        shortCode: m.shortCode,
        emoji: m.emoji || "💳",
        accountName: m.accountName,
        accountNumber: m.accountNumber,
        status,
      };
    }),
  });
});

// ── GET /banners ───────────────────────────────────────────────────────────

router.get("/banners", async (_req: Request, res: Response) => {
  const banners = await getCollection<BannerDoc>("banners");
  const now = new Date();
  const docs = await banners
    .find({
      isActive: true,
      $or: [{ startAt: null }, { startAt: { $lte: now } }],
    })
    .sort({ priority: -1, createdAt: -1 })
    .limit(10)
    .toArray();

  const activeDocs = docs.filter(
    (b) => !b.endAt || new Date(b.endAt) >= now
  );

  res.json({
    banners: activeDocs.map((b) => ({
      id: b._id.toString(),
      title: b.title,
      subtitle: b.subtitle,
      imageUrl: b.imageUrl,
      targetType: b.targetType,
      targetId: b.targetId,
      buttonText: b.buttonText,
      endAt: b.endAt,
      priority: b.priority,
    })),
  });
});

// ── GET /notifications ─────────────────────────────────────────────────────

router.get("/notifications", async (req: Request, res: Response) => {
  const u = asUser(req);
  const notifs = await getCollection<NotificationDoc>("notifications");
  const docs = await notifs
    .find({ telegramId: u.telegramId })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  const unreadCount = docs.filter((n) => !n.isRead).length;

  res.json({
    unreadCount,
    notifications: docs.map((n) => ({
      id: n._id.toString(),
      type: n.type,
      title: n.title,
      body: n.body,
      imageUrl: n.imageUrl,
      targetType: n.targetType,
      targetId: n.targetId,
      isRead: n.isRead,
      at: n.createdAt ?? null,
    })),
  });
});

// ── PATCH /notifications/:id/read ──────────────────────────────────────────

router.patch("/notifications/:id/read", async (req: Request, res: Response) => {
  const u = asUser(req);
  const id = safeId(String(req.params["id"] ?? ""));
  if (!id) { res.status(400).json({ error: "Bad id" }); return; }

  const notifs = await getCollection<NotificationDoc>("notifications");
  await notifs.updateOne(
    { _id: id, telegramId: u.telegramId },
    { $set: { isRead: true, readAt: new Date() } }
  );
  res.json({ ok: true });
});

// ── PATCH /notifications/read-all ─────────────────────────────────────────

router.patch("/notifications/read-all", async (req: Request, res: Response) => {
  const u = asUser(req);
  const notifs = await getCollection<NotificationDoc>("notifications");
  await notifs.updateMany(
    { telegramId: u.telegramId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  res.json({ ok: true });
});

// ── GET /popular ───────────────────────────────────────────────────────────

router.get("/popular", async (_req: Request, res: Response) => {
  const orders = await getCollection("orders");
  const products = await getCollection<ProductDoc>("products");

  // Trending: most completed orders in last 30 days
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const topProductIds = await orders
    .aggregate<{ _id: ObjectId; count: number }>([
      { $match: { status: "Success", timestamp: { $gte: since } } },
      { $group: { _id: "$productId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ])
    .toArray();

  const ids = topProductIds.map((r) => r._id).filter(Boolean);
  const popularDocs = ids.length
    ? await products
        .find({ _id: { $in: ids }, isActive: true, status: { $ne: "hidden" } })
        .toArray()
    : [];

  // Preserve order
  const idStrOrder = ids.map((i) => i.toString());
  popularDocs.sort(
    (a, b) => idStrOrder.indexOf(a._id.toString()) - idStrOrder.indexOf(b._id.toString())
  );

  // Recently purchased: latest successful orders (last 7 days, unique products)
  const recentSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentProductIds = await orders
    .aggregate<{ _id: ObjectId }>([
      { $match: { status: "Success", timestamp: { $gte: recentSince } } },
      { $group: { _id: "$productId" } },
      { $limit: 10 },
    ])
    .toArray();

  const recentIds = recentProductIds.map((r) => r._id).filter(Boolean);
  const recentDocs = recentIds.length
    ? await products
        .find({ _id: { $in: recentIds }, isActive: true, status: { $ne: "hidden" } })
        .toArray()
    : [];

  res.json({
    popular: popularDocs.map(publicProduct),
    recent: recentDocs.map(publicProduct),
  });
});

// ── GET /feature-gates ─────────────────────────────────────────────────────

const GATED_FEATURES = [
  "referral",
  "tier",
  "mental_coin",
  "mc_exchange",
  "lucky_spin",
  "leaderboard",
  "achievements",
  "daily_missions",
  "weekly_missions",
  "yearly_rewards",
] as const;

router.get("/feature-gates", async (_req: Request, res: Response) => {
  const statusColl = await getCollection<SystemStatusDoc>("systemstatuses");
  const users = await getCollection("users");

  const [status, totalUsers] = await Promise.all([
    statusColl.findOne({ _id: "global" }),
    users.countDocuments({}),
  ]);

  const gateEnabled = status?.featureGateEnabled ?? true;
  const target = status?.unlockTargetUsers ?? 500;
  const unlocked = status?.manuallyUnlockedFeatures ?? [];
  const locked = status?.manuallyLockedFeatures ?? [];

  const allUnlocked = !gateEnabled || totalUsers >= target;

  const gates: Record<string, boolean> = {};
  for (const f of GATED_FEATURES) {
    if (locked.includes(f)) {
      gates[f] = false;
    } else if (unlocked.includes(f)) {
      gates[f] = true;
    } else {
      gates[f] = allUnlocked;
    }
  }

  res.json({
    totalUsers,
    unlockTarget: target,
    allUnlocked,
    gates,
  });
});

// ── GET /mc/config ─────────────────────────────────────────────────────────

router.get("/mc/config", async (_req: Request, res: Response) => {
  const statusColl = await getCollection<SystemStatusDoc>("systemstatuses");
  const status = await statusColl.findOne({ _id: "global" });
  res.json({
    enabled: status?.mcRedeemEnabled ?? false,
    exchangeRate: status?.mcExchangeRate ?? 1,
    minRedeem: status?.mcMinRedeem ?? 500,
    maxDiscountPct: status?.mcMaxDiscountPct ?? 20,
  });
});

// ── POST /mc/exchange ──────────────────────────────────────────────────────
// body: { mcAmount } — returns maxDiscount (KS) user would get

router.post("/mc/exchange", async (req: Request, res: Response) => {
  const u = asUser(req);
  const body = req.body as { mcAmount?: number };
  const mcAmount = Math.floor(Number(body.mcAmount) || 0);

  if (mcAmount <= 0) {
    return res.status(400).json({ error: "Invalid MC amount" });
  }

  const statusColl = await getCollection<SystemStatusDoc>("systemstatuses");
  const status = await statusColl.findOne({ _id: "global" });

  if (!status?.mcRedeemEnabled) {
    return res.status(403).json({ error: "MC Exchange is not enabled" });
  }
  const minRedeem = status.mcMinRedeem ?? 500;
  const exchangeRate = status.mcExchangeRate ?? 1;

  if (mcAmount < minRedeem) {
    return res.status(400).json({ error: `Minimum MC to redeem is ${minRedeem}` });
  }
  if (u.balanceCoin < mcAmount) {
    return res.status(400).json({ error: "Insufficient Mental Coins" });
  }

  const ksDiscount = Math.floor(mcAmount * exchangeRate);
  return res.json({ mcAmount, ksDiscount, exchangeRate });
});

export default router;
