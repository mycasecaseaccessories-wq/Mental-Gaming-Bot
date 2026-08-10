/**
 * IP Whitelist Middleware
 *
 * Reads allowed IPs from the WEBHOOK_ALLOWED_IPS environment variable
 * (comma-separated: "1.2.3.4,5.6.7.8") plus a live list from SystemStatus
 * in MongoDB (polled every 5 minutes).
 *
 * In production, an IP allow-list is required unless
 * WEBHOOK_ALLOW_ANY_IP=true is explicitly configured. Dynamic DB entries and
 * WEBHOOK_ALLOWED_IPS are merged. Development remains open by default.
 */

import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";
import { getCollection } from "../lib/mongodb";

// ── Static whitelist from env ─────────────────────────────────────────────────

function getStaticWhitelist(): string[] {
  const raw = process.env["WEBHOOK_ALLOWED_IPS"] || "";
  return raw
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

// ── Dynamic whitelist from SystemStatus (cached 5 min) ───────────────────────

let _cachedDynamicList: string[] = [];
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60_000;

async function getDynamicWhitelist(): Promise<string[]> {
  if (Date.now() - _cacheTs < CACHE_TTL_MS) return _cachedDynamicList;

  try {
    const col = await getCollection<{ webhookIpWhitelist?: string[] }>("systemstatuses");
    const doc = await col.findOne({ _id: "global" } as any);
    _cachedDynamicList = doc?.webhookIpWhitelist ?? [];
    _cacheTs = Date.now();
  } catch {
    // Non-fatal — keep previous cache
  }
  return _cachedDynamicList;
}

// ── Client IP extraction ──────────────────────────────────────────────────────

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }
  return req.socket.remoteAddress || req.ip || "";
}

// ── Middleware factory ────────────────────────────────────────────────────────

export function ipWhitelist() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const staticList = getStaticWhitelist();
    const dynamicList = await getDynamicWhitelist();
    const allowed = new Set([...staticList, ...dynamicList]);

    if (!allowed.size) {
      if (
        process.env["NODE_ENV"] !== "production" ||
        process.env["WEBHOOK_ALLOW_ANY_IP"] === "true"
      ) {
        return next();
      }
      logger.error("Webhook IP whitelist is empty in production");
      res.status(503).json({
        error: "Webhook IP authentication is not configured",
      });
      return;
    }

    const clientIp = getClientIp(req);

    if (allowed.has(clientIp)) {
      return next();
    }

    logger.warn(
      { ip: clientIp, path: req.path },
      "Webhook request blocked — IP not in whitelist"
    );

    res.status(403).json({
      error: "Forbidden",
      message: "Your IP address is not authorised to send webhook events.",
    });
  };
}
