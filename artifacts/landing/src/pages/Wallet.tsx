import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Plus } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { EmptyState, Skeleton } from "@/components/EmptyState";
import { api, type WalletResponse } from "@/lib/api";
import { ks, coin, timeAgo, cn } from "@/lib/format";

export default function WalletPage() {
  const wQ = useQuery({ queryKey: ["wallet"], queryFn: () => api.get<WalletResponse>("/wallet") });

  return (
    <Layout title="Wallet" showNav>
      <div className="space-y-4 pt-1">
        {wQ.isLoading ? (
          <Skeleton className="h-40" />
        ) : wQ.data ? (
          <>
            <Glass variant="blue" className="p-5">
              <div className="text-xs uppercase tracking-wider text-white/70">Balance</div>
              <div className="text-4xl font-bold mt-1" data-testid="text-balance-ks">{ks(wQ.data.balanceKS)}</div>
              <div className="text-sm text-white/80 mt-1">+ {coin(wQ.data.balanceCoin)}</div>
              <div className="mt-4 flex gap-2">
                <Link
                  href="/topup"
                  className="pressable flex-1 bg-white text-black rounded-xl py-3 text-center text-sm font-semibold flex items-center justify-center gap-1.5"
                  data-testid="button-topup"
                >
                  <Plus className="h-4 w-4" /> Top Up
                </Link>
                <Link
                  href="/shop"
                  className="pressable flex-1 glass-strong rounded-xl py-3 text-center text-sm font-medium"
                >
                  Spend
                </Link>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-white/80">
                <Stat label="Tier" value={wQ.data.tier} />
                <Stat label="Lifetime" value={ks(wQ.data.totalDeposited)} />
              </div>
            </Glass>

            <div>
              <h2 className="text-sm font-semibold mb-2 px-1">Recent activity</h2>
              {wQ.data.history.length === 0 ? (
                <EmptyState title="No transactions yet" hint="Your top-ups and purchases will show here." />
              ) : (
                <Glass className="divide-y divide-white/5">
                  {wQ.data.history.map((t) => {
                    const credit = t.amount > 0;
                    return (
                      <div
                        key={t.id}
                        className="flex items-center gap-3 p-3"
                        data-testid={`tx-${t.id}`}
                      >
                        <div className={cn(
                          "h-9 w-9 rounded-full flex items-center justify-center",
                          credit ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                        )}>
                          {credit ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{t.type}{t.paymentMethod ? ` · ${t.paymentMethod}` : ""}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {t.description || "—"} · {timeAgo(t.at)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={cn("text-sm font-semibold", credit ? "text-emerald-300" : "text-rose-300")}>
                            {credit ? "+" : ""}{t.wallet === "Coin" ? coin(t.amount) : ks(t.amount)}
                          </div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t.status}</div>
                        </div>
                      </div>
                    );
                  })}
                </Glass>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Layout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-strong rounded-xl px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/60">{label}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
    </div>
  );
}
