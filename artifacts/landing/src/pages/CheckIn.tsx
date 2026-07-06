import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { api, ApiError } from "@/lib/api";
import { ks, coin, cn } from "@/lib/format";
import { haptic, getTg } from "@/lib/telegram";

interface CheckInStatus {
  canCheckIn: boolean;
  alreadyCheckedIn: boolean;
  streak: number;
  longestStreak: number;
  totalCheckIns: number;
  nextReward: { coins: number; ks: number; label: string; milestone?: boolean };
  milestoneBonus: { streak: number; coins: number; ks: number; label: string } | null;
  checkedDays: number[];
  todayDate: string;
  rewardSchedule: { coins: number; ks: number; label: string; milestone?: boolean }[];
}
interface CheckInResult {
  streak: number;
  reward: { coins: number; ks: number; label: string };
  milestone: { label: string; coins: number; ks: number } | null;
  newBalanceCoin: number;
  newBalanceKS: number;
}

function streakBar(streak: number) {
  const filled = Math.min(streak % 7 || (streak > 0 ? 7 : 0), 7);
  return Array.from({ length: 7 }, (_, i) => (i < filled ? "🔥" : "○")).join(" ");
}

export default function CheckInPage() {
  const qc = useQueryClient();

  const statusQ = useQuery<CheckInStatus>({
    queryKey: ["checkin-status"],
    queryFn: () => api.get("/checkin/status"),
  });

  const mut = useMutation<CheckInResult, ApiError, void>({
    mutationFn: () => api.post("/checkin", {}),
    onSuccess: (data) => {
      haptic("success");
      qc.invalidateQueries({ queryKey: ["checkin-status"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      const tg = getTg();
      const msg = data.milestone
        ? `🎉 Day ${data.streak}! ${data.milestone.label}\n+${data.reward.coins + data.milestone.coins} MC${data.reward.ks + data.milestone.ks > 0 ? ` + ${ks(data.reward.ks + data.milestone.ks)}` : ""}`
        : `✅ Day ${data.streak}! +${data.reward.coins} MC${data.reward.ks > 0 ? ` + ${ks(data.reward.ks)}` : ""}`;
      if (tg) tg.showAlert(msg); else alert(msg);
    },
    onError: (e) => {
      haptic("error");
      const tg = getTg();
      const msg = e.message === "already_checked_in" ? "Already checked in today!" : e.message;
      if (tg) tg.showAlert(msg); else alert(msg);
    },
  });

  const s = statusQ.data;
  const today = s ? Number(s.todayDate.slice(8)) : 0;
  const daysInMonth = s ? new Date(Number(s.todayDate.slice(0, 4)), Number(s.todayDate.slice(5, 7)), 0).getDate() : 30;

  return (
    <Layout title="Daily Check-In" showBack showNav={false}>
      <div className="space-y-4 pb-28 pt-1">

        {/* Streak card */}
        <Glass variant="blue" className="p-5">
          {statusQ.isLoading ? (
            <div className="h-20 animate-pulse" />
          ) : s ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-white/70">Current Streak</div>
                  <div className="text-4xl font-bold mt-1">{s.streak} <span className="text-2xl">🔥</span></div>
                </div>
                <div className="text-right text-sm text-white/80">
                  <div>Best: {s.longestStreak} days</div>
                  <div className="mt-1">Total: {s.totalCheckIns}</div>
                </div>
              </div>
              <div className="text-lg tracking-widest">{streakBar(s.streak)}</div>
              {s.streak > 0 && (
                <div className="text-xs text-white/60 mt-1">{s.streak % 7}/7 days to weekly jackpot 🎉</div>
              )}
            </>
          ) : null}
        </Glass>

        {/* Today's reward + CTA */}
        {s && (
          <Glass className="p-4">
            <div className="text-xs font-medium text-muted-foreground mb-2">Today's Reward</div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xl font-bold">
                +{coin(s.nextReward.coins)}
                {s.nextReward.ks > 0 && <span className="ml-2 text-emerald-400">+{ks(s.nextReward.ks)}</span>}
              </div>
              {s.nextReward.milestone && (
                <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded-full">Weekly Jackpot!</span>
              )}
            </div>
            {s.milestoneBonus && (
              <div className="text-xs text-amber-300 mb-3">
                🏆 Milestone bonus today: +{coin(s.milestoneBonus.coins)} & +{ks(s.milestoneBonus.ks)} — {s.milestoneBonus.label}
              </div>
            )}
            <button
              disabled={!s.canCheckIn || mut.isPending}
              onClick={() => mut.mutate()}
              className="pressable w-full bg-primary text-white rounded-2xl py-3.5 font-semibold disabled:opacity-40"
              data-testid="button-checkin"
            >
              {mut.isPending ? "Stamping…" : s.alreadyCheckedIn ? "✅ Checked in today!" : "📅 Check In Now"}
            </button>
          </Glass>
        )}

        {/* 7-day reward schedule */}
        {s && (
          <Glass className="p-4">
            <div className="text-xs font-medium text-muted-foreground mb-3">Weekly Rewards</div>
            <div className="grid grid-cols-7 gap-1">
              {s.rewardSchedule.map((r, i) => {
                const day = i + 1;
                const isCurrent = (s.streak % 7 || 7) === day || (s.streak === 0 && day === 1);
                return (
                  <div
                    key={i}
                    className={cn(
                      "flex flex-col items-center rounded-xl py-2 text-center border",
                      r.milestone
                        ? "border-primary/50 bg-primary/10"
                        : isCurrent
                          ? "border-white/20 bg-white/8"
                          : "border-white/5"
                    )}
                  >
                    <div className="text-[9px] text-muted-foreground mb-0.5">D{day}</div>
                    <div className="text-[10px] font-semibold text-yellow-300">{r.coins}</div>
                    {r.ks > 0 && <div className="text-[9px] text-emerald-400">+{r.ks}</div>}
                    {r.milestone && <div className="text-[8px] mt-0.5">🎉</div>}
                  </div>
                );
              })}
            </div>
          </Glass>
        )}

        {/* Monthly calendar */}
        {s && (
          <Glass className="p-4">
            <div className="text-xs font-medium text-muted-foreground mb-3">
              {s.todayDate.slice(0, 7)} Calendar
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
                const checked = s.checkedDays.includes(d);
                const isToday = d === today;
                return (
                  <div
                    key={d}
                    className={cn(
                      "aspect-square flex items-center justify-center text-[11px] rounded-lg",
                      checked ? "bg-primary/25 text-primary font-semibold" : "text-muted-foreground",
                      isToday ? "ring-1 ring-primary/60" : ""
                    )}
                  >
                    {checked ? "✓" : d}
                  </div>
                );
              })}
            </div>
          </Glass>
        )}
      </div>
    </Layout>
  );
}
