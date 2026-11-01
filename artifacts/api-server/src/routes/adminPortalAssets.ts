import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { GridFSBucket, ObjectId } from "mongodb";
import { getCollection, getDb } from "../lib/mongodb";
import { logger } from "../lib/logger";
import { adminProductServiceAuth } from "../middlewares/adminProductServiceAuth";

interface PortalCatalogDoc {
  _id: ObjectId;
  name: string;
  imageUrl?: string | null;
  sortOrder?: number;
  isActive: boolean;
  parentCategory?: ObjectId | null;
}

interface PortalProductDoc {
  _id: ObjectId;
  category: string;
  catalogId?: ObjectId | null;
}

const STORE_ORIGIN = "https://mental-gaming-store.vercel.app";
const MAX_IMAGE_BYTES = 900 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const router = Router();

function validHttpsImageUrl(value: string): boolean {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function countProductsByCatalog(
  catalogs: PortalCatalogDoc[],
  products: PortalProductDoc[],
): Map<string, number> {
  const catalogIds = new Set(catalogs.map((catalog) => catalog._id.toString()));
  const idsByName = new Map<string, string[]>();
  for (const catalog of catalogs) {
    const ids = idsByName.get(catalog.name) ?? [];
    ids.push(catalog._id.toString());
    idsByName.set(catalog.name, ids);
  }
  const counts = new Map<string, number>();
  for (const product of products) {
    const linkedId = product.catalogId?.toString();
    const matchingIds = idsByName.get(product.category) ?? [];
    const targetId = linkedId && catalogIds.has(linkedId)
      ? linkedId
      : matchingIds.length === 1 ? matchingIds[0] : undefined;
    if (targetId) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  return counts;
}

async function listPortalCatalogs(_req: Request, res: Response): Promise<void> {
  try {
    const catalogsCollection = await getCollection<PortalCatalogDoc>("catalogs");
    const productsCollection = await getCollection<PortalProductDoc>("products");
    const [catalogs, products] = await Promise.all([
      catalogsCollection.find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
      productsCollection.find({}, { projection: { category: 1, catalogId: 1 } }).toArray(),
    ]);
    const counts = countProductsByCatalog(catalogs, products);
    const byParent = new Map<string, PortalCatalogDoc[]>();
    for (const catalog of catalogs) {
      const parent = catalog.parentCategory?.toString();
      if (!parent) continue;
      const children = byParent.get(parent) ?? [];
      children.push(catalog);
      byParent.set(parent, children);
    }
    const toItem = (catalog: PortalCatalogDoc) => ({
      id: catalog._id.toString(),
      name: catalog.name,
      imageUrl: catalog.imageUrl ?? null,
      sortOrder: catalog.sortOrder ?? 0,
      isActive: catalog.isActive,
      parentCategoryId: catalog.parentCategory?.toString() ?? null,
      productCount: counts.get(catalog._id.toString()) ?? 0,
    });
    res.setHeader("Cache-Control", "no-store").json({
      catalogs: catalogs
        .filter((catalog) => !catalog.parentCategory)
        .map((catalog) => ({
          ...toItem(catalog),
          subCatalogs: (byParent.get(catalog._id.toString()) ?? []).map(toItem),
        })),
    });
  } catch (err) {
    logger.error({ err }, "admin portal catalog list error");
    res.status(500).json({ error: "Could not load catalogs" });
  }
}

async function updatePortalCatalog(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params["id"] ?? "");
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid catalog id" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (!Object.hasOwn(body, "imageUrl")) {
      res.status(400).json({ error: "Image URL is required" });
      return;
    }
    const rawImageUrl = body["imageUrl"];
    if (rawImageUrl !== null && typeof rawImageUrl !== "string") {
      res.status(400).json({ error: "Invalid image URL" });
      return;
    }
    const imageUrl = typeof rawImageUrl === "string" ? rawImageUrl.trim() : "";
    if (imageUrl.length > 2048 || !validHttpsImageUrl(imageUrl)) {
      res.status(400).json({ error: "Invalid image URL" });
      return;
    }
    const catalogs = await getCollection<PortalCatalogDoc>("catalogs");
    const result = await catalogs.updateOne(
      { _id: new ObjectId(id) },
      { $set: { imageUrl: imageUrl || null } },
    );
    if (!result.matchedCount) {
      res.status(404).json({ error: "Catalog not found" });
      return;
    }
    res.json({ ok: true, imageUrl: imageUrl || null });
  } catch (err) {
    logger.error({ err }, "admin portal catalog update error");
    res.status(500).json({ error: "Could not update catalog" });
  }
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

async function uploadPortalImage(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const dataBase64 = body["dataBase64"];
    if (
      body["contentType"] !== "image/webp" ||
      typeof dataBase64 !== "string" ||
      dataBase64.length === 0 ||
      dataBase64.length > MAX_BASE64_CHARS ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)
    ) {
      res.status(400).json({ error: "A valid compressed WebP image is required" });
      return;
    }
    const buffer = Buffer.from(dataBase64, "base64");
    if (
      buffer.length === 0 ||
      buffer.length > MAX_IMAGE_BYTES ||
      buffer.toString("base64") !== dataBase64 ||
      !isWebp(buffer)
    ) {
      res.status(400).json({ error: "Invalid image data or image size" });
      return;
    }

    const bucket = new GridFSBucket(await getDb(), { bucketName: "adminImages" });
    const filename = `mg-${randomBytes(16).toString("hex")}.webp`;
    const upload = bucket.openUploadStream(filename, {
      metadata: { contentType: "image/webp", purpose: "store-catalog-image" },
    });
    await new Promise<void>((resolve, reject) => {
      upload.once("error", reject);
      upload.once("finish", resolve);
      upload.end(buffer);
    });
    const id = (upload.id as ObjectId).toString();
    const imageUrl = `${STORE_ORIGIN}/api/store/media/${id}`;
    res.status(201).json({ ok: true, id, imageUrl });
  } catch (err) {
    logger.error({ err }, "admin portal image upload error");
    res.status(500).json({ error: "Could not save image" });
  }
}

router.get("/catalogs", adminProductServiceAuth, (req, res) => void listPortalCatalogs(req, res));
router.patch("/catalogs/:id", adminProductServiceAuth, (req, res) => void updatePortalCatalog(req, res));
router.post("/media", adminProductServiceAuth, (req, res) => void uploadPortalImage(req, res));

export default router;
