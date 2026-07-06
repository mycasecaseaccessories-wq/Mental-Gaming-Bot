import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gift, Trophy, Plus, Trash2, Save } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { haptic } from "@/lib/telegram";

interface ReferralTier {
  minRefs: number;
  rate: number;
  label: string;
  emoji: string;
}

interface SpinWeights {
  thanks: number;
  coins50: number;
  coins200: number;
  coins500: number;
  ks1000: number;
  ks5000: number;
  freeSpin: number;
}

interface CustomPrize {
  id: string;
  label: string;
  type: "coin" | "ks" | "spin" | "none";
  value: number;
  weight: number;
}

interface ConfigData {
  referralTiers: ReferralTier[];
  spin: {
    spinCostCoins: number;
    weights: SpinWeights;
    customPrizes: CustomPrize[];
  };
}

const WEIGHT_ROWS: Array<{ key: keyof SpinWeights; label: string }> = [
  { key: "thanks", label: "🎉 Thank You" },
  { key: "coins50", label: "🪙 50 Coins" },
  { key: "coins200", label: "🪙 200 Coins" },
  { key: "coins500", label: "🪙 500 Coins" },
  { key: "ks1000", label: "💰 1,000 KS" },
  { key: "ks5000", label: "💰 5,000 KS" },
  { key: "freeSpin", label: "🎰 Free Spin" },
];

const PRIZE_TYPES: Array<{ value: CustomPrize["type"]; label: string }> = [
  { value: "coin", label: "Coins" },
  { value: "ks", label: "KS" },
  { value: "spin", label: "Free Spin" },
  { value: "none", label: "Thank You" },
];

export default function AdminConfig() {
  const qc = useQueryClient();
  const q = useQuery<ConfigData>({
    queryKey: ["admin-config"],
    queryFn: () => api.get("/admin/config"),
  });

  return (
    <Layout title="Rewards Config" showBack showNav>
      <div className="space-y-4">
        {q.isLoading || !q.data ? (
          <>
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
          </>
        ) : (
          <>
            <ReferralTiersCard tiers={q.data.referralTiers} onSaved={() => qc.invalidateQueries({ queryKey: ["admin-config"] })} />
            <SpinWeightsCard
              spinCostCoins={q.data.spin.spinCostCoins}
              weights={q.data.spin.weights}
              onSaved={() => qc.invalidateQueries({ queryKey: ["admin-config"] })}
            />
            <CustomPrizesCard prizes={q.data.spin.customPrizes} onChanged={() => qc.invalidateQueries({ queryKey: ["admin-config"] })} />
          </>
        )}
      </div>
    </Layout>
  );
}

// ── Referral Tiers ────────────────────────────────────────────────────────────

function ReferralTiersCard({ tiers, onSaved }: { tiers: ReferralTier[]; onSaved: () => void }) {
  const [rows, setRows] = useState<ReferralTier[]>(tiers);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setRows(tiers); }, [tiers]);

  const save = useMutation({
    mutationFn: (payload: ReferralTier[]) => api.put("/admin/config/referral-tiers", { tiers: payload }),
    onSuccess: () => { haptic("success"); setErr(null); onSaved(); },
    onError: (e: unknown) => { haptic("error"); setErr(e instanceof Error ? e.message : "Save failed"); },
  });

  const update = (i: number, patch: Partial<ReferralTier>) =>
    setRows((r) => r.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const remove = (i: number) => { haptic("selection"); setRows((r) => r.filter((_, idx) => idx !== i)); };
  const add = () => { haptic("selection"); setRows((r) => [...r, { minRefs: 0, rate: 1, label: "New Tier", emoji: "🏅" }]); };

  return (
    <Glass className="p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Trophy className="h-4 w-4 text-primary" /> Referral Commission Tiers
      </div>
      <p className="text-[11px] text-white/40">
        Commission % paid to the referrer, based on how many successful referrals they have.
      </p>

      <div className="space-y-2">
        {rows.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={t.emoji}
              onChange={(e) => update(i, { emoji: e.target.value })}
              className="w-10 text-center bg-white/5 rounded-lg py-2 text-sm"
              maxLength={2}
            />
            <input
              value={t.label}
              onChange={(e) => update(i, { label: e.target.value })}
              className="flex-1 min-w-0 bg-white/5 rounded-lg px-2 py-2 text-sm"
              placeholder="Label"
            />
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-white/40">≥</span>
              <input
                type="number"
                value={t.minRefs}
                onChange={(e) => update(i, { minRefs: Number(e.target.value) })}
                className="w-14 bg-white/5 rounded-lg px-2 py-2 text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={t.rate}
                onChange={(e) => update(i, { rate: Number(e.target.value) })}
                className="w-14 bg-white/5 rounded-lg px-2 py-2 text-sm text-center"
              />
              <span className="text-[10px] text-white/40">%</span>
            </div>
            <button onClick={() => remove(i)} className="text-red-400/70 pressable p-1">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <button onClick={add} className="w-full glass rounded-xl py-2 text-xs flex items-center justify-center gap-1.5 pressable">
        <Plus className="h-3.5 w-3.5" /> Add Tier
      </button>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <button
        onClick={() => { haptic("medium"); save.mutate(rows); }}
        disabled={save.isPending}
        className="w-full bg-primary text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-1.5 pressable disabled:opacity-50"
      >
        <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save Tiers"}
      </button>
    </Glass>
  );
}

// ── Spin Weights + Cost ───────────────────────────────────────────────────────

function SpinWeightsCard({
  spinCostCoins,
  weights,
  onSaved,
}: {
  spinCostCoins: number;
  weights: SpinWeights;
  onSaved: () => void;
}) {
  const [cost, setCost] = useState(spinCostCoins);
  const [w, setW] = useState<SpinWeights>(weights);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setCost(spinCostCoins); setW(weights); }, [spinCostCoins, weights]);

  const total = WEIGHT_ROWS.reduce((s, r) => s + (Number(w[r.key]) || 0), 0);

  const save = useMutation({
    mutationFn: () => api.put("/admin/config/spin", { spinCostCoins: cost, weights: w }),
    onSuccess: () => { haptic("success"); setErr(null); onSaved(); },
    onError: (e: unknown) => { haptic("error"); setErr(e instanceof Error ? e.message : "Save failed"); },
  });

  return (
    <Glass className="p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Gift className="h-4 w-4 text-primary" /> Spin Wheel — Odds & Cost
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm">Paid spin cost</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={cost}
            onChange={(e) => setCost(Number(e.target.value))}
            className="w-20 bg-white/5 rounded-lg px-2 py-2 text-sm text-center"
          />
          <span className="text-[10px] text-white/40">coins</span>
        </div>
      </div>

      <div className="space-y-2 pt-1">
        <p className="text-[11px] text-white/40">
          Weight = relative chance. Higher weight means more likely. (Total: {total})
        </p>
        {WEIGHT_ROWS.map((r) => {
          const val = Number(w[r.key]) || 0;
          const pct = total > 0 ? Math.round((val / total) * 100) : 0;
          return (
            <div key={r.key} className="flex items-center gap-2">
              <span className="flex-1 text-sm">{r.label}</span>
              <span className="text-[10px] text-white/40 w-9 text-right">{pct}%</span>
              <input
                type="number"
                value={val}
                onChange={(e) => setW((prev) => ({ ...prev, [r.key]: Number(e.target.value) }))}
                className="w-16 bg-white/5 rounded-lg px-2 py-2 text-sm text-center"
              />
            </div>
          );
        })}
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <button
        onClick={() => { haptic("medium"); save.mutate(); }}
        disabled={save.isPending}
        className="w-full bg-primary text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-1.5 pressable disabled:opacity-50"
      >
        <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save Spin Settings"}
      </button>
    </Glass>
  );
}

