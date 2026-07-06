import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Package, Users, AlertTriangle, Clock } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { haptic } from "@/lib/telegram";
import { ks as formatKS } from "@/lib/format";

interface Analytics {
  meta: { period: string; label: string; from: string; to: string };
  revenue: {
    grossRevenue: number; estimatedCOGS: number; netRevenue: number; netProfit: number;
    estimatedMarginPct: number;
    refunds: { total: number; count: number };
    topups: { total: number; count: number };
    orderCount: number;
    discounts: { promo: number; tier: number };
  };
  products: Array<{ name: string; category: string; revenue: number; count: number; avgOrder: number }>;
  categories: Array<{ category: string; revenue: number; count: number }>;
  users: { newUsers: number; totalUsers: number; activeUsers: number; tierBreakdown: Array<{ tier: string; count: number }> };
  gateway: Array<{ method: string; total: number; count: number }>;
  trend: Array<{ date: string; revenue: number; orders: number; topups: number }>;
  cancellation: { cancelled: number; total: number; rate: number };
  peak: { hour: number; count: number; revenue: number } | null;
}

const PERIODS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "7 Days" },
  { id: "month", label: "30 Days" },
];

export default function AdminAnalytics() {
  const [period, setPeriod] = useState("month");
  const q = useQuery<Analytics>({
    queryKey: ["admin-analytics", period],
    queryFn: () => api.get(`/admin/analytics?period=${period}`),
  });

  const d = q.data;

  return (
    <Layout title="Analytics" showBack showNav>
      <div className="space-y-4">
        {/* Period selector */}
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => { haptic("selection"); setPeriod(p.id); }}
              className={`flex-1 py-2 rounded-xl text-xs font-medium pressable transition ${
                period === p.id ? "bg-primary text-white" : "glass text-white/60"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {q.isLoading || !d ? (
          <>
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-48 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
          </>
        ) : (
          <>
            <p className="text-center text-[11px] text-white/40">{d.meta.label}</p>

            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-2">
              <Kpi label="Net Revenue" value={formatKS(d.revenue.netRevenue)} accent="text-primary" />
              <Kpi
                label="Net Profit"
                value={formatKS(d.revenue.netProfit)}
                accent={d.revenue.netProfit >= 0 ? "text-green-400" : "text-red-400"}
                sub={`${d.revenue.estimatedMarginPct}% margin`}
              />
              <Kpi label="Gross Revenue" value={formatKS(d.revenue.grossRevenue)} />
              <Kpi label="Orders" value={String(d.revenue.orderCount)} />
            </div>

            {/* Revenue trend chart */}
            <Glass className="p-4">
              <div className="flex items-center gap-1.5 mb-3 text-sm font-medium">
                <TrendingUp className="h-4 w-4 text-primary" /> Revenue Trend
              </div>
              {d.trend.length === 0 ? (
                <p className="text-center text-xs text-white/40 py-8">No data in this period</p>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={d.trend} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#a855f7" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }}
                      tickFormatter={(v) => String(v).slice(5)} minTickGap={20} />
                    <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }}
                      tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} width={40} />
                    <Tooltip
                      contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 12 }}
                      labelStyle={{ color: "rgba(255,255,255,0.6)" }}
                      formatter={(v: number) => [formatKS(v), "Revenue"]}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="#a855f7" strokeWidth={2} fill="url(#rev)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </Glass>

            {/* Secondary stats */}
            <div className="grid grid-cols-2 gap-2">
              <MiniStat icon={<Wallet className="h-3.5 w-3.5" />} label="Topups"
                value={formatKS(d.revenue.topups.total)} sub={`${d.revenue.topups.count} txns`} />
              <MiniStat icon={<TrendingDown className="h-3.5 w-3.5" />} label="Refunds"
                value={formatKS(d.revenue.refunds.total)} sub={`${d.revenue.refunds.count} txns`} />
              <MiniStat icon={<AlertTriangle className="h-3.5 w-3.5" />} label="Cancel Rate"
                value={`${d.cancellation.rate}%`} sub={`${d.cancellation.cancelled}/${d.cancellation.total}`} />
              <MiniStat icon={<Clock className="h-3.5 w-3.5" />} label="Peak Hour"
                value={d.peak ? `${String(d.peak.hour).padStart(2, "0")}:00` : "—"}
                sub={d.peak ? `${d.peak.count} orders` : "no data"} />
            </div>

            {/* Discounts given */}
            <Glass className="p-4 flex justify-between text-sm">
              <div>
                <p className="text-[10px] text-white/40">Promo Discounts</p>
                <p className="font-medium">{formatKS(d.revenue.discounts.promo)}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-white/40">Tier Discounts</p>
                <p className="font-medium">{formatKS(d.revenue.discounts.tier)}</p>
              </div>
            </Glass>

            {/* Top products */}
            <Section icon={<Package className="h-4 w-4 text-primary" />} title="Top Products">
              {d.products.length === 0 ? (
                <Empty />
              ) : (
                d.products.map((p, i) => (
                  <Row key={i} left={`${i + 1}. ${p.name}`} sub={`${p.category} · ${p.count} sold`}
                    right={formatKS(p.revenue)} />
                ))
              )}
            </Section>

            {/* Category breakdown */}
            <Section icon={<Package className="h-4 w-4 text-primary" />} title="By Category">
              {d.categories.length === 0 ? (
                <Empty />
              ) : (
                d.categories.map((c, i) => (
                  <Row key={i} left={c.category} sub={`${c.count} orders`} right={formatKS(c.revenue)} />
                ))
              )}
            </Section>

            {/* Payment gateways */}
            <Section icon={<Wallet className="h-4 w-4 text-primary" />} title="Payment Methods">
              {d.gateway.length === 0 ? (
                <Empty />
              ) : (
                d.gateway.map((g, i) => (
                  <Row key={i} left={g.method} sub={`${g.count} topups`} right={formatKS(g.total)} />
                ))
              )}
            </Section>

            {/* Users */}
            <Section icon={<Users className="h-4 w-4 text-primary" />} title="Users">
              <Row left="New users" right={String(d.users.newUsers)} />
              <Row left="Active (ordered)" right={String(d.users.activeUsers)} />
              <Row left="Total users" right={String(d.users.totalUsers)} />
              {d.users.tierBreakdown.map((t, i) => (
                <Row key={i} left={`Tier · ${t.tier}`} right={String(t.count)} />
              ))}
            </Section>
          </>
        )}
      </div>
    </Layout>
  );
}

function Kpi({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <Glass className="p-3">
      <p className="text-[10px] text-white/40">{label}</p>
      <p className={`text-lg font-bold ${accent ?? ""}`}>{value}</p>
      {sub && <p className="text-[10px] text-white/40">{sub}</p>}
    </Glass>
  );
}

function MiniStat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <Glass className="p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-white/40">{icon}{label}</div>
      <p className="text-sm font-semibold mt-0.5">{value}</p>
      <p className="text-[10px] text-white/40">{sub}</p>
    </Glass>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Glass className="p-4 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">{icon}{title}</div>
      <div className="divide-y divide-white/5">{children}</div>
    </Glass>
  );
}

function Row({ left, sub, right }: { left: string; sub?: string; right: string }) {
  return (
    <div className="flex items-center justify-between py-2 gap-2">
      <div className="min-w-0">
        <p className="text-sm truncate">{left}</p>
        {sub && <p className="text-[10px] text-white/40">{sub}</p>}
      </div>
      <span className="text-sm font-medium text-primary shrink-0">{right}</span>
    </div>
  );
}

function Empty() {
  return <p className="text-center text-xs text-white/40 py-4">No data</p>;
}
