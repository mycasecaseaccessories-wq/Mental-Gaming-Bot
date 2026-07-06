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
app.use(cors());

// ── Raw body capture for webhook HMAC verification ───────────────────────────
// Must run BEFORE express.json(). Reads the stream, stores the raw string on
// req.rawBody, then also populates req.body so route handlers work normally.
app.use("/api/webhook", (req: Request, _res: Response, next: NextFunction) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    (req as any).rawBody = raw;
    try {
      (req as any).body = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      (req as any).body = {};
    }
    next();
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic abuse protection: 120 requests / minute / IP on the API surface.
// Webhook callbacks (payment providers) are exempt — they can legitimately
// burst and are already authenticated via HMAC.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.originalUrl.startsWith("/api/webhook"),
});
app.use("/api", apiLimiter);

app.use("/api", router);

export default app;
