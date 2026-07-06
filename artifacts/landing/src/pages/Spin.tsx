import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { api, ApiError } from "@/lib/api";
import { ks, coin, cn } from "@/lib/format";
import { haptic, getTg } from "@/lib/telegram";

interface SpinStatus {
  canFreeSpin: boolean;
  nextFreeSpinMs: number;
  coinBalance: number;
  spinCostCoins: number;
  prizePool: { id: string; label: string; type: string; value: number }[];
}
interface SpinResult {
  prize: { id: string; label: string; type: string; value: number };
  prizeIndex: number;
  usedFreeSpin: boolean;
  newBalanceKS: number;
  newBalanceCoin: number;
}

const SEG_COLORS = [
  "rgba(99,102,241,0.25)",
  "rgba(234,179,8,0.2)",
  "rgba(234,179,8,0.3)",
  "rgba(245,158,11,0.35)",
  "rgba(16,185,129,0.3)",
  "rgba(16,185,129,0.4)",
  "rgba(59,130,246,0.3)",
];

function useCountdown(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function resultMessage(prize: SpinResult["prize"]) {
  if (prize.type === "none") return { headline: "No reward this time 😅", sub: "Better luck next spin!" };
  if (prize.type === "coin") return { headline: `+${coin(prize.value)} added! 🪙`, sub: "Mental Coins added to your wallet" };
  if (prize.type === "ks") return { headline: `+${ks(prize.value)} added! 💰`, sub: "Kyat added to your balance" };
  if (prize.type === "spin") return { headline: "1 Free Spin added! 🎰", sub: "Spin again right now — no wait!" };
  return { headline: prize.label, sub: "" };
}

export default function SpinPage() {
  const qc = useQueryClient();
  const [result, setResult] = useState<SpinResult | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [wheelAngle, setWheelAngle] = useState(0);
  const [winningIdx, setWinningIdx] = useState<number | null>(null);
  const totalAngleRef = useRef(0);

  const statusQ = useQuery<SpinStatus>({
    queryKey: ["spin-status"],
    queryFn: () => api.get("/spin/status"),
    refetchInterval: 60000,
  });

  const spinMut = useMutation<SpinResult, ApiError, boolean>({
    mutationFn: (usePaid) => api.post("/spin", { usePaid }),
    onMutate: () => {
      setSpinning(true);
      setResult(null);
      setWinningIdx(null);
      haptic("medium");
    },
    onSuccess: (data) => {
      const pool = statusQ.data?.prizePool ?? [];
      const n = pool.length || 7;
      const i = data.prizeIndex;

      // Exact angle so the pointer (top) lands on center of segment i.
      // Segment i center is at (360/n)*(i+0.5) CW from top in wheel's local frame.
      // To bring it to top after CW rotation θ: (segCenter + θ) ≡ 0 (mod 360)
      // → θ ≡ -segCenter (mod 360) → θ = (360 - segCenter%360) % 360
      const segCenter = (360 / n) * (i + 0.5);
      const baseAngle = (360 - segCenter % 360 + 360) % 360;

      const currentMod = totalAngleRef.current % 360;
      let delta = (baseAngle - currentMod + 360) % 360;
      if (delta < 45) delta += 360; // ensure visible rotation
      const finalAngle = totalAngleRef.current + delta + 1440; // 4+ full rotations

      totalAngleRef.current = finalAngle;
      setWheelAngle(finalAngle);

      setTimeout(() => {
        setSpinning(false);
        setWinningIdx(i);
        setResult(data);
        haptic("success");
        qc.invalidateQueries({ queryKey: ["spin-status"] });
        qc.invalidateQueries({ queryKey: ["me"] });
      }, 2400);
    },
    onError: (e) => {
      setSpinning(false);
      const tg = getTg();
      if (tg) tg.showAlert(e.message); else alert(e.message);
    },
  });

  const status = statusQ.data;
  const pool = status?.prizePool ?? [];
  const n = pool.length;

  return (
    <Layout title="Spin Wheel" showBack showNav={false}>
      <div className="flex flex-col items-center gap-5 pt-2 pb-28">

        {/* Wheel */}
        <div className="relative w-64 h-64 flex items-center justify-center">
          <div
            className="w-full h-full rounded-full border-4 border-white/10 relative"
            style={{
              transform: `rotate(${wheelAngle}deg)`,
              transition: spinning
                ? "transform 2400ms cubic-bezier(0.17, 0.67, 0.12, 1)"
                : "none",
            }}
          >
            {/* Coloured segments via SVG */}
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 256 256">
              {pool.map((_, i) => {
                const segAngle = 360 / n;
                const startAngle = segAngle * i - 90;
                const endAngle = segAngle * (i + 1) - 90;
                const toRad = (a: number) => (a * Math.PI) / 180;
                const r = 120;
                const x1 = 128 + r * Math.cos(toRad(startAngle));
                const y1 = 128 + r * Math.sin(toRad(startAngle));
                const x2 = 128 + r * Math.cos(toRad(endAngle));
                const y2 = 128 + r * Math.sin(toRad(endAngle));
                const isWinner = !spinning && winningIdx === i;
                return (
                  <path
                    key={i}
                    d={`M 128 128 L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z`}
                    fill={isWinner ? "rgba(255,255,255,0.18)" : (SEG_COLORS[i % SEG_COLORS.length])}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="1"
                    style={{ transition: "fill 0.3s" }}
                  />
                );
              })}
              <circle cx="128" cy="128" r="120" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" />
            </svg>

            {/* Labels */}
            {pool.map((p, i) => {
              const angle = (360 / n) * i;
              const labelAngle = angle + (360 / n) / 2;
              const rad = (labelAngle - 90) * (Math.PI / 180);
              const r = 82;
              const x = 128 + r * Math.cos(rad);
              const y = 128 + r * Math.sin(rad);
              const isWinner = !spinning && winningIdx === i;
              return (
                <div
                  key={p.id}
                  className={cn(
                    "absolute text-[9px] font-bold text-center leading-tight",
                    isWinner ? "text-white" : "text-white/80"
                  )}
                  style={{
                    left: `${x}px`,
                    top: `${y}px`,
                    transform: `translate(-50%, -50%) rotate(${labelAngle}deg)`,
                    width: "50px",
                    textShadow: isWinner ? "0 0 8px rgba(255,255,255,0.8)" : "none",
                  }}
                >
                  {p.label}
                </div>
              );
            })}

            {/* Center hub */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-12 h-12 rounded-full glass-strong border border-white/20 flex items-center justify-center text-xl z-10">
                🎰
              </div>
            </div>
          </div>

          {/* Pointer — fixed at top, outside wheel */}
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 drop-shadow-lg">
            <div className="w-0 h-0 border-l-[10px] border-r-[10px] border-t-[20px] border-l-transparent border-r-transparent border-t-white/90" />
          </div>
        </div>

        {/* Result card */}
        {result && !spinning && (
          <Glass className="w-full p-5 text-center border border-white/15 animate-in fade-in slide-in-from-bottom-2">
            <div className="text-3xl mb-2">
              {result.prize.type === "none" ? "🎭"
                : result.prize.type === "coin" ? "🪙"
                : result.prize.type === "ks" ? "💰"
                : "🎰"}
            </div>
            <div className="text-lg font-bold mb-1">
              {resultMessage(result.prize).headline}
            </div>
            <div className="text-sm text-muted-foreground">
              {resultMessage(result.prize).sub}
            </div>
          </Glass>
        )}

        {/* Status + buttons */}
        {statusQ.isLoading ? (
          <div className="h-20 w-full glass rounded-2xl animate-pulse" />
        ) : status ? (
          <Glass className="w-full p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Free spin</span>
              <span className={status.canFreeSpin ? "text-emerald-400 font-semibold" : "text-muted-foreground"}>
                {status.canFreeSpin ? "✅ Available!" : `⏳ ${useCountdown(status.nextFreeSpinMs)}`}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Paid spin</span>
              <span>{coin(status.spinCostCoins)} per spin · you have {coin(status.coinBalance)}</span>
            </div>

            <div className="flex gap-2 pt-1">
              {status.canFreeSpin && (
                <button
                  disabled={spinning}
                  onClick={() => spinMut.mutate(false)}
                  className="pressable flex-1 bg-primary text-white rounded-2xl py-3 font-semibold disabled:opacity-40"
                  data-testid="button-free-spin"
                >
                  {spinning ? "Spinning…" : "🆓 Free Spin!"}
                </button>
              )}
              <button
                disabled={spinning || status.coinBalance < status.spinCostCoins}
                onClick={() => spinMut.mutate(true)}
                className={cn(
                  "pressable rounded-2xl py-3 font-semibold disabled:opacity-40 text-sm",
                  status.canFreeSpin ? "glass flex-none px-4" : "flex-1 bg-primary text-white"
                )}
                data-testid="button-paid-spin"
              >
                {spinning ? "…" : `🪙 Paid Spin (${status.spinCostCoins} MC)`}
              </button>
            </div>
          </Glass>
        ) : null}

        {/* Prize table */}
        {pool.length > 0 && (
          <Glass className="w-full p-4">
            <div className="text-xs font-medium text-muted-foreground mb-3">Prize Pool</div>
            <div className="space-y-1.5">
              {pool.map((p, i) => (
                <div
                  key={p.id}
                  className={cn(
                    "flex items-center justify-between text-sm rounded-lg px-2 py-0.5 transition-colors",
                    winningIdx === i && !spinning ? "bg-white/10 font-semibold" : ""
                  )}
                >
                  <span>{p.label} {winningIdx === i && !spinning ? "◀ You won!" : ""}</span>
                  {p.type !== "none" && p.type !== "spin" && (
                    <span className="text-xs text-muted-foreground">
                      {p.type === "ks" ? ks(p.value) : coin(p.value)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Glass>
        )}
      </div>
    </Layout>
  );
}
