import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Clock, XCircle, RefreshCw, ChevronRight } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { haptic } from "@/lib/telegram";
import { ks as formatKS } from "@/lib/format";

type OrderStatus = "Pending" | "Processing" | "Success" | "Cancelled";

interface OrderUser { id: string; telegramId: number; name: string; username?: string; tier: string }
interface CheckoutField { key: string; label: string; value: string }
interface Order {
  id: string;
  shortId?: string;
  status: string;
  productName?: string;
  productType?: string;
  gameId?: string;
  zoneId?: string;
  checkoutData?: CheckoutField[];
  totalKS?: number;
  timestamp: string;
  user: OrderUser | null;
}
interface OrdersResponse { items: Order[]; total: number; page: number; pages: number }

const TABS: OrderStatus[] = ["Pending", "Processing", "Success", "Cancelled"];

const statusIcon = {
  Pending: <Clock className="h-3.5 w-3.5 text-orange-400" />,
  Processing: <RefreshCw className="h-3.5 w-3.5 text-blue-400" />,
  Success: <CheckCircle className="h-3.5 w-3.5 text-green-400" />,
  Cancelled: <XCircle className="h-3.5 w-3.5 text-red-400" />,
};

export default function AdminOrders() {
  const [tab, setTab] = useState<OrderStatus>("Pending");
  const [actionId, setActionId] = useState<string | null>(null);
  const qc = useQueryClient();

  const q = useQuery<OrdersResponse>({
    queryKey: ["admin-orders", tab],
    queryFn: () => api.get(`/admin/orders?status=${tab}`),
    refetchInterval: 15_000,
  });

  const patch = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: string; note?: string }) =>
      api.patch(`/admin/orders/${id}`, { status, note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-orders"] });
      qc.invalidateQueries({ queryKey: ["admin-summary"] });
      setActionId(null);
      haptic("success");
    },
  });

  return (
    <Layout title="Orders" showBack showNav>
      <div className="space-y-3">
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium pressable ${
                tab === t ? "bg-primary text-white" : "glass text-white/60"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {q.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
        ) : !q.data?.items.length ? (
          <Glass className="p-8 text-center text-sm text-white/40">No {tab.toLowerCase()} orders</Glass>
        ) : (
          q.data.items.map((o) => (
            <Glass key={o.id} className="p-4 space-y-3">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {statusIcon[o.status as OrderStatus] ?? <ChevronRight className="h-3.5 w-3.5" />}
                    <span className="text-xs font-mono text-white/50">#{o.shortId ?? o.id.slice(-6)}</span>
                  </div>
                  <p className="text-sm font-medium truncate">{o.productName ?? o.productType ?? "Order"}</p>
                  {o.checkoutData && o.checkoutData.length > 0 ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      {o.checkoutData.map((d) => (
                        <p key={d.key} className="text-xs text-white/40">
                          <span className="text-white/25">{d.label}:</span> {d.value}
                        </p>
                      ))}
                    </div>
                  ) : o.gameId ? (
                    <p className="text-xs text-white/40">
                      <span className="text-white/25">Game ID:</span> {o.gameId}
                      {o.zoneId && <><span className="text-white/25 ml-2">Server:</span> {o.zoneId}</>}
                    </p>
                  ) : null}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-primary">{o.totalKS ? formatKS(o.totalKS) : "—"}</p>
                  <p className="text-[10px] text-white/40">{new Date(o.timestamp).toLocaleDateString()}</p>
                </div>
              </div>

              {/* User */}
              {o.user && (
                <div className="text-xs text-white/50 flex gap-1">
                  <span className="font-medium text-white/70">{o.user.name}</span>
                  {o.user.username && <span>@{o.user.username}</span>}
                  <span className="ml-auto">{o.user.tier}</span>
                </div>
              )}

              {/* Action buttons — Pending → Processing or Cancel; Processing → Success or Cancel */}
              {(o.status === "Pending" || o.status === "Processing") && (
                <div className="flex gap-2 pt-1">
                  {o.status === "Pending" && (
                    <ActionBtn
                      label="Processing"
                      color="blue"
                      loading={patch.isPending && actionId === o.id + "P"}
                      onClick={() => {
                        setActionId(o.id + "P");
                        patch.mutate({ id: o.id, status: "Processing" });
                      }}
                    />
                  )}
                  {o.status === "Processing" && (
                    <ActionBtn
                      label="✓ Complete"
                      color="green"
                      loading={patch.isPending && actionId === o.id + "S"}
                      onClick={() => {
                        setActionId(o.id + "S");
                        patch.mutate({ id: o.id, status: "Success" });
                      }}
                    />
                  )}
                  <ActionBtn
                    label="Cancel"
                    color="red"
                    loading={patch.isPending && actionId === o.id + "C"}
                    onClick={() => {
                      setActionId(o.id + "C");
                      patch.mutate({ id: o.id, status: "Cancelled" });
                    }}
                  />
                </div>
              )}
            </Glass>
          ))
        )}
      </div>
    </Layout>
  );
}

function ActionBtn({
  label,
  color,
  loading,
  onClick,
}: {
  label: string;
  color: "blue" | "green" | "red";
  loading: boolean;
  onClick: () => void;
}) {
  const colors = {
    blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    green: "bg-green-500/20 text-green-400 border-green-500/30",
    red: "bg-red-500/20 text-red-400 border-red-500/30",
  };
  return (
    <button
      onClick={() => { haptic("medium"); onClick(); }}
      disabled={loading}
      className={`flex-1 py-2 rounded-xl text-xs font-semibold border pressable ${colors[color]} disabled:opacity-50`}
    >
      {loading ? "…" : label}
    </button>
  );
}