// ── Custom Spin Prizes ────────────────────────────────────────────────────────

function CustomPrizesCard({ prizes, onChanged }: { prizes: CustomPrize[]; onChanged: () => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomPrize["type"]>("coin");
  const [value, setValue] = useState(0);
  const [weight, setWeight] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.post("/admin/config/spin/prizes", { label, type, value, weight }),
    onSuccess: () => {
      haptic("success"); setErr(null); setLabel(""); setValue(0); setWeight(1); setType("coin"); onChanged();
    },
    onError: (e: unknown) => { haptic("error"); setErr(e instanceof Error ? e.message : "Add failed"); },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/admin/config/spin/prizes/${id}`),
    onSuccess: () => { haptic("success"); onChanged(); },
    onError: () => { haptic("error"); },
  });

  return (
    <Glass className="p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Gift className="h-4 w-4 text-primary" /> Custom Spin Prizes
      </div>

      {prizes.length === 0 ? (
        <p className="text-center text-xs text-white/40 py-2">No custom prizes yet</p>
      ) : (
        <div className="divide-y divide-white/5">
          {prizes.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2 gap-2">
              <div className="min-w-0">
                <p className="text-sm truncate">{p.label}</p>
                <p className="text-[10px] text-white/40">
                  {p.type}{p.value ? ` · ${p.value}` : ""} · weight {p.weight}
                </p>
              </div>
              <button
                onClick={() => { haptic("selection"); del.mutate(p.id); }}
                disabled={del.isPending}
                className="text-red-400/70 pressable p-1 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="space-y-2 pt-1 border-t border-white/5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Prize label (e.g. 🎁 Mystery Box)"
          className="w-full bg-white/5 rounded-lg px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CustomPrize["type"])}
            className="flex-1 bg-white/5 rounded-lg px-2 py-2 text-sm"
          >
            {PRIZE_TYPES.map((t) => (
              <option key={t.value} value={t.value} className="bg-[#1a1a2e]">{t.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-white/40">val</span>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              disabled={type === "none" || type === "spin"}
              className="w-16 bg-white/5 rounded-lg px-2 py-2 text-sm text-center disabled:opacity-40"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-white/40">wt</span>
            <input
              type="number"
              value={weight}
              onChange={(e) => setWeight(Number(e.target.value))}
              className="w-14 bg-white/5 rounded-lg px-2 py-2 text-sm text-center"
            />
          </div>
        </div>

        {err && <p className="text-xs text-red-400">{err}</p>}

        <button
          onClick={() => { haptic("medium"); add.mutate(); }}
          disabled={add.isPending || !label.trim()}
          className="w-full glass rounded-xl py-2 text-xs flex items-center justify-center gap-1.5 pressable disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> {add.isPending ? "Adding…" : "Add Prize"}
        </button>
      </div>
    </Glass>
  );
}
