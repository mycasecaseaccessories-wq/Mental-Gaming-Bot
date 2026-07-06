import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Save } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { haptic } from "@/lib/telegram";

type GatewayStatus = "Online" | "Busy" | "Offline";

interface GatewaysData {
  gateways: {
    kpay: GatewayStatus;
    wave: GatewayStatus;
    aya: GatewayStatus;
    cb: GatewayStatus;
  };
  note: string | null;
}

const GATEWAYS: Array<{ key: keyof GatewaysData["gateways"]; label: string; emoji: string }> = [
  { key: "kpay", label: "KPay", emoji: "💜" },
  { key: "wave", label: "Wave Pay", emoji: "💙" },
  { key: "aya", label: "AYA Pay", emoji: "❤️" },
  { key: "cb", label: "CB Pay", emoji: "💚" },
];

const STATUSES: Array<{ value: GatewayStatus; label: string; cls: string }> = [
  { value: "Online", label: "Online", cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" },
  { value: "Busy", label: "Busy", cls: "bg-amber-500/20 text-amber-300 border-amber-500/40" },
  { value: "Offline", label: "Offline", cls: "bg-rose-500/20 text-rose-300 border-rose-500/40" },
];

export default function AdminGateways() {
  const qc = useQueryClient();
  const q = useQuery<GatewaysData>({
    queryKey: ["admin-gateways"],
    queryFn: () => api.get("/admin/gateways"),
  });

  return (
    <Layout title="Gateway Control" showBack showNav>
      <div className="space-y-4">
        {q.isLoading || !q.data ? (
          <>
            <Skeleton className="h-64 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </>
        ) : (
          <GatewayEditor
            data={q.data}
            onSaved={() => qc.invalidateQueries({ queryKey: ["admin-gateways"] })}
          />
        )}
      </div>
    </Layout>
  );
}

function GatewayEditor({ data, onSaved }: { data: GatewaysData; onSaved: () => void }) {
  const [gateways, setGateways] = useState(data.gateways);
  const [note, setNote] = useState(data.note ?? "");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setGateways(data.gateways);
    setNote(data.note ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.put("/admin/gateways", {
        gateways,
        note: note.trim() ? note.trim() : null,
      }),
    onSuccess: () => { haptic("success"); setErr(null); onSaved(); },
    onError: (e: unknown) => { haptic("error"); setErr(e instanceof Error ? e.message : "Save failed"); },
  });

  const setStatus = (key: keyof GatewaysData["gateways"], status: GatewayStatus) => {
    haptic("selection");
    setGateways((g) => ({ ...g, [key]: status }));
  };

  return (
    <>
      <Glass className="p-4 space-y-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <CreditCard className="h-4 w-4 text-primary" /> Payment Gateways
        </div>
        <p className="text-[11px] text-white/40">
          Set each gateway Online, Busy, or Offline. Offline gateways block new top-ups in
          both the bot and mini app.
        </p>

        <div className="space-y-3">
          {GATEWAYS.map((gw) => (
            <div key={gw.key} className="space-y-1.5">
              <div className="text-sm font-medium">
                {gw.emoji} {gw.label}
              </div>
              <div className="flex gap-2">
                {STATUSES.map((s) => {
                  const active = gateways[gw.key] === s.value;
                  return (
                    <button
                      key={s.value}
                      onClick={() => setStatus(gw.key, s.value)}
                      className={`flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition ${
                        active ? s.cls : "border-white/10 text-white/50"
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Glass>

      <Glass className="p-4 space-y-2">
        <div className="text-sm font-medium">Gateway Note (optional)</div>
        <p className="text-[11px] text-white/40">
          Shown to customers when a gateway is unavailable (e.g. "KPay slow due to bank
          maintenance").
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="No note"
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
      </Glass>

      {err && <p className="text-xs text-rose-400">{err}</p>}

      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save Changes"}
      </button>
    </>
  );
}
