import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { api } from "@/lib/api";
import { coin, cn } from "@/lib/format";

interface SpinStatus { canFreeSpin: boolean; nextFreeSpinMs: number; coinBalance: number; spinCostCoins: number; }
interface CheckInStatus { canCheckIn: boolean; streak: number; nextReward: { coins: number; ks: number }; }
interface ReferralData { completedCount: number; currentTier: { label: string; emoji: string } | null; nextTier: { minRefs: number } | null; }

function useCountdown(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function PlayPage() {
  const spinQ  = useQuery<SpinStatus>({ queryKey: ["spin-status"],   queryFn: () => api.get("/spin/status"),   retry: false });
  const ciQ    = useQuery<CheckInStatus>({ queryKey: ["checkin-status"], queryFn: () => api.get("/checkin/status"), retry: false });
  const refQ   = useQuery<ReferralData>({ queryKey: ["referral"],    queryFn: () => api.get("/referral"),      retry: false });

  const spin   = spinQ.data;
  const ci     = ciQ.data;
  const ref    = refQ.data;

  const cards = [
    {
      href: "/spin",
      emoji: "🎰",
      title: "Spin Wheel",
      badge: spin?.canFreeSpin ? { text: "Free spin!", color: "text-emerald-400" }
           : spin ? { text: `${useCountdown(spin.nextFreeSpinMs)} left`, color: "text-muted-foreground" }
           : null,
      sub: spin ? (spin.canFreeSpin ? "Daily free spin available" : `Or spend ${spin.spinCostCoins} MC`) : "Spin for coins & rewards",
      glow: spin?.canFreeSpin,
    },
    {
      href: "/checkin",
      emoji: "📅",
      title: "Daily Check-In",
      badge: ci?.canCheckIn ? { text: "Available!", color: "text-emerald-400" } : ci ? { text: "Done ✅", color: "text-primary" } : null,
      sub: ci ? (ci.canCheckIn ? `+${ci.nextReward.coins} MC today` : `${ci.streak} day streak 🔥`) : "Earn coins every day",
      glow: ci?.canCheckIn,
    },
    {
      href: "/referral",
      emoji: "🤝",
      title: "Referral",
      badge: ref?.currentTier ? { text: `${ref.currentTier.emoji} ${ref.currentTier.label}`, color: "text-primary" } : null,
      sub: ref ? `${ref.completedCount} friends referred` : "Earn commission on referrals",
      glow: false,
    },
    {
      href: "/redeem",
      emoji: "🎁",
      title: "Rewards & Codes",
      badge: null,
      sub: "Spend coins or redeem a code",
      glow: false,
    },
  ];

  return (
    <Layout title="Play & Earn" showNav>
      <div className="space-y-3 pt-1 pb-8">
        <div className="text-xs text-muted-foreground px-1 pb-1">Daily tasks and rewards</div>
        {cards.map((c) => (
          <Link key={c.href} href={c.href}>
            <Glass
              className={cn(
                "pressable p-5 flex items-center gap-4",
                c.glow && "ring-1 ring-primary/30"
              )}
              data-testid={`play-card-${c.href.slice(1)}`}
            >
              <div className="text-4xl">{c.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{c.title}</span>
                  {c.badge && (
                    <span className={cn("text-xs font-medium", c.badge.color)}>
                      {c.badge.text}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{c.sub}</div>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
            </Glass>
          </Link>
        ))}

        {/* MC balance info */}
        {spin && (
          <Glass className="p-3 text-sm text-center text-muted-foreground">
            Your Mental Coins: <span className="text-foreground font-semibold">{coin(spin.coinBalance)}</span>
          </Glass>
        )}
      </div>
    </Layout>
  );
}
