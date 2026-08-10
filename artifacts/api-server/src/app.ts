import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Behind the Replit proxy, so trust the first hop for correct client IPs
// (required for express-rate-limit to key on the real caller).
app.set("trust proxy", 1);

// Security headers.
app.use(helmet());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const allowedOrigins = (process.env["CORS_ALLOWED_ORIGINS"] || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Requests without Origin are non-browser/server requests. In production,
      // browser cross-origin access must be explicitly allow-listed.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (process.env["NODE_ENV"] !== "production" && !allowedOrigins.length) {
        return cb(null, true);
      }
      return cb(null, false);
    },
  }),
);

// ── Raw body capture for webhook HMAC verification ───────────────────────────
// Must run BEFORE express.json(). Reads the stream, stores the raw string on
// req.rawBody, then also populates req.body so route handlers work normally.
app.use("/api/webhook", (req: Request, res: Response, next: NextFunction) => {
  const chunks: Buffer[] = [];
  let received = 0;
  let tooLarge = false;
  const maxBytes = 1024 * 1024; // 1 MiB webhook payload cap

  req.on("data", (chunk: Buffer) => {
    if (tooLarge) return;
    received += chunk.length;
    if (received > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      res.status(413).json({ error: "Webhook payload too large" });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge || res.headersSent) return;
    const raw = Buffer.concat(chunks).toString("utf8");
    (req as any).rawBody = raw;
    try {
      (req as any).body = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      res.status(400).json({ error: "Invalid JSON webhook payload" });
      return;
    }
    next();
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhooks get their own burst-friendly limiter in addition to HMAC/IP checks.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/webhook", webhookLimiter);

// Basic abuse protection: 120 requests / minute / IP on the API surface.
// Webhook callbacks are handled by the dedicated limiter above.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.originalUrl.startsWith("/api/webhook"),
});
app.use("/api", apiLimiter);

app.use("/api", router);

// Express 5 forwards rejected async handlers here. Return JSON instead of the
// default HTML error page so the Mini App can show the real configuration/
// database problem and distinguish it from an application response.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({ err }, "API request failed");
  const unavailable = /MONGODB_URI|Mongo|topology|server selection|ECONNREFUSED/i.test(message);
  res.status(unavailable ? 503 : 500).json({
    error: unavailable ? "Store database is unavailable" : "Internal server error",
  });
});

export default app;
