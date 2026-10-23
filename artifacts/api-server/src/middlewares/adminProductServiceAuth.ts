import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const API_PRODUCT_PREFIX = "/api/store/admin-portal/products";
const MAX_CLOCK_SKEW_SECONDS = 60;
const NONCE_LIFETIME_MS = 2 * MAX_CLOCK_SKEW_SECONDS * 1000;
const MAX_TRACKED_NONCES = 10_000;
const usedNonces = new Map<string, number>();

type SignedRequestParts = {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  email: string;
  bodyText: string;
};

export function productServiceSigningPayload(parts: SignedRequestParts): string {
  const bodyHash = createHash("sha256").update(parts.bodyText).digest("hex");
  return [
    "v1",
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.email.trim().toLowerCase(),
    bodyHash,
  ].join("\n");
}

export function signProductServiceRequest(secret: string, parts: SignedRequestParts): string {
  return createHmac("sha256", secret).update(productServiceSigningPayload(parts)).digest("hex");
}

function pruneNonces(now: number) {
  for (const [key, expiry] of usedNonces) {
    if (expiry <= now) usedNonces.delete(key);
  }
  while (usedNonces.size >= MAX_TRACKED_NONCES) {
    const oldest = usedNonces.keys().next().value as string | undefined;
    if (!oldest) break;
    usedNonces.delete(oldest);
  }
}

function signatureMatches(expectedHex: string, receivedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function adminProductServiceAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env["MG_PRODUCT_API_SECRET"] ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    res.status(503).json({ error: "Product service authentication is not configured" });
    return;
  }

  const timestamp = req.get("X-MG-Timestamp") ?? "";
  const nonce = req.get("X-MG-Nonce") ?? "";
  const email = req.get("X-MG-Admin-Email") ?? "";
  const signature = req.get("X-MG-Signature") ?? "";
  const signedAt = /^\d{10}$/.test(timestamp) ? Number(timestamp) : NaN;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(signedAt) ||
    Math.abs(nowSeconds - signedAt) > MAX_CLOCK_SKEW_SECONDS ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 320 ||
    !req.originalUrl.startsWith(API_PRODUCT_PREFIX) ||
    !["GET", "POST", "PATCH"].includes(req.method)
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const bodyText = req.method === "GET" ? "" : JSON.stringify(req.body ?? {});
  const parts = {
    method: req.method,
    path: req.originalUrl,
    timestamp,
    nonce,
    email,
    bodyText,
  };
  const expected = signProductServiceRequest(secret, parts);
  if (!signatureMatches(expected, signature)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const now = Date.now();
  pruneNonces(now);
  const nonceKey = `${email.trim().toLowerCase()}:${nonce}`;
  if (usedNonces.has(nonceKey)) {
    res.status(409).json({ error: "Request already used" });
    return;
  }
  usedNonces.set(nonceKey, now + NONCE_LIFETIME_MS);
  res.locals.productServiceAdminEmail = email.trim().toLowerCase();
  next();
}
