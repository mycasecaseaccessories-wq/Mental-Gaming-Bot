/**
 * Support routes — create & view support tickets.
 * Writes to the same MongoDB collection the bot uses, so bot agents see
 * Mini App tickets natively and can reply directly.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectId } from "mongodb";
import { getCollection } from "../lib/mongodb";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";

const router: IRouter = Router();
router.use(telegramAuth);

function asUser(req: Request): StoreUser {
  return req.storeUser as StoreUser;
}

interface SupportMessage {
  from: "admin" | "user";
  message: string;
  adminId?: number | null;
  at?: Date;
}

interface TicketDoc {
  _id: ObjectId;
  userId: ObjectId;
  ticketId: string;
  topic: string;
  subject: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: "Normal" | "High" | "Urgent";
  messages: SupportMessage[];
  assignedAdmin?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function makeTicketId(): string {
  const rand = Array.from({ length: 4 }, () =>
    "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]
  ).join("");
  return `TKT-${rand}`;
}

// GET /support/tickets
router.get("/tickets", async (req: Request, res: Response) => {
  const u = asUser(req);
  const tickets = await getCollection<TicketDoc>("supporttickets");
  const docs = await tickets
    .find({ userId: u._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  res.json({
    tickets: docs.map((t) => ({
      id: t._id.toString(),
      ticketId: t.ticketId,
      topic: t.topic,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      lastMessage: t.messages.at(-1)?.message?.slice(0, 80) ?? null,
      messageCount: t.messages.length,
      hasAdminReply: t.messages.some((m) => m.from === "admin"),
      at: t.createdAt ?? null,
    })),
  });
});

// POST /support/tickets
// body: { topic, subject, message }
router.post("/tickets", async (req: Request, res: Response) => {
  const u = asUser(req);
  const body = req.body as { topic?: string; subject?: string; message?: string };
  const topic = String(body.topic || "general").slice(0, 30);
  const message = String(body.message || "").trim();
  const subject = String(body.subject || message).slice(0, 80);

  if (!message || message.length < 5) {
    return res.status(400).json({ error: "Message must be at least 5 characters" });
  }

  const tickets = await getCollection<TicketDoc>("supporttickets");

  // Prevent spam: max 1 open ticket
  const open = await tickets.findOne({ userId: u._id, status: { $in: ["open", "in_progress"] } });
  if (open) {
    return res.status(409).json({
      error: "You already have an open ticket. Please wait for a reply before opening another.",
      existingTicketId: open.ticketId,
    });
  }

  const now = new Date();
  const ticketId = makeTicketId();
  const doc: TicketDoc = {
    _id: new ObjectId(),
    userId: u._id,
    ticketId,
    topic,
    subject,
    status: "open",
    priority: "Normal",
    messages: [{ from: "user", message, at: now }],
    createdAt: now,
    updatedAt: now,
  };
  await tickets.insertOne(doc);

  return res.status(201).json({
    id: doc._id.toString(),
    ticketId,
    message: `Ticket ${ticketId} created. Our team will respond soon.`,
  });
});

// GET /support/tickets/:id
router.get("/tickets/:id", async (req: Request, res: Response) => {
  const u = asUser(req);
  const raw = String(req.params["id"] ?? "");
  const tickets = await getCollection<TicketDoc>("supporttickets");

  // Accept both MongoDB _id and ticketId (TKT-XXXX)
  const query = ObjectId.isValid(raw)
    ? { _id: new ObjectId(raw), userId: u._id }
    : { ticketId: raw.toUpperCase(), userId: u._id };

  const t = await tickets.findOne(query);
  if (!t) return res.status(404).json({ error: "Ticket not found" });

  return res.json({
    id: t._id.toString(),
    ticketId: t.ticketId,
    topic: t.topic,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    messages: t.messages.map((m) => ({
      from: m.from,
      message: m.message,
      at: m.at ?? null,
    })),
    at: t.createdAt ?? null,
  });
});

// POST /support/ai-chat — quick AI answer before creating a ticket
router.post("/ai-chat", async (req: Request, res: Response) => {
  const u = asUser(req);
  const body = req.body as { message?: string };
  const message = String(body.message || "").trim();

  if (!message || message.length < 2) {
    return res.status(400).json({ error: "Message is required" });
  }

  const apiKey = process.env["AI_API_KEY"] || process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    return res.status(503).json({ error: "AI service not configured" });
  }

  const systemPrompt = `You are a helpful customer support assistant for Mental Gaming Store — a Myanmar-based mobile gaming top-up and digital goods shop. 
You help customers with questions about: game top-ups, wallet balance, orders, payment methods (KPay, Wave, AYA, CB), promo codes, referral program, daily check-in, spin wheel rewards.
Keep replies short and friendly (2-4 sentences max). Write in the same language the customer uses (English or Myanmar/Burmese).
If you can't help or the issue needs human review (refunds, order disputes, account issues), say so clearly and suggest they create a support ticket.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: 256, temperature: 0.7 },
        }),
      }
    );

    if (!geminiRes.ok) {
      return res.status(502).json({ error: "AI service error" });
    }

    const data = await geminiRes.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

    if (!reply) return res.status(502).json({ error: "Empty AI response" });

    return res.json({ reply, user: u.firstName ?? u.username ?? "User" });
  } catch (err) {
    return res.status(502).json({ error: "AI service unavailable" });
  }
});

// POST /support/tickets/:id/message — user reply on existing ticket
router.post("/tickets/:id/message", async (req: Request, res: Response) => {
  const u = asUser(req);
  const raw = String(req.params["id"] ?? "");
  const body = req.body as { message?: string };
  const message = String(body.message || "").trim();

  if (!message || message.length < 1) {
    return res.status(400).json({ error: "Message is required" });
  }

  const tickets = await getCollection<TicketDoc>("supporttickets");
  const query = ObjectId.isValid(raw)
    ? { _id: new ObjectId(raw), userId: u._id }
    : { ticketId: raw.toUpperCase(), userId: u._id };

  const t = await tickets.findOne(query);
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  if (t.status === "closed") {
    return res.status(409).json({ error: "Ticket is closed. Please open a new one." });
  }

  const now = new Date();
  await tickets.updateOne(query, {
    $push: { messages: { from: "user", message, at: now } } as any,
    $set: { updatedAt: now, status: "open" },
  });

  return res.json({ ok: true });
});

export default router;
