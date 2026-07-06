import { useState } from "react";
import { FileSpreadsheet, Download } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { api, ApiError } from "@/lib/api";
import { haptic, getTg } from "@/lib/telegram";

type Period = "today" | "week" | "month";

const PERIODS: Array<{ value: Period; label: string; hint: string }> = [
  { value: "today", label: "Today", hint: "Since midnight (MMT)" },
  { value: "week", label: "Last 7 Days", hint: "Rolling 7-day window" },
  { value: "month", label: "Last 30 Days", hint: "Rolling 30-day window" },
];

export default function AdminExport() {
  const [period, setPeriod] = useState<Period>("month");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    setBusy(true);
    setErr(null);
    setDone(false);
    try {
      await api.download(`/admin/export?period=${period}`, `MGS_Report_${period}.csv`);
      haptic("success");
      setDone(true);
    } catch (e: unknown) {
      haptic("error");
      const msg = e instanceof ApiError ? e.message : "Export failed";
      setErr(msg);
      const tg = getTg();
      if (tg) tg.showAlert(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="Financial Export" showBack showNav>
      <div className="space-y-4">
        <Glass className="p-4 space-y-3">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <FileSpreadsheet className="h-4 w-4 text-primary" /> Financial Report (CSV)
          </div>
          <p className="text-[11px] text-white/40">
            Download a full financial report — revenue, orders, discounts, top products &
            customers, payment methods and daily trend. Opens in Excel or Google Sheets.
          </p>

          <div className="space-y-2">
            {PERIODS.map((p) => {
              const active = period === p.value;
              return (
                <button
                  key={p.value}
                  onClick={() => { haptic("selection"); setPeriod(p.value); }}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    active ? "border-primary/50 glass-blue" : "border-white/10 glass"
                  }`}
                >
                  <div className="text-sm font-medium">{p.label}</div>
                  <div className="text-[11px] text-white/40">{p.hint}</div>
                </button>
              );
            })}
          </div>
        </Glass>

        {err && <p className="text-xs text-rose-400">{err}</p>}
        {done && !err && (
          <p className="text-xs text-emerald-300">Report downloaded successfully.</p>
        )}

        <button
          onClick={run}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> {busy ? "Generating…" : "Download CSV Report"}
        </button>
      </div>
    </Layout>
  );
}
