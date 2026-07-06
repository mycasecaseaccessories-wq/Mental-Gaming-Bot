import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { haptic, getTg } from "@/lib/telegram";

interface ReferralData {
  code: string;
  link: string;
  totalReferrals: number;
  completedCount: number;
  currentTier: { minRefs: number; rate: number; label: string; emoji: string } | null;
  nextTier: { minRefs: number; rate: number; label: string; emoji: string } | null;
  recentReferrals: { id: string; status: string; maskedName: string; at: string | null }[];
}

const STATUS_COLORS: Record<string, string> = {
  Active: "text-emerald-400",
  Completed: "text-primary",
  Pending: "text-yellow-400",
  Frozen: "text-rose-400",
};

export default function ReferralPage() {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const refQ = useQuery<ReferralData>({
    queryKey: ["referral"],
    queryFn: () => api.get("/referral"),
  });

  function copyText(text: string, which: "code" | "link") {
    haptic("light");
    navigator.clipboard?.writeText(text).then(() => {
      if (which === "code") {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 1500);
      } else {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 1500);
      }
    });
  }

  function shareLink(link: string) {
    haptic("medium");
    const tg = getTg();
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("🎮 Join Mental Gaming Store! Use my referral link:")}`);
    } else if (navigator.share) {
      navigator.share({ url: link, title: "Mental Gaming Store" }).catch(() => {});
    } else {
      copyText(link, "link");
    }
  }

  const d = refQ.data;

  const tierProgress = d?.currentTier && d?.nextTier
    ? Math.min(1, (d.completedCount - d.currentTier.minRefs) / (d.nextTier.minRefs - d.currentTier.minRefs))
    : d?.nextTier
      ? Math.min(1, d.completedCount / d.nextTier.minRefs)
      : 1;

  return (
    <Layout title="Referral Program" showBack showNav={false}>
      <div className="space-y-4 pb-28 pt-1">

        {/* Tier card */}
        {refQ.isLoading ? (
          <Skeleton className="h-32" />
        ) : d ? (
          <Glass variant="blue" className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-white/70">Your Tier</div>
                <div className="text-2xl font-bold mt-1">
                  {d.currentTier ? `${d.currentTier.emoji} ${d.currentTier.label}` : "No tier yet"}
                </div>
                {d.currentTier && (
                  <div className="text-sm text-white/80 mt-0.5">{d.currentTier.rate}% commission</div>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs text-white/70">Referrals</div>
                <div className="text-3xl font-bold">{d.completedCount}</div>
              </div>
            </div>
            {d.nextTier && (
              <>
                <div className="flex justify-between text-xs text-white/60 mb-1">
                  <span>{d.currentTier?.label ?? "Start"}</span>
                  <span>{d.nextTier.emoji} {d.nextTier.label} at {d.nextTier.minRefs}</span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white/70 rounded-full transition-all"
                    style={{ width: `${tierProgress * 100}%` }}
                  />
                </div>
                <div className="text-xs text-white/50 mt-1 text-right">
                  {Math.max(0, d.nextTier.minRefs - d.completedCount)} more to unlock {d.nextTier.rate}%
                </div>
              </>
            )}
          </Glass>
        ) : null}

        {/* Share section */}
        {d && (
          <Glass className="p-4 space-y-3">
            <div className="text-xs font-medium text-muted-foreground">Your Referral Code</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 glass rounded-xl px-4 py-3 font-mono font-bold text-lg tracking-widest text-center">
                {d.code}
              </div>
              <button
                onClick={() => copyText(d.code, "code")}
                className="pressable glass-strong rounded-xl h-12 w-12 flex items-center justify-center"
                data-testid="button-copy-code"
              >
                {copiedCode ? <Check className="h-5 w-5 text-emerald-300" /> : <Copy className="h-5 w-5" />}
              </button>
            </div>

            <button
              onClick={() => shareLink(d.link)}
              className="pressable w-full bg-primary text-white rounded-2xl py-3.5 font-semibold"
              data-testid="button-share-link"
            >
              📤 Share Invite Link
            </button>

            <button
              onClick={() => copyText(d.link, "link")}
              className="pressable w-full glass border border-white/10 rounded-2xl py-2.5 text-sm text-muted-foreground"
              data-testid="button-copy-link"
            >
              {copiedLink ? "✅ Copied!" : "Copy link"}
            </button>
          </Glass>
        )}

        {/* How it works */}
        <Glass className="p-4 space-y-2">
          <div className="text-xs font-medium text-muted-foreground mb-1">How it works</div>
          {[
            ["1️⃣", "Share your code or link with friends"],
            ["2️⃣", "They sign up and top up their wallet"],
            ["3️⃣", "You earn commission on every top-up they make"],
          ].map(([n, t]) => (
            <div key={n} className="flex items-start gap-2 text-sm">
              <span>{n}</span><span className="text-muted-foreground">{t}</span>
            </div>
          ))}

          <div className="mt-3 border-t border-white/5 pt-3 space-y-1.5">
            {[
              { emoji: "🥉", label: "Bronze", refs: "1–5", rate: "2%" },
              { emoji: "🥈", label: "Silver", refs: "6–15", rate: "3%" },
              { emoji: "🥇", label: "Gold",   refs: "16+",  rate: "5%" },
            ].map((tier) => (
              <div key={tier.label} className="flex items-center justify-between text-sm">
                <span>{tier.emoji} {tier.label}</span>
                <span className="text-muted-foreground">{tier.refs} refs → {tier.rate}</span>
              </div>
            ))}
          </div>
        </Glass>

        {/* Recent referrals */}
        {d && d.recentReferrals.length > 0 && (
          <Glass className="p-4">
            <div className="text-xs font-medium text-muted-foreground mb-3">Recent Referrals</div>
            <div className="space-y-2">
              {d.recentReferrals.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-sm">
                  <span className="font-mono">{r.maskedName}</span>
                  <span className={cn("text-xs", STATUS_COLORS[r.status] ?? "text-muted-foreground")}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          </Glass>
        )}
      </div>
    </Layout>
  );
}
