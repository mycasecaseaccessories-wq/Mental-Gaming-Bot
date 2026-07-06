import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldCheck, ChevronRight, Wallet, Package, Users, BarChart3, Gift, CreditCard, FileSpreadsheet } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";

interface Summary { pendingOrders: number; processingOrders: number; pendingTopups: number }
interface AdminMe { isAdmin: boolean; role: string }

export default function AdminDashboard() {
  const meQ = useQuery<AdminMe>({
    queryKey: ["admin-me"],
    queryFn: () => api.get("/admin/me"),
  });
  const sumQ = useQuery<Summary>({
    queryKey: ["admin-summary"],
    queryFn: () => api.get("/admin/summary"),
    refetchInterval: 30_000,
  });

  if (meQ.isError) {
    return (
      <Layout title="Admin" showBack showNav>
        <Glass className="p-6 text-center text-sm text-white/60">Access denied</Glass>
      </Layout>
    );
  }

  return (
    <Layout title="Admin Panel" showBack showNav>
      <div className="space-y-4">
        {/* Role badge */}
        <Glass className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/20 flex items-center justify-center">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Admin Panel</p>
            {meQ.data ? (
              <p className="text-xs text-white/50">{meQ.data.role}</p>
            ) : (
              <Skeleton className="h-3 w-16 mt-1" />
            )}
          </div>
        </Glass>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-2">
          {sumQ.isLoading ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
          ) : (
            <>
              <SummaryCard
                label="Pending Orders"
                value={sumQ.data?.pendingOrders ?? 0}
                color="text-orange-400"
                urgent={(sumQ.data?.pendingOrders ?? 0) > 0}
              />
              <SummaryCard
                label="Processing"
                value={sumQ.data?.processingOrders ?? 0}
                color="text-blue-400"
              />
              <SummaryCard
                label="Pending Topups"
                value={sumQ.data?.pendingTopups ?? 0}
                color="text-yellow-400"
                urgent={(sumQ.data?.pendingTopups ?? 0) > 0}
              />
            </>
          )}
        </div>

        {/* Navigation cards */}
        <Glass className="divide-y divide-white/5">
          <NavRow
            href="/admin/orders"
            icon={<Package className="h-4 w-4" />}
            label="Order Management"
            badge={sumQ.data ? sumQ.data.pendingOrders + sumQ.data.processingOrders : undefined}
          />
          <NavRow
            href="/admin/topups"
            icon={<Wallet className="h-4 w-4" />}
            label="Topup Approvals"
            badge={sumQ.data?.pendingTopups}
          />
          <NavRow
            href="/admin/users"
            icon={<Users className="h-4 w-4" />}
            label="User Management"
          />
          <NavRow
            href="/admin/analytics"
            icon={<BarChart3 className="h-4 w-4" />}
            label="Analytics"
          />
          <NavRow
            href="/admin/config"
            icon={<Gift className="h-4 w-4" />}
            label="Rewards Config"
          />
          <NavRow
            href="/admin/gateways"
            icon={<CreditCard className="h-4 w-4" />}
            label="Gateway Control"
          />
          <NavRow
            href="/admin/export"
            icon={<FileSpreadsheet className="h-4 w-4" />}
            label="Financial Export"
          />
        </Glass>
      </div>
    </Layout>
  );
}

function SummaryCard({
  label,
  value,
  color,
  urgent,
}: {
  label: string;
  value: number;
  color: string;
  urgent?: boolean;
}) {
  return (
    <Glass className={`p-3 flex flex-col items-center gap-1 text-center ${urgent ? "ring-1 ring-orange-400/40" : ""}`}>
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-[10px] text-white/50 leading-tight">{label}</span>
    </Glass>
  );
}

function NavRow({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <Link href={href}>
      <div className="flex items-center gap-3 px-4 py-3.5 pressable">
        <span className="text-primary">{icon}</span>
        <span className="flex-1 text-sm font-medium">{label}</span>
        {badge !== undefined && badge > 0 && (
          <span className="bg-primary text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
            {badge}
          </span>
        )}
        <ChevronRight className="h-4 w-4 text-white/30" />
      </div>
    </Link>
  );
}
