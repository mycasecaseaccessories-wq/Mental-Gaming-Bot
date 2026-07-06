import { useState } from "react";
import { Link, useRoute, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { EmptyState, Skeleton } from "@/components/EmptyState";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";
import { api, type OrderSummary, type OrderDetail, type OrderStatus } from "@/lib/api";
import { ks, timeAgo, cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

const FILTERS: ("All" | OrderStatus)[] = ["All", "Pending", "Processing", "Success", "Cancelled"];

export default function MyOrdersPage() {
  const [matchDetail, params] = useRoute<{ id: string }>("/orders/:id");
  if (matchDetail && params?.id) return <OrderDetailView id={params.id} />;
  return <OrdersListView />;
}

function OrdersListView() {
  const [filter, setFilter] = useState<"All" | OrderStatus>("All");
  const oQ = useQuery({
    queryKey: ["orders", filter],
    queryFn: () =>
      api.get<{ orders: OrderSummary[] }>(
        `/orders${filter === "All" ? "" : `?status=${filter}`}`
      ),
  });

  return (
    <Layout title="My Orders" showNav>
      <div className="space-y-3 pt-1">
        <div className="flex gap-2 overflow-x-auto scrollbar-hide">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => { haptic("selection"); setFilter(f); }}
              className={cn(
                "pressable shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium border",
                filter === f ? "bg-primary text-white border-primary" : "glass border-white/10 text-muted-foreground"
              )}
              data-testid={`filter-${f}`}
            >
              {f}
            </button>
          ))}
        </div>

        {oQ.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : !oQ.data || oQ.data.orders.length === 0 ? (
          <EmptyState
            icon={<ShoppingBag className="h-8 w-8" />}
            title="No orders yet"
            hint="Your purchases will appear here."
            action={
              <Link href="/shop" className="pressable bg-primary text-white px-5 py-2.5 rounded-xl text-sm font-semibold">
                Browse shop
              </Link>
            }
          />
        ) : (
          <div className="space-y-2">
            {oQ.data.orders.map((o) => (
              <Link key={o.id} href={`/orders/${o.id}`} data-testid={`order-${o.id}`}>
                <Glass className="pressable p-3 flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center overflow-hidden text-xl">
                    {o.productImage
                      ? <img src={o.productImage} alt="" className="w-full h-full object-cover" />
                      : <span>🎮</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{o.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      #{o.shortId} · {timeAgo(o.timestamp)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">{ks(o.amount)}</div>
                    <div className="mt-1"><OrderStatusBadge status={o.status} /></div>
                  </div>
                </Glass>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

function OrderDetailView({ id }: { id: string }) {
  const search = useSearch();
  const justPlaced = new URLSearchParams(search).get("placed") === "1";
  const oQ = useQuery({
    queryKey: ["order", id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
    refetchInterval: 15000,
  });

  return (
    <Layout title="Order" showBack showNav={false}>
      {oQ.isLoading ? (
        <Skeleton className="h-64" />
      ) : !oQ.data ? (
        <EmptyState title="Order not found" />
      ) : (
        <div className="space-y-4">
          {justPlaced && (
            <Glass variant="blue" className="p-4 text-sm">
              ✅ Order placed! We'll update this page as it progresses.
            </Glass>
          )}

          <Glass className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Order #{oQ.data.shortId}</div>
                <h2 className="text-lg font-bold mt-0.5 truncate">{oQ.data.product?.name || "Order"}</h2>
                <div className="text-xs text-muted-foreground">{timeAgo(oQ.data.timestamp)}</div>
              </div>
              <OrderStatusBadge status={oQ.data.status} />
            </div>
            {/* Dynamic checkout fields (new) */}
            {oQ.data.checkoutData && oQ.data.checkoutData.length > 0 ? (
              <div className="mt-3 text-xs grid grid-cols-2 gap-2">
                {oQ.data.checkoutData.map((d) => (
                  <div key={d.key} className="glass-strong rounded-xl px-3 py-2">
                    <div className="text-muted-foreground text-[10px] uppercase">{d.label}</div>
                    <div className="font-mono truncate">{d.value}</div>
                  </div>
                ))}
              </div>
            ) : (oQ.data.gameId || oQ.data.zoneId) ? (
              <div className="mt-3 text-xs grid grid-cols-2 gap-2">
                {oQ.data.gameId && (
                  <div className="glass-strong rounded-xl px-3 py-2">
                    <div className="text-muted-foreground text-[10px] uppercase">Game ID</div>
                    <div className="font-mono">{oQ.data.gameId}</div>
                  </div>
                )}
                {oQ.data.zoneId && (
                  <div className="glass-strong rounded-xl px-3 py-2">
                    <div className="text-muted-foreground text-[10px] uppercase">Zone</div>
                    <div className="font-mono">{oQ.data.zoneId}</div>
                  </div>
                )}
              </div>
            ) : null}
          </Glass>

          <Glass className="p-4 space-y-1.5 text-sm">
            {oQ.data.originalAmount && oQ.data.originalAmount !== oQ.data.amount && (
              <Row label="Subtotal">{ks(oQ.data.originalAmount)}</Row>
            )}
            {oQ.data.tierDiscount > 0 && (
              <Row label="Tier discount" className="text-emerald-300">− {ks(oQ.data.tierDiscount)}</Row>
            )}
            <div className="border-t border-white/10 my-2" />
            <Row label="Paid" bold>{ks(oQ.data.amount)}</Row>
          </Glass>

          {oQ.data.notes && (
            <Glass className="p-4 text-sm text-muted-foreground whitespace-pre-wrap">{oQ.data.notes}</Glass>
          )}
        </div>
      )}
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
