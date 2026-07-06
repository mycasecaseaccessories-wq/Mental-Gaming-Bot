/**
 * FAQ routes — public, read-only help library.
 * Reads the same `faqs` collection the bot owns (seeded/edited by admins in the
 * bot), so both surfaces show identical help content. No auth required: FAQ is
 * public help content.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import type { Filter, Sort } from "mongodb";
import { getCollection } from "../lib/mongodb";

interface FaqDoc {
  faqId: string;
  question: string;
  answer: string;
  tags: string[];
  category: string;
  videoId: string | null;
  videoType: "telegram" | "url" | null;
  videoCaption: string | null;
  isActive: boolean;
  viewCount: number;
  sortOrder: number;
}

const router: IRouter = Router();

function pub(f: FaqDoc) {
  return {
    faqId: f.faqId,
    question: f.question,
    answer: f.answer,
    tags: f.tags ?? [],
    category: f.category ?? "general",
    // Telegram file_ids can't play in the web app; only surface real URLs.
    videoUrl: f.videoType === "url" ? f.videoId : null,
    videoCaption: f.videoCaption ?? null,
    viewCount: f.viewCount ?? 0,
  };
}

// ── GET /faqs?category=&q= ──────────────────────────────────────────────────
router.get("/faqs", async (req: Request, res: Response) => {
  const col = await getCollection<FaqDoc>("faqs");
  const category = typeof req.query["category"] === "string" ? req.query["category"].trim() : "";
  const q = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";

  // Search mode (mirrors bot FAQService.search: text index first, regex fallback).
  if (q && q.length >= 2) {
    let docs: FaqDoc[] = await col
      .find({ $text: { $search: q }, isActive: true } as Filter<FaqDoc>, {
        projection: { score: { $meta: "textScore" } },
      })
      .sort({ score: { $meta: "textScore" } } as unknown as Sort)
      .limit(12)
      .toArray()
      .catch(() => [] as FaqDoc[]);

    if (!docs.length) {
      docs = await col
        .find({
          isActive: true,
          $or: [
            { question: { $regex: q, $options: "i" } },
            { answer: { $regex: q, $options: "i" } },
            { tags: { $in: [q.toLowerCase()] } },
          ],
        })
        .sort({ viewCount: -1 })
        .limit(12)
        .toArray();
    }
    res.json({ faqs: docs.map(pub) });
    return;
  }

  const filter: Filter<FaqDoc> = { isActive: true };
  if (category) filter.category = category;
  const docs = await col
    .find(filter)
    .sort({ category: 1, sortOrder: 1, viewCount: -1 })
    .toArray();
  res.json({ faqs: docs.map(pub) });
});

// ── POST /faqs/:faqId/view ──────────────────────────────────────────────────
router.post("/faqs/:faqId/view", async (req: Request, res: Response) => {
  const faqId = String(req.params["faqId"] ?? "");
  if (!faqId) {
    res.status(400).json({ error: "Bad faqId" });
    return;
  }
  const col = await getCollection<FaqDoc>("faqs");
  await col.updateOne({ faqId }, { $inc: { viewCount: 1 } });
  res.json({ ok: true });
});

export default router;
