import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectId, type Filter } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";

// Mirrors the bot's AddressBook model (collection: addressbooks) + AddressBookService rules.
interface AddressDoc {
  _id: ObjectId;
  userId: ObjectId;
  gameName: string;
  gameId: string;
  zoneId: string | null;
  nickname: string | null;
  isDefault: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const MAX_PER_GAME = 5;

const router: IRouter = Router();
router.use(telegramAuth);

function pub(a: AddressDoc) {
  return {
    id: a._id.toString(),
    gameName: a.gameName,
    gameId: a.gameId,
    zoneId: a.zoneId ?? null,
    nickname: a.nickname ?? null,
    isDefault: !!a.isDefault,
  };
}

// ── GET /addresses?gameName= ────────────────────────────────────────────────
router.get("/addresses", async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const col = await getCollection<AddressDoc>("addressbooks");
  const filter: Filter<AddressDoc> = { userId: u._id };
  const gn = req.query["gameName"];
  if (typeof gn === "string" && gn.trim()) {
    filter.gameName = { $regex: gn.trim(), $options: "i" };
  }
  const docs = await col.find(filter).sort({ isDefault: -1, createdAt: -1 }).toArray();
  res.json({ addresses: docs.map(pub) });
});

// ── POST /addresses ─────────────────────────────────────────────────────────
router.post("/addresses", async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const body = req.body as {
    gameName?: string;
    gameId?: string;
    zoneId?: string;
    nickname?: string;
    setDefault?: boolean;
  };
  const gameName = (body.gameName ?? "").trim();
  const gameId = (body.gameId ?? "").trim();
  if (!gameName || !gameId) {
    res.status(400).json({ error: "Game name and ID are required" });
    return;
  }
  const zoneId = body.zoneId?.trim() ? body.zoneId.trim() : null;
  const nickname = body.nickname?.trim() ? body.nickname.trim() : gameId;

  const col = await getCollection<AddressDoc>("addressbooks");
  const existing = await col.find({ userId: u._id, gameName }).toArray();
  if (existing.length >= MAX_PER_GAME) {
    res.status(409).json({
      error: `You can save up to ${MAX_PER_GAME} IDs per game. Delete one first.`,
    });
    return;
  }
  const makeDefault = body.setDefault === true || existing.length === 0;
  if (makeDefault) {
    await col.updateMany({ userId: u._id, gameName }, { $set: { isDefault: false } });
  }
  const now = new Date();
  const doc: AddressDoc = {
    _id: new ObjectId(),
    userId: u._id,
    gameName,
    gameId,
    zoneId,
    nickname,
    isDefault: makeDefault,
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(doc);
  res.json({ address: pub(doc) });
});

// ── DELETE /addresses/:id ───────────────────────────────────────────────────
router.delete("/addresses/:id", async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const idStr = String(req.params["id"] ?? "");
  if (!ObjectId.isValid(idStr)) {
    res.status(400).json({ error: "Bad id" });
    return;
  }
  const col = await getCollection<AddressDoc>("addressbooks");
  const del = await col.findOneAndDelete({ _id: new ObjectId(idStr), userId: u._id });
  if (!del) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  res.json({ ok: true });
});

// ── PATCH /addresses/:id/default ────────────────────────────────────────────
router.patch("/addresses/:id/default", async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const idStr = String(req.params["id"] ?? "");
  if (!ObjectId.isValid(idStr)) {
    res.status(400).json({ error: "Bad id" });
    return;
  }
  const col = await getCollection<AddressDoc>("addressbooks");
  const entry = await col.findOne({ _id: new ObjectId(idStr), userId: u._id });
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  await col.updateMany({ userId: u._id, gameName: entry.gameName }, { $set: { isDefault: false } });
  await col.updateOne({ _id: entry._id }, { $set: { isDefault: true } });
  res.json({ ok: true });
});

export default router;
