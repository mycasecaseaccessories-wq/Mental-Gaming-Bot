/**
 * Webhook Routes — /api/webhook/*
 *
 * Receives notifications from external payment gateways and game top-up providers.
 * Validates the request (IP whitelist + HMAC signature) then writes a
 * WebhookEvent document to MongoDB for the bot's WebhookProcessor to handle.
 *
 * Routes:
 *   POST /api/webhook/payment   — KPay, Wave, AYA Pay callbacks
 *   POST /api/webhook/provider  — SmileOne, UniPin delivery confirmations
 *   GET  /api/webhook/health    — endpoint liveness check
 */

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { getCollection } from "../lib/mongodb";
import { ipWhitelist } from "../middlewares/ipWhitelist";

const router = Router();

// ── HMAC signature verifier ───────────────────────────────────────────────────

function verifySignature(
  rawBody: string,
  signature: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return true; // No secret configured → skip check (dev mode)
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.replace(/^sha256=/, ""), "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

// ── Raw body capture middleware (for HMAC) ────────────────────────────────────

function captureRawBody(req: Request, _res: Response, next: () => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    (req as any).rawBody = Buffer.concat(chunks).toString("utf8");
    next();
  });
}

// ── Shared write-event helper ─────────────────────────────────────────────────

async function writeWebhookEvent(opts: {
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  rawBody: string;
  signature?: string;
  ipAddress: string;
  externalRef?: string;
}): Promise<{ id: string }> {
  const col = await getCollection("webhookevents");

  const doc = {
    source:      opts.source,
    eventType:   opts.eventType,
    payload:     opts.payload,
    rawBody:     opts.rawBody,
    signature:   opts.signature || null,
    ipAddress:   opts.ipAddress,
    status:      "pending",
    orderId:     null,
    externalRef: opts.externalRef || null,
    processedAt: null,
    error:       null,
    retryCount:  0,
    createdAt:   new Date(),
    updatedAt:   new Date(),
  };

  const result = await col.insertOne(doc as any);
  return { id: result.insertedId.toString() };
}

// ── GET /api/webhook/health ───────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok", service: "webhook-listener", ts: new Date().toISOString() });
});

// ── POST /api/webhook/payment ─────────────────────────────────────────────────

router.post(
  "/payment",
  ipWhitelist(),
  async (req: Request, res: Response): Promise<void> => {
    const rawBody  = (req as any).rawBody ?? JSON.stringify(req.body);
    const sig      = req.headers["x-signature"] as string | undefined;
    const secret   = process.env["WEBHOOK_SECRET"];
    const clientIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();

    // Signature check
    if (!verifySignature(rawBody, sig, secret)) {
      logger.warn({ ip: clientIp }, "Payment webhook: invalid signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const body = req.body as Record<string, unknown>;

    // Determine payment source from headers or body
    const source = (req.headers["x-provider"] as string) ||
                   (body.provider as string) ||
                   "unknown";

    // Map provider-specific event types to canonical names
    const eventMap: Record<string, string> = {
      "payment_success":   "payment.completed",
      "payment_completed": "payment.completed",
      "payment_failed":    "payment.failed",
      "payment_declined":  "payment.failed",
      "refund_completed":  "payment.refunded",
    };

    const rawEvent = (body.event || body.status || body.type || "unknown") as string;
    const eventType = eventMap[rawEvent] || `payment.${rawEvent}`;

    const externalRef = (body.transaction_id || body.reference || body.order_id) as string | undefined;

    try {
      const { id } = await writeWebhookEvent({
        source,
        eventType,
        payload:     body,
        rawBody,
        signature:   sig,
        ipAddress:   clientIp,
        externalRef,
      });

      logger.info({ id, source, eventType, externalRef }, "Payment webhook received");
      res.json({ received: true, id });
    } catch (err) {
      logger.error({ err }, "Failed to store payment webhook event");
      res.status(500).json({ error: "Internal error" });
    }
  }
);

// ── POST /api/webhook/provider ────────────────────────────────────────────────

router.post(
  "/provider",
  ipWhitelist(),
  async (req: Request, res: Response): Promise<void> => {
    const rawBody  = (req as any).rawBody ?? JSON.stringify(req.body);
    const sig      = req.headers["x-signature"] as string | undefined;
    const secret   = process.env["WEBHOOK_SECRET"];
    const clientIp = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim();

    if (!verifySignature(rawBody, sig, secret)) {
      logger.warn({ ip: clientIp }, "Provider webhook: invalid signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const body = req.body as Record<string, unknown>;

    const source = (req.headers["x-provider"] as string) ||
                   (body.provider as string) ||
                   "unknown";

    const rawEvent = (body.event || body.status || "unknown") as string;
    const eventMap: Record<string, string> = {
      "delivery_success": "topup.delivered",
      "delivery_failed":  "topup.failed",
      "topup_success":    "topup.delivered",
      "topup_failed":     "topup.failed",
    };
    const eventType   = eventMap[rawEvent] || `provider.${rawEvent}`;
    const externalRef = (body.order_id || body.transaction_id || body.reference) as string | undefined;

    try {
      const { id } = await writeWebhookEvent({
        source,
        eventType,
        payload:     body,
        rawBody,
        signature:   sig,
        ipAddress:   clientIp,
        externalRef,
      });

      logger.info({ id, source, eventType, externalRef }, "Provider webhook received");
      res.json({ received: true, id });
    } catch (err) {
      logger.error({ err }, "Failed to store provider webhook event");
      res.status(500).json({ error: "Internal error" });
    }
  }
);

export default router;
