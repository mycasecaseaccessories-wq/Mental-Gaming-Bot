import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getCollection } from "../lib/mongodb";
import type { ObjectId } from "mongodb";

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
  language_code?: string;
}

export interface StoreUser {
  _id: ObjectId;
  telegramId: number;
  username: string | null;
  first_name: string | null;
  balanceKS: number;
  balanceCoin: number;
  totalDeposited: number;
  membershipTier: "Silver" | "Gold" | "Platinum";
  language: "en" | "mm";
  theme?: "light" | "dark" | "auto";
  isBlocked?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tgUser?: TelegramUser;
      storeUser?: StoreUser;
    }
  }
}

function verifyInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const calcHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calcHash !== hash) return null;

    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate) return null;
    const ageSec = Math.floor(Date.now() / 1000) - authDate;
    if (ageSec > 60 * 60 * 24) return null;

    const userRaw = params.get("user");
    if (!userRaw) return null;
    return JSON.parse(userRaw) as TelegramUser;
  } catch {
    return null;
  }
}

function verifyLoginWidgetData(raw: string, botToken: string): TelegramUser | null {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const hash = typeof payload.hash === "string" ? payload.hash : "";
    const authDate = Number(payload.auth_date || 0);
    const id = Number(payload.id || 0);
    if (!hash || !authDate || !Number.isFinite(id) || id <= 0) return null;
    if (Math.floor(Date.now() / 1000) - authDate > 60 * 60 * 24) return null;

    const dataCheckString = Object.entries(payload)
      .filter(([key, value]) => key !== "hash" && value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${String(value)}`)
      .sort()
      .join("\n");
    const secretKey = crypto.createHash("sha256").update(botToken).digest();
    const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const expected = Buffer.from(hash, "hex");
    const actual = Buffer.from(calculated, "hex");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

    return {
      id,
      username: typeof payload.username === "string" ? payload.username : undefined,
      first_name: typeof payload.first_name === "string" ? payload.first_name : undefined,
      last_name: typeof payload.last_name === "string" ? payload.last_name : undefined,
      photo_url: typeof payload.photo_url === "string" ? payload.photo_url : undefined,
      language_code: typeof payload.language_code === "string" ? payload.language_code : undefined,
    };
  } catch {
    return null;
  }
}

export async function telegramAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const botToken = process.env["BOT_TOKEN"];
  if (!botToken) {
    res.status(503).json({ error: "Telegram authentication is not configured" });
    return;
  }

  // Accept initData only from a header. Query-string credentials can leak into
  // browser history, reverse-proxy logs, analytics, and referrer headers.
  const initData =
    (req.header("x-telegram-init-data") as string | undefined) ||
    "";
  const loginWidgetData = (req.header("x-telegram-login") as string | undefined) || "";

  let tgUser: TelegramUser | null = null;

  if (initData) {
    tgUser = verifyInitData(initData, botToken);
  }
  if (!tgUser && loginWidgetData) {
    tgUser = verifyLoginWidgetData(loginWidgetData, botToken);
  }

  // Dev fallback: gated behind explicit ALLOW_DEV_TELEGRAM_AUTH=true env var
  // AND non-production NODE_ENV. Without the flag, the header is ignored even
  // in dev so misconfigured staging deployments cannot be impersonated.
  if (
    !tgUser &&
    process.env["NODE_ENV"] !== "production" &&
    process.env["ALLOW_DEV_TELEGRAM_AUTH"] === "true"
  ) {
    const devId = req.header("x-dev-telegram-id");
    if (devId && /^\d+$/.test(devId)) {
      tgUser = {
        id: Number(devId),
        first_name: req.header("x-dev-telegram-name") || "Dev User",
      };
    }
  }

  if (!tgUser) {
    res.status(401).json({ error: "Invalid or missing Telegram initData" });
    return;
  }

  req.tgUser = tgUser;

  // Upsert + load store user
  const users = await getCollection<StoreUser>("users");
  const numId = Number(tgUser.id);
  const now = new Date();

  await users.updateOne(
    { telegramId: numId },
    {
      $setOnInsert: {
        telegramId: numId,
        balanceKS: 0,
        balanceCoin: 0,
        totalDeposited: 0,
        membershipTier: "Silver",
        language: "en",
        joinSource: "share",
        joinDate: now,
        createdAt: now,
      },
      $set: {
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        lastActive: now,
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  const user = await users.findOne({ telegramId: numId });
  if (!user) {
    res.status(500).json({ error: "User load failed" });
    return;
  }
  if (user.isBlocked) {
    res.status(403).json({ error: "Account is blocked" });
    return;
  }
  req.storeUser = user;
  next();
}
