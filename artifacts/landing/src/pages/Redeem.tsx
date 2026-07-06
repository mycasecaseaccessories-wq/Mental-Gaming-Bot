import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gift, Ticket, Coins, Check, ChevronRight, X, Loader2, Sparkles } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton, EmptyState } from "@/components/EmptyState";
import {
  api,
  ApiError,
  type RewardItem,
  type RewardItemsResponse,
  type RedeemCodePreview,
  type RedeemResult,
  type CheckoutField,
  type GrantedCoupon,
} from "@/lib/api";
import { coin, cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

function couponLine(discountType: string | null, value: number | null): string {
  if (!discountType || value == null) return "Discount coupon";
  return discountType === "Flat" ? `${coin(value)} Ks off` : `${value}% off`;
}

/** Modal that collects any required product fields then confirms redemption. */
function RedeemModal({
  title,
  subtitle,
  costLabel,
  fields,
  onClose,
  onConfirm,
  submitting,
  error,
}: {
  title: string;
  subtitle: string;
  costLabel: string;
  fields: CheckoutField[];
  onClose: () => void;
  onConfirm: (values: Record<string, string>) => void;
  submitting: boolean;
  error: string | null;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = fields.some((f) => f.required && !(values[f.key] ?? "").trim());

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <Glass className="w-full max-w-md p-5 space-y-4 rounded-3xl" data-testid="redeem-modal">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-lg truncate">{title}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>
          </div>
          <button onClick={onClose} className="pressable p-1 text-muted-foreground" data-testid="redeem-modal-close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="text-xs font-medium text-muted-foreground">
                  {f.label}
                  {f.required && <span className="text-rose-400"> *</span>}
                </label>
                {f.fieldType === "textarea" ? (
                  <textarea
                    className="mt-1 w-full rounded-xl bg-background/60 border border-border px-3 py-2 text-sm outline-none focus:border-primary"
                    rows={3}
                    placeholder={f.placeholder ?? ""}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    data-testid={`field-${f.key}`}
                  />
                ) : (
                  <input
                    className="mt-1 w-full rounded-xl bg-background/60 border border-border px-3 py-2 text-sm outline-none focus:border-primary"
                    type={f.fieldType === "number" ? "number" : f.fieldType === "email" ? "email" : "text"}
                    placeholder={f.placeholder ?? ""}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    data-testid={`field-${f.key}`}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-sm text-rose-400">{error}</div>}

        <button
          disabled={missing || submitting}
          onClick={() => onConfirm(values)}
          className={cn(
            "pressable w-full rounded-2xl py-3 font-semibold flex items-center justify-center gap-2",
            missing || submitting ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground"
          )}
          data-testid="redeem-confirm"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {costLabel}
        </button>
      </Glass>
    </div>
  );
}

/** Success screen for a granted coupon or product order. */
function ResultCard({ result, onDone }: { result: RedeemResult; onDone: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <Glass className="w-full max-w-md p-6 space-y-4 rounded-3xl text-center" data-testid="redeem-result">
        <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
          <Sparkles className="h-7 w-7 text-emerald-400" />
        </div>
        {result.type === "coupon" && result.coupon ? (
          <>
            <div className="font-semibold text-lg">Coupon added! 🎉</div>
            <div className="text-sm text-muted-foreground">Use this code at checkout</div>
            <div className="rounded-2xl bg-background/60 border border-dashed border-primary/50 py-3">
              <div className="font-mono text-xl font-bold tracking-widest text-primary">{result.coupon.code}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {couponLine(result.coupon.discountType, result.coupon.value)}
                {result.coupon.minOrderAmount > 0 && ` · min ${coin(result.coupon.minOrderAmount)} Ks`}
              </div>
            </div>
          </>
        ) : result.order ? (
          <>
            <div className="font-semibold text-lg">Reward claimed! 🎁</div>
            <div className="text-sm text-muted-foreground">
              Your order for <span className="text-foreground font-medium">{result.order.productName}</span> is now being processed.
            </div>
            <div className="text-xs text-muted-foreground">Order #{result.order.shortId}</div>
          </>
        ) : null}
        <button
          onClick={onDone}
          className="pressable w-full rounded-2xl py-3 font-semibold bg-primary text-primary-foreground"
          data-testid="redeem-result-done"
        >
          Done
        </button>
      </Glass>
    </div>
  );
}

export default function RedeemPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"rewards" | "code">("rewards");
  const [result, setResult] = useState<RedeemResult | null>(null);

  // ── Coin rewards ──
  const itemsQ = useQuery<RewardItemsResponse>({
    queryKey: ["reward-items"],
    queryFn: () => api.get("/rewards/items"),
    retry: false,
  });
  const [activeItem, setActiveItem] = useState<RewardItem | null>(null);
  const [itemErr, setItemErr] = useState<string | null>(null);

  const redeemItem = useMutation({
    mutationFn: (vars: { item: RewardItem; values: Record<string, string> }) =>
      api.post<RedeemResult>(`/rewards/items/${vars.item.id}/redeem`, { checkoutData: vars.values }),
    onSuccess: (data) => {
      haptic("success");
      setActiveItem(null);
      setItemErr(null);
      setResult(data);
      qc.invalidateQueries({ queryKey: ["reward-items"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
    },
    onError: (e: unknown) => {
      haptic("error");
      setItemErr(e instanceof ApiError ? e.message : "Redemption failed");
    },
  });

  // ── Redeem codes ──
  const [codeInput, setCodeInput] = useState("");
  const [preview, setPreview] = useState<RedeemCodePreview | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [codeModalErr, setCodeModalErr] = useState<string | null>(null);
  const [codeFlow, setCodeFlow] = useState<RedeemCodePreview | null>(null);

  async function lookupCode() {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    setPreviewing(true);
    setCodeErr(null);
    setPreview(null);
    try {
      const p = await api.get<RedeemCodePreview>(`/rewards/codes/${encodeURIComponent(code)}/preview`);
      haptic("light");
      setPreview(p);
    } catch (e) {
      haptic("error");
      setCodeErr(e instanceof ApiError ? e.message : "Invalid code");
    } finally {
      setPreviewing(false);
    }
  }

  const redeemCode = useMutation({
    mutationFn: (vars: { code: string; values: Record<string, string> }) =>
      api.post<RedeemResult>(`/rewards/codes/redeem`, { code: vars.code, checkoutData: vars.values }),
    onSuccess: (data) => {
      haptic("success");
      setPreview(null);
      setCodeFlow(null);
      setCodeInput("");
      setCodeModalErr(null);
      setResult(data);
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e: unknown) => {
      haptic("error");
      setCodeModalErr(e instanceof ApiError ? e.message : "Redemption failed");
    },
  });

  const balance = itemsQ.data?.coinBalance ?? 0;

  return (
    <Layout title="Rewards" showBack showNav={false}>
      <div className="space-y-4 pb-8">
        {/* Balance */}
        <Glass className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-400/15 flex items-center justify-center">
            <Coins className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Your Mental Coins</div>
            <div className="font-bold text-lg">{coin(balance)}</div>
          </div>
        </Glass>

        {/* Tabs */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => { setTab("rewards"); haptic("selection"); }}
            className={cn(
              "pressable rounded-2xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2",
              tab === "rewards" ? "bg-primary text-primary-foreground" : "glass text-muted-foreground"
            )}
            data-testid="tab-rewards"
          >
            <Gift className="h-4 w-4" /> Coin Rewards
          </button>
          <button
            onClick={() => { setTab("code"); haptic("selection"); }}
            className={cn(
              "pressable rounded-2xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2",
              tab === "code" ? "bg-primary text-primary-foreground" : "glass text-muted-foreground"
            )}
            data-testid="tab-code"
          >
            <Ticket className="h-4 w-4" /> Redeem Code
          </button>
        </div>

        {/* Coin Rewards tab */}
        {tab === "rewards" && (
          <div className="space-y-3">
            {itemsQ.isLoading ? (
              <>
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </>
            ) : (itemsQ.data?.items.length ?? 0) === 0 ? (
              <EmptyState icon={<Gift className="h-8 w-8" />} title="No rewards yet" hint="Check back soon for coin rewards." />
            ) : (
              itemsQ.data!.items.map((it) => {
                const affordable = balance >= it.coinPrice;
                const limited = it.perUserLimit > 0 && it.redeemedByUser >= it.perUserLimit;
                const outOfStock = it.stockCount !== -1 && it.stockCount <= 0;
                const disabled = !it.canRedeem || limited || outOfStock;
                return (
                  <Glass key={it.id} className="p-4 flex items-center gap-3" data-testid={`reward-${it.id}`}>
                    <div className="text-3xl shrink-0">{it.rewardType === "coupon" ? "🎟️" : "🎁"}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{it.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {it.rewardType === "coupon"
                          ? couponLine(it.coupon?.discountType ?? null, it.coupon?.value ?? null)
                          : it.productName ?? it.description}
                      </div>
                      <div className="text-sm font-semibold text-amber-400 mt-1">{coin(it.coinPrice)} MC</div>
                      {limited && <div className="text-[10px] text-muted-foreground">Already redeemed</div>}
                      {!limited && outOfStock && <div className="text-[10px] text-rose-400">Out of stock</div>}
                    </div>
                    <button
                      disabled={disabled}
                      onClick={() => { setActiveItem(it); setItemErr(null); haptic("light"); }}
                      className={cn(
                        "pressable rounded-xl px-4 py-2 text-sm font-semibold shrink-0",
                        disabled ? "bg-muted text-muted-foreground"
                          : affordable ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}
                      data-testid={`redeem-item-${it.id}`}
                    >
                      {limited ? "Claimed" : outOfStock ? "Sold out" : affordable ? "Redeem" : "Need MC"}
                    </button>
                  </Glass>
                );
              })
            )}
          </div>
        )}

        {/* Redeem Code tab */}
        {tab === "code" && (
          <div className="space-y-3">
            <Glass className="p-4 space-y-3">
              <div className="text-sm font-medium">Enter a redeem code</div>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-xl bg-background/60 border border-border px-3 py-2.5 text-sm uppercase tracking-widest outline-none focus:border-primary"
                  placeholder="E.g. WELCOME2026"
                  value={codeInput}
                  onChange={(e) => { setCodeInput(e.target.value); setCodeErr(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") lookupCode(); }}
                  data-testid="code-input"
                />
                <button
                  disabled={!codeInput.trim() || previewing}
                  onClick={lookupCode}
                  className={cn(
                    "pressable rounded-xl px-4 font-semibold flex items-center gap-1",
                    !codeInput.trim() || previewing ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground"
                  )}
                  data-testid="code-check"
                >
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              </div>
              {codeErr && <div className="text-sm text-rose-400">{codeErr}</div>}
            </Glass>

            {preview && (
              <Glass className="p-4 space-y-3" data-testid="code-preview">
                <div className="flex items-center gap-3">
                  <div className="text-3xl">{preview.rewardType === "coupon" ? "🎟️" : "🎁"}</div>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">
                      {preview.rewardType === "coupon"
                        ? couponLine(preview.coupon?.discountType ?? null, preview.coupon?.value ?? null)
                        : preview.productName ?? "Free product"}
                    </div>
                    {preview.description && <div className="text-xs text-muted-foreground">{preview.description}</div>}
                    <div className="text-xs text-emerald-400 font-medium mt-0.5">Free with code {preview.code}</div>
                  </div>
                </div>
                <button
                  onClick={() => { setCodeModalErr(null); redeemCodeFlow(preview); }}
                  className="pressable w-full rounded-2xl py-3 font-semibold bg-primary text-primary-foreground flex items-center justify-center gap-2"
                  data-testid="code-claim"
                >
                  <Check className="h-4 w-4" /> Claim reward
                </button>
              </Glass>
            )}
          </div>
        )}
      </div>

      {/* Reward item redeem modal */}
      {activeItem && (
        <RedeemModal
          title={activeItem.name}
          subtitle={
            activeItem.rewardType === "coupon"
              ? couponLine(activeItem.coupon?.discountType ?? null, activeItem.coupon?.value ?? null)
              : activeItem.productName ?? ""
          }
          costLabel={`Redeem for ${coin(activeItem.coinPrice)} MC`}
          fields={activeItem.rewardType === "product" ? activeItem.checkoutFields : []}
          onClose={() => { setActiveItem(null); setItemErr(null); }}
          onConfirm={(values) => redeemItem.mutate({ item: activeItem, values })}
          submitting={redeemItem.isPending}
          error={itemErr}
        />
      )}

      {/* Redeem code confirm modal (only when product needs fields) */}
      {codeFlow && (
        <RedeemModal
          title={codeFlow.productName ?? "Claim reward"}
          subtitle={`Free with code ${codeFlow.code}`}
          costLabel="Claim for free"
          fields={codeFlow.checkoutFields}
          onClose={() => { setCodeFlow(null); setCodeModalErr(null); }}
          onConfirm={(values) => redeemCode.mutate({ code: codeFlow.code, values })}
          submitting={redeemCode.isPending}
          error={codeModalErr}
        />
      )}

      {/* Success result */}
      {result && <ResultCard result={result} onDone={() => setResult(null)} />}
    </Layout>
  );

  // ── helpers that need component scope ──
  function redeemCodeFlow(p: RedeemCodePreview) {
    if (p.rewardType === "product" && p.checkoutFields.length > 0) {
      setCodeFlow(p);
    } else {
      redeemCode.mutate({ code: p.code, values: {} });
    }
  }
}
