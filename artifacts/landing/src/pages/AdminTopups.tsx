import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, XCircle, ImageOff } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { haptic, getTg } from "@/lib/telegram";
import { ks as formatKS } from "@/lib/format";

interface TopupUser { id: string; telegramId: number; name: string; username?: string; tier: string; balanceKS: number }
interface Topup {
  id: string;
  txId?: string;
  amount: number;
  amountDisplay: string;
  paymentMethod?: string;
  screenshotUrl?: string;
  timestamp: string;
  user: TopupUser | null;
}
interface TopupsResponse { items: Topup[]; total: number }

interface ApproveResult { ok: boolean; amountKS: number; bonusCoins: number; newTier: string }

export default function AdminTopups() {
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const qc = useQueryClient();

  const q = useQuery<TopupsResponse>({
    queryKey: ["admin-topups"],
    queryFn: () => api.get("/admin/topups"),
    refetchInterval: 15_000,
  });

  const approve = useMutation<ApproveResult, Error, string>({
    mutationFn: (id) => api.patch(`/admin/topups/${id}/approve`, {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["admin-topups"] });
      qc.invalidateQueries({ queryKey: ["admin-summary"] });
      haptic("success");
      const tg = getTg();
      tg?.showAlert(`✅ Approved +${data.amountKS.toLocaleString()} Ks\n🎁 Bonus: ${data.bonusCoins} coins\n🏆 Tier: ${data.newTier}`);
    },
    onError: (err) => {
      haptic("error");
      const tg = getTg();
      tg?.showAlert(`Error: ${err.message}`);
    },
  });

  const reject = useMutation<{ ok: boolean }, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.patch(`/admin/topups/${id}/reject`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-topups"] });
      qc.invalidateQueries({ queryKey: ["admin-summary"] });
      haptic("success");
      setRejectId(null);
      setRejectReason("");
    },
  });

  function openScreenshot(url?: string) {
    if (!url) return;
    window.open(
      `https://api.telegram.org/file/bot${import.meta.env.VITE_BOT_TOKEN ?? ""}/${url}`,
      "_blank",
    );
  }

  return (
    <Layout title="Topup Approvals" showBack showNav>
      <div className="space-y-3">
        {q.isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-2xl" />)
        ) : !q.data?.items.length ? (
          <Glass className="p-8 text-center text-sm text-white/40">No pending top-ups 🎉</Glass>
        ) : (
          q.data.items.map((t) => (
            <Glass key={t.id} className="p-4 space-y-3">
              {/* Amount + method */}
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-lg font-bold text-primary">{t.amountDisplay}</p>
                  <p className="text-xs text-white/50">{t.paymentMethod ?? "Unknown"}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-white/40">{new Date(t.timestamp).toLocaleString()}</p>
                  {t.txId && <p className="text-[10px] font-mono text-white/30 mt-0.5">{t.txId.slice(0, 12)}…</p>}
                </div>
              </div>

              {/* User info */}
              {t.user && (
                <div className="flex items-center gap-2 text-xs">
                  <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-[10px] font-bold">
                    {t.user.name[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{t.user.name}</p>
                    <p className="text-white/40">{t.user.tier} · {formatKS(t.user.balanceKS)} balance</p>
                  </div>
                </div>
              )}

              {/* Screenshot */}
              <button
                onClick={() => openScreenshot(t.screenshotUrl)}
                className="w-full rounded-xl bg-white/5 border border-white/10 py-2.5 flex items-center justify-center gap-2 text-xs text-white/60 pressable"
              >
                {t.screenshotUrl ? (
                  <>📸 View Screenshot</>
                ) : (
                  <><ImageOff className="h-3.5 w-3.5" /> No screenshot</>
                )}
              </button>

              {/* Actions */}
              {rejectId === t.id ? (
                <div className="space-y-2">
                  <input
                    autoFocus
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Rejection reason…"
                    className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2 text-sm placeholder:text-white/30 focus:outline-none focus:border-primary/60"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setRejectId(null); setRejectReason(""); }}
                      className="flex-1 py-2 rounded-xl text-xs font-medium glass text-white/60 pressable"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { haptic("medium"); reject.mutate({ id: t.id, reason: rejectReason }); }}
                      disabled={reject.isPending}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 pressable disabled:opacity-50"
                    >
                      {reject.isPending ? "…" : "Confirm Reject"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => { haptic("medium"); approve.mutate(t.id); }}
                    disabled={approve.isPending}
                    className="flex-1 py-2 rounded-xl text-xs font-semibold bg-green-500/20 text-green-400 border border-green-500/30 pressable disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    <CheckCircle className="h-3.5 w-3.5" />
                    {approve.isPending ? "…" : "Approve"}
                  </button>
                  <button
                    onClick={() => { haptic("medium"); setRejectId(t.id); }}
                    className="flex-1 py-2 rounded-xl text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 pressable flex items-center justify-center gap-1"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </button>
                </div>
              )}
            </Glass>
          ))
        )}
      </div>
    </Layout>
  );
}
