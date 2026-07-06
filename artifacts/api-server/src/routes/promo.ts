import { Router, type IRouter, type Request, type Response } from "express";
import { telegramAuth, type StoreUser } from "../middlewares/telegramAuth";
import { validatePromo } from "../lib/promo";

const router: IRouter = Router();
router.use(telegramAuth);

// ── POST /promo/validate ────────────────────────────────────────────────────
// body: { code: string, amount?: number }
// Previews a promo code's discount without consuming it. Consumption happens
// atomically at order placement (see POST /orders in store.ts).
router.post("/promo/validate", async (req: Request, res: Response) => {
  const u = req.storeUser as StoreUser;
  const body = req.body as { code?: string; amount?: number };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    res.status(400).json({ error: "Promo code required" });
    return;
  }
  const amount = Number(body.amount) || 0;
  const result = await validatePromo(code, u._id, amount);
  if (!result.valid || !result.promo) {
    res.status(400).json({ error: result.error || "Invalid promo code" });
    return;
  }
  const p = result.promo;
  res.json({
    code: p.code,
    discountType: p.discountType,
    value: p.value,
    discount: result.discount ?? 0,
    minOrderAmount: p.minOrderAmount || 0,
    description: p.description || "",
  });
});

export default router;
