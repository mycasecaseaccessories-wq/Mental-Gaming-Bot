import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Wallet as WalletIcon, ShoppingBag, LogOut, HelpCircle, Crown, Gamepad2, ShieldCheck, Bell, TrendingUp, BookUser, Star, Settings as SettingsIcon } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, type Me } from "@/lib/api";
import { ks, coin } from "@/lib/format";
import { getTg, haptic } from "@/lib/telegram";

const TIER_EMOJI: Record<string, string> = {
  Bronze: "🥉", Silver: "🥈", Gold: "🥇", Platinum: "🪙", Diamond: "💎",
};

const TIER_ORDER = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const TIER_NEXT: Record<string, string | null> = {
  Bronze: "Silver", Silver: "Gold", Gold: "Platinum", Platinum: "Diamond", Diamond: null,
};
const TIER_THRESHOLDS: Record<string, number> = {
  Bronze: 0, Silver: 500_000, Gold: 2_000_000, Platinum: 6_000_000, Diamond: 10_000_000,
};

function tierProgress(yearlySpend: number, activeTier: string): number {
  const next = TIER_NEXT[activeTier];
  if (!next) return 100;
  const curr = TIER_THRESHOLDS[activeTier] ?? 0;
  const goal = TIER_THRESHOLDS[next] ?? 1;
  return Math.min(100, Math.round(((yearlySpend - curr) / (goal - curr)) * 100));
}

export default function ProfilePage() {
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const adminQ = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => api.get<{ isAdmin: boolean; role: string }>("/admin/me"),
    retry: false,
    staleTime: Infinity,
  });

  const isAdmin = adminQ.data?.isAdmin === true;

  return (
    <Layout title="Profile" showNav>
      <div className="space-y-4 pt-1">
        {meQ.isLoading ? (
          <Skeleton className="h-32" />
        ) : meQ.data ? (
          <>
            {/* Avatar / name card */}
            <Glass variant="strong" className="p-5 flex items-center gap-4">
              <div className="h-16 w-16 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-2xl overflow-hidden">
                {meQ.data.photoUrl ? (
                  <img src={meQ.data.photoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span>{(meQ.data.firstName || "?").slice(0, 1).toUpperCase()}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-lg truncate">
                  {meQ.data.firstName || "Guest"}
                </div>
                {meQ.data.username && (
                  <div className="text-xs text-muted-foreground truncate">@{meQ.data.username}</div>
                )}
                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">
                    <Crown className="h-3 w-3" /> {meQ.data.tier} member
                  </span>
                </div>
              </div>
            </Glass>

            {/* Wallet stats */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="Wallet"
                value={ks(meQ.data.balanceKS)}
                sub={`+ ${coin(meQ.data.balanceCoin)}`}
              />
              <StatCard
                label="Total Deposits"
                value={ks(meQ.data.totalDeposited)}
                sub={`${meQ.data.tier} tier`}
              />
            </div>

            {/* Dual Tier Card */}
            <Glass className="p-4 space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <TrendingUp className="h-3.5 w-3.5" /> Loyalty Tiers
              </div>

              {/* Active Tier (yearly spend) */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-lg">{TIER_EMOJI[meQ.data.activeTier] ?? "🥉"}</span>
                    <div>
                      <div className="text-sm font-semibold">{meQ.data.activeTier} (Active)</div>
                      <div className="text-[10px] text-muted-foreground">Based on last 12 months</div>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground text-right">
                    <div>{ks(meQ.data.yearlySpend)}</div>
                    {TIER_NEXT[meQ.data.activeTier] && (
                      <div className="text-[10px]">
                        / {ks(TIER_THRESHOLDS[TIER_NEXT[meQ.data.activeTier]!] ?? 0)}
                      </div>
                    )}
                  </div>
                </div>
                {TIER_NEXT[meQ.data.activeTier] && (
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${tierProgress(meQ.data.yearlySpend, meQ.data.activeTier)}%` }}
                    />
                  </div>
                )}
                {TIER_NEXT[meQ.data.activeTier] && (
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {ks(Math.max(0, (TIER_THRESHOLDS[TIER_NEXT[meQ.data.activeTier]!] ?? 0) - meQ.data.yearlySpend))} more to{" "}
                    {TIER_EMOJI[TIER_NEXT[meQ.data.activeTier]!]} {TIER_NEXT[meQ.data.activeTier]}
                  </div>
                )}
              </div>

              {/* Lifetime Tier */}
              <div className="flex items-center justify-between pt-2 border-t border-white/5">
                <div className="flex items-center gap-1.5">
                  <span className="text-base">{TIER_EMOJI[meQ.data.lifetimeTier] ?? "🥉"}</span>
                  <div>
                    <div className="text-xs font-medium">{meQ.data.lifetimeTier} (Lifetime)</div>
                    <div className="text-[10px] text-muted-foreground">Never decreases</div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">{ks(meQ.data.lifetimeSpend)} total</div>
              </div>
            </Glass>

            {/* Nav menu */}
            <Glass className="divide-y divide-white/5">
              <NavRow href="/wallet"        icon={<WalletIcon className="h-4 w-4" />}   label="Wallet & transactions" />
              <NavRow href="/orders"        icon={<ShoppingBag className="h-4 w-4" />}   label="My orders" />
              <NavRow href="/addresses"     icon={<BookUser className="h-4 w-4" />}      label="Saved game IDs" />
              <NavRow href="/notifications" icon={<Bell className="h-4 w-4" />}          label="Notifications" />
              <NavRow href="/play"          icon={<Gamepad2 className="h-4 w-4" />}      label="Spin, check-in & referral" />
              <NavRow href="/reviews"       icon={<Star className="h-4 w-4" />}          label="Reviews" />
              <NavRow href="/faq"           icon={<HelpCircle className="h-4 w-4" />}    label="Help center (FAQ)" />
              <NavRow href="/settings"      icon={<SettingsIcon className="h-4 w-4" />}  label="Settings" />
              <NavRow href="/support"       icon={<HelpCircle className="h-4 w-4" />}    label="Contact support" />
              {isAdmin && (
                <NavRow href="/admin"       icon={<ShieldCheck className="h-4 w-4" />}   label="Admin Panel" />
              )}
              <NavRow
                href="#"
                icon={<LogOut className="h-4 w-4" />}
                label="Close app"
                onClick={(e) => {
                  e.preventDefault();
                  haptic("light");
                  const tg = getTg();
                  tg?.close();
                }}
              />
            </Glass>

            <div className="text-center text-[10px] text-muted-foreground pt-2">
              Mental Gaming Store · Mini App
            </div>
          </>
        ) : null}
      </div>
    </Layout>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Glass className="p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </Glass>
  );
}

function NavRow({
  href,
  icon,
  label,
  onClick,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <Link href={href}>
      <a
        onClick={onClick}
        className="pressable flex items-center gap-3 px-4 py-3.5"
        data-testid={`nav-${label}`}
      >
        <div className="h-8 w-8 rounded-full bg-white/5 flex items-center justify-center">{icon}</div>
        <span className="flex-1 text-sm font-medium">{label}</span>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </a>
    </Link>
  );
}
