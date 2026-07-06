import { useState, useEffect } from "react";
import { useLocation, useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Wallet as WalletIcon, Check, Plus, Minus, Tag, X } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, ApiError, type Product, type Me, type CheckoutField, type PromoPreview, type SavedAddress } from "@/lib/api";
import { ks, cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

function resolveFields(product: Product): CheckoutField[] {
  if (product.checkoutFields !== null) {
    return product.checkoutFields;
  }
  if (product.productType === "DirectTopup") {
    return [
      { key: "game_id", label: "Game ID", fieldType: "text", required: true, placeholder: "Your in-game ID" },
    ];
  }
  return [];
}

export default function OrderPage() {
  const [, params] = useRoute<{ id: string }>("/order/:id");
  const [, navigate] = useLocation();
  const id = params?.id || "";
  const qc = useQueryClient();

  const pQ = useQuery({
    queryKey: ["product", id],
    queryFn: () => api.get<Product>(`/products/${id}`),
    enabled: !!id,
  });
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const addrQ = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<{ addresses: SavedAddress[] }>("/addresses"),
  });

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saveForNext, setSaveForNext] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<PromoPreview | null>(null);
  const [promoErr, setPromoErr] = useState<string | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);

  // Respect product maxQuantity
  const maxQty = (pQ.data as Product & { maxQuantity?: number | null })?.maxQuantity ?? 10;
  const effectiveMax = maxQty === 1 ? 1 : maxQty === 0 || maxQty == null ? 99 : maxQty;

  useEffect(() => {
    if (pQ.data) {
      const fields = resolveFields(pQ.data);
      const init: Record<string, string> = {};
      fields.forEach((f) => { init[f.key] = ""; });
      setFieldValues(init);
      setQuantity(1);
      setAppliedPromo(null);
      setPromoInput("");
      setPromoErr(null);
    }
  }, [pQ.data?.id]);

  const mutation = useMutation({
    mutationFn: () => {
      const fields = pQ.data ? resolveFields(pQ.data) : [];
      const checkoutData = fields.map((f) => ({
        key: f.key,
        label: f.label,
        value: (fieldValues[f.key] ?? "").trim(),
      }));
      // Recompute total so we only send a promo that still meets its min order.
      const uPrice = pQ.data?.effectivePrice ?? 0;
      const tOff = Math.round((uPrice * (meQ.data?.tierDiscountPct ?? 0)) / 100);
      const tot = Math.max(0, uPrice - tOff) * quantity;
      const sendPromo =
        appliedPromo && tot >= appliedPromo.minOrderAmount ? appliedPromo.code : undefined;
      return api.post<{ orderId: string; amount: number; status: string }>("/orders", {
        productId: id,
        checkoutData,
        quantity,
        paymentMethod: "wallet",
        ...(sendPromo ? { promoCode: sendPromo } : {}),
      });
    },
    onSuccess: (data) => {
      haptic("success");
      // Optionally remember the game ID for faster checkout next time.
      const gid = (fieldValues["game_id"] ?? "").trim();
      if (saveForNext && gid) {
        const zid = (fieldValues["zone_id"] ?? "").trim();
        api
          .post("/addresses", {
            gameName: pQ.data?.category || pQ.data?.name || "Game",
            gameId: gid,
            ...(zid ? { zoneId: zid } : {}),
          })
          .then(() => qc.invalidateQueries({ queryKey: ["addresses"] }))
          .catch(() => {});
      }
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
      navigate(`/orders/${data.orderId}?placed=1`);
    },
    onError: (e: unknown) => {
      haptic("error");
      setErr(e instanceof ApiError ? e.message : "Order failed");
    },
  });

  if (pQ.isLoading || meQ.isLoading) {
    return <Layout title="Checkout" showBack showNav={false}><Skeleton className="h-64" /></Layout>;
  }
  if (!pQ.data || !meQ.data) {
    return <Layout title="Checkout" showBack showNav={false}>Product unavailable</Layout>;
  }

  const fields = resolveFields(pQ.data);
  const hasGameIdField = fields.some((f) => f.key === "game_id");
  const savedAddrs = addrQ.data?.addresses ?? [];
  const tierPct = meQ.data.tierDiscountPct;
  const unitPrice = pQ.data.effectivePrice;
  const tierOff = Math.round((unitPrice * tierPct) / 100);
  const unitTotal = Math.max(0, unitPrice - tierOff);
  const total = unitTotal * quantity;
  const promoValid = appliedPromo ? total >= appliedPromo.minOrderAmount : false;
  const promoOff = appliedPromo && promoValid
    ? Math.min(
        appliedPromo.discountType === "Flat"
          ? appliedPromo.value
          : Math.floor((appliedPromo.value / 100) * total),
        total
      )
    : 0;
  const grandTotal = Math.max(0, total - promoOff);
  const enough = meQ.data.balanceKS >= grandTotal;

  const applyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoErr(null);
    setPromoLoading(true);
    try {
      const preview = await api.post<PromoPreview>("/promo/validate", { code, amount: total });
      setAppliedPromo(preview);
      haptic("success");
    } catch (e) {
      setAppliedPromo(null);
      setPromoErr(e instanceof ApiError ? e.message : "Invalid promo code");
      haptic("error");
    } finally {
      setPromoLoading(false);
    }
  };

  const fieldsOk = fields.every((f) =>
    !f.required || (fieldValues[f.key] ?? "").trim().length > 0
  );

  return (
    <Layout title="Checkout" showBack showNav={false}>
      <div className="space-y-4 pb-32">
        {/* Product summary */}
        <Glass className="p-4 flex items-center gap-3">
          <div className="w-16 h-16 rounded-xl bg-white/5 flex items-center justify-center text-2xl overflow-hidden flex-shrink-0">
            {pQ.data.imageUrl
              ? <img src={pQ.data.imageUrl} alt={pQ.data.name} className="w-full h-full object-cover" />
              : <span>🎮</span>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground">{pQ.data.category}</div>
            <div className="font-semibold truncate">{pQ.data.name}</div>
            <div className="text-sm font-bold mt-0.5">{ks(pQ.data.effectivePrice)}</div>
          </div>
        </Glass>

        {/* Quantity picker */}
        {effectiveMax !== 1 && (
          <Glass className="p-4">
            <div className="text-xs font-medium text-muted-foreground mb-3">
              Quantity{effectiveMax < 99 ? ` (max ${effectiveMax})` : ""}
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => { haptic("selection"); setQuantity((q) => Math.max(1, q - 1)); }}
                disabled={quantity <= 1}
                className="pressable h-9 w-9 rounded-full glass border border-white/10 flex items-center justify-center disabled:opacity-30"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="text-xl font-bold w-8 text-center">{quantity}</span>
              <button
                onClick={() => { haptic("selection"); setQuantity((q) => Math.min(effectiveMax, q + 1)); }}
                disabled={quantity >= effectiveMax}
                className="pressable h-9 w-9 rounded-full glass border border-white/10 flex items-center justify-center disabled:opacity-30"
              >
                <Plus className="h-4 w-4" />
              </button>
              {quantity > 1 && (
                <span className="text-xs text-muted-foreground ml-2">
                  {ks(unitPrice)} × {quantity}
                </span>
              )}
            </div>
          </Glass>
        )}

        {/* Saved game IDs quick-pick */}
        {hasGameIdField && savedAddrs.length > 0 && (
          <Glass className="p-4">
            <div className="text-xs font-medium text-muted-foreground mb-2">Saved IDs</div>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {savedAddrs.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    haptic("selection");
                    setFieldValues((v) => ({
                      ...v,
                      game_id: a.gameId,
                      ...(a.zoneId && "zone_id" in v ? { zone_id: a.zoneId } : {}),
                    }));
                  }}
                  className="pressable flex-shrink-0 px-3 py-2 rounded-xl glass border border-white/10 text-left"
                  data-testid={`chip-address-${a.id}`}
                >
                  <div className="text-xs font-semibold truncate max-w-[150px]">
                    {a.nickname && a.nickname !== a.gameId ? a.nickname : a.gameName}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate max-w-[150px]">
                    {a.gameId}
                    {a.zoneId ? ` · ${a.zoneId}` : ""}
                  </div>
                </button>
              ))}
            </div>
          </Glass>
        )}

        {/* Dynamic checkout fields */}
        {fields.length > 0 && (
          <Glass className="p-4 space-y-3">
            {fields.map((field) => (
              <div key={field.key}>
                <label className="text-xs font-medium text-muted-foreground">
                  {field.label}{field.required && <span className="text-rose-300 ml-0.5">*</span>}
                </label>
                {field.helpText && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{field.helpText}</p>
                )}
                {field.fieldType === "textarea" ? (
                  <textarea
                    value={fieldValues[field.key] ?? ""}
                    onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    placeholder={field.placeholder ?? `Enter ${field.label}`}
                    rows={3}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 outline-none focus:border-primary resize-none text-sm"
                    data-testid={`input-${field.key}`}
                  />
                ) : (
                  <input
                    type={field.fieldType === "number" ? "number" : field.fieldType === "email" ? "email" : "text"}
                    value={fieldValues[field.key] ?? ""}
                    onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    placeholder={field.placeholder ?? `Enter ${field.label}`}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 outline-none focus:border-primary text-sm"
                    data-testid={`input-${field.key}`}
                  />
                )}
              </div>
            ))}

            {hasGameIdField && (fieldValues["game_id"] ?? "").trim() && (
              <button
                onClick={() => { haptic("selection"); setSaveForNext((s) => !s); }}
                className="pressable flex items-center gap-2 text-xs text-muted-foreground pt-1"
                data-testid="toggle-save-id"
              >
                <span
                  className={cn(
                    "h-4 w-4 rounded border border-white/20 flex items-center justify-center",
                    saveForNext && "bg-primary border-primary"
                  )}
                >
                  {saveForNext && <Check className="h-3 w-3 text-white" />}
                </span>
                Save this ID for next time
              </button>
            )}
          </Glass>
        )}

        {/* Promo code */}
        <Glass className="p-4">
          {appliedPromo && promoValid ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <Tag className="h-4 w-4 text-emerald-300" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{appliedPromo.code}</div>
                  <div className="text-xs text-emerald-300">− {ks(promoOff)}</div>
                </div>
              </div>
              <button
                onClick={() => { haptic("selection"); setAppliedPromo(null); setPromoInput(""); setPromoErr(null); }}
                className="pressable h-8 w-8 rounded-full glass border border-white/10 flex items-center justify-center"
                data-testid="button-remove-promo"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Promo code</span>
              </div>
              <div className="flex gap-2">
                <input
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                  placeholder="Enter code"
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 outline-none focus:border-primary text-sm uppercase"
                  data-testid="input-promo"
                />
                <button
                  onClick={applyPromo}
                  disabled={!promoInput.trim() || promoLoading}
                  className="pressable px-4 rounded-xl bg-primary/20 text-primary font-medium text-sm disabled:opacity-40"
                  data-testid="button-apply-promo"
                >
                  {promoLoading ? "…" : "Apply"}
                </button>
              </div>
              {promoErr && <div className="text-xs text-rose-300 mt-2">{promoErr}</div>}
              {appliedPromo && !promoValid && (
                <div className="text-xs text-amber-300 mt-2">
                  Min order {ks(appliedPromo.minOrderAmount)} required for {appliedPromo.code}.
                </div>
              )}
            </div>
          )}
        </Glass>

        {/* Payment — wallet only */}
        <Glass className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-primary/20 flex items-center justify-center">
              <WalletIcon className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="text-sm font-medium">Wallet</div>
              <div className="text-xs text-muted-foreground">{ks(meQ.data.balanceKS)}</div>
            </div>
          </div>
          {!enough && (
            <Link href="/topup" className="text-xs text-primary font-medium">Top up →</Link>
          )}
        </Glass>
        {!enough && (
          <div className="text-xs text-rose-300 px-1">
            Not enough balance. Need {ks(grandTotal - meQ.data.balanceKS)} more.
          </div>
        )}

        {/* Price summary */}
        <Glass className="p-4 space-y-1.5 text-sm">
          {quantity > 1 ? (
            <>
              <Row label="Unit price">{ks(unitPrice)}</Row>
              <Row label={`Quantity`}>× {quantity}</Row>
            </>
          ) : (
            <Row label="Price">{ks(unitPrice)}</Row>
          )}
          {tierOff > 0 && (
            <Row label={`${meQ.data.tier} tier (−${tierPct}%)`} className="text-emerald-300">
              − {ks(tierOff * quantity)}
            </Row>
          )}
          {promoOff > 0 && appliedPromo && (
            <Row label={`Promo (${appliedPromo.code})`} className="text-emerald-300">
              − {ks(promoOff)}
            </Row>
          )}
          <div className="border-t border-white/10 my-2" />
          <Row label="Total" bold>{ks(grandTotal)}</Row>
        </Glass>

        {err && (
          <div className="text-sm text-rose-300 text-center">{err}</div>
        )}

        {/* Confirm button */}
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 bg-gradient-to-t from-background to-transparent">
          <button
            disabled={!fieldsOk || !enough || mutation.isPending}
            onClick={() => { setErr(null); mutation.mutate(); }}
            className="pressable w-full bg-primary text-white rounded-2xl py-4 font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            data-testid="button-confirm"
          >
            {mutation.isPending
              ? "Placing order…"
              : <><Check className="h-5 w-5" /> Confirm & Pay {ks(grandTotal)}</>}
          </button>
        </div>
      </div>
    </Layout>
  );
}

function Row({ label, children, bold, className }: { label: string; children: React.ReactNode; bold?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between", className, bold && "font-semibold text-base")}>
      <span className={bold ? "" : "text-muted-foreground"}>{label}</span>
      <span>{children}</span>
    </div>
  );
}
