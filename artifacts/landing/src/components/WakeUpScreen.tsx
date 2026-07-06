import { useEffect, useState } from "react";

const DOTS = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export default function WakeUpScreen({ onReady }: { onReady: () => void }) {
  const [dot, setDot] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const dotTimer = setInterval(() => setDot(d => (d + 1) % DOTS.length), 100);
    const secTimer = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => { clearInterval(dotTimer); clearInterval(secTimer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apiBase = (import.meta.env.VITE_API_URL ?? "") + "/api/healthz";

    async function ping() {
      try {
        const res = await fetch(apiBase, { cache: "no-store" });
        if (!cancelled && res.ok) { onReady(); return; }
      } catch {}
      if (!cancelled) {
        setAttempt(a => a + 1);
        setTimeout(ping, 3000);
      }
    }

    ping();
    return () => { cancelled = true; };
  }, [onReady]);

  return (
    <div className="fixed inset-0 bg-[#0f0f1a] flex flex-col items-center justify-center gap-6 z-50">
      <div className="text-5xl">🎮</div>
      <div className="text-center">
        <div className="text-white font-bold text-xl">Mental Gaming Store</div>
        <div className="text-zinc-400 text-sm mt-1">Mini App</div>
      </div>

      <div className="flex flex-col items-center gap-2 mt-4">
        <div className="text-purple-400 text-lg font-mono">{DOTS[dot]}</div>
        <div className="text-zinc-400 text-sm">
          {attempt === 0 ? "Connecting…" : `Waking up server… (${elapsed}s)`}
        </div>
      </div>

      {elapsed >= 8 && (
        <div className="text-zinc-500 text-xs text-center max-w-[200px] mt-2">
          Server is starting up,<br />this takes ~15 seconds…
        </div>
      )}
    </div>
  );
}
