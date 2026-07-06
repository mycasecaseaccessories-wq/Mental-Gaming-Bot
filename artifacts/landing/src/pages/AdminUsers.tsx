import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Ban, ShieldCheck, AlertTriangle, Wallet, User as UserIcon } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { haptic } from "@/lib/telegram";
import { ks as formatKS, coin as formatCoin } from "@/lib/format";

interface AdminUser {
  id: string;
  telegramId: number;
  name: string;
  username: string | null;
  balanceKS: number;
  balanceCoin: number;
  totalDeposited: number;
  tier: string;
  warningsCount: number;
  restrictedRights: string[];
  isBlocked: boolean;
  joinDate: string | null;
}
interface UsersResponse { items: AdminUser[]; total: number; page: number; pages: number }

type PatchBody = { action: string; amount?: number; note?: string; reason?: string };

export default function AdminUsers() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const qc = useQueryClient();

  const q = useQuery<UsersResponse>({
    queryKey: ["admin-users", query],
    queryFn: () => api.get(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchBody }) =>
      api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      haptic("success");
    },
    onError: () => haptic("error"),
  });

  const runSearch = () => {
    haptic("selection");
    setQuery(input.trim());
  };

  return (
    <Layout title="Users" showBack showNav>
      <div className="space-y-3">
        {/* Search */}
        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 glass rounded-xl px-3">
            <Search className="h-4 w-4 text-white/40" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="Search @username or Telegram ID"
              className="flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-white/30"
            />
          </div>
          <button
            onClick={runSearch}
            className="px-4 rounded-xl bg-primary text-white text-sm font-medium pressable"
          >
            Search
          </button>
        </div>

        {q.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
        ) : !q.data?.items.length ? (
          <Glass className="p-8 text-center text-sm text-white/40">No users found</Glass>
        ) : (
          q.data.items.map((u) => {
            const open = openId === u.id;
            return (
              <Glass key={u.id} className="p-4 space-y-3">
                <button
                  className="w-full flex items-start justify-between gap-2 text-left"
                  onClick={() => { haptic("selection"); setOpenId(open ? null : u.id); }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <UserIcon className="h-3.5 w-3.5 text-white/40" />
                      <span className="text-sm font-medium truncate">{u.name}</span>
                      {u.isBlocked && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Banned</span>
                      )}
                      {u.warningsCount > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
                          ⚠️ {u.warningsCount}/3
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">
                      {u.username ? `@${u.username} · ` : ""}<span className="font-mono">{u.telegramId}</span>
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-primary">{formatKS(u.balanceKS)}</p>
                    <p className="text-[10px] text-white/40">{u.tier}</p>
                  </div>
                </button>

                {open && (
                  <div className="space-y-3 border-t border-white/10 pt-3">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Stat label="Coins" value={formatCoin(u.balanceCoin)} />
                      <Stat label="Total deposited" value={formatKS(u.totalDeposited)} />
                    </div>

                    {/* Ban / Warn actions */}
                    <div className="flex flex-wrap gap-2">
                      {u.isBlocked ? (
                        <ActBtn label="Unban" color="green" icon={<ShieldCheck className="h-3.5 w-3.5" />}
                          loading={patch.isPending}
                          onClick={() => patch.mutate({ id: u.id, body: { action: "unban" } })} />
                      ) : (
                        <ActBtn label="Ban" color="red" icon={<Ban className="h-3.5 w-3.5" />}
                          loading={patch.isPending}
                          onClick={() => patch.mutate({ id: u.id, body: { action: "ban" } })} />
                      )}
                      <ActBtn label="Warn" color="orange" icon={<AlertTriangle className="h-3.5 w-3.5" />}
                        loading={patch.isPending}
                        onClick={() => patch.mutate({ id: u.id, body: { action: "warn" } })} />
                      {u.warningsCount > 0 && (
                        <ActBtn label="Unwarn" color="blue"
                          loading={patch.isPending}
                          onClick={() => patch.mutate({ id: u.id, body: { action: "unwarn" } })} />
                      )}
                    </div>

                    {/* Adjust balance */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs text-white/50">
                        <Wallet className="h-3.5 w-3.5" /> Adjust balance (KS)
                      </div>
                      <input
                        value={adjust[u.id] ?? ""}
                        onChange={(e) => setAdjust((s) => ({ ...s, [u.id]: e.target.value }))}
                        placeholder="e.g. 5000 or -2000"
                        inputMode="numeric"
                        className="w-full glass rounded-xl px-3 py-2 text-sm outline-none placeholder:text-white/30"
                      />
                      <input
                        value={note[u.id] ?? ""}
                        onChange={(e) => setNote((s) => ({ ...s, [u.id]: e.target.value }))}
                        placeholder="Note (optional)"
                        className="w-full glass rounded-xl px-3 py-2 text-sm outline-none placeholder:text-white/30"
                      />
                      <ActBtn
                        label="Apply adjustment"
                        color="primary"
                        loading={patch.isPending}
                        onClick={() => {
                          const amount = Number((adjust[u.id] ?? "").trim());
                          if (!Number.isFinite(amount) || amount === 0) { haptic("error"); return; }
                          patch.mutate({
                            id: u.id,
                            body: { action: "adjustBalance", amount, note: note[u.id]?.trim() || undefined },
                          }, {
                            onSuccess: () => {
                              setAdjust((s) => ({ ...s, [u.id]: "" }));
                              setNote((s) => ({ ...s, [u.id]: "" }));
                            },
                          });
                        }}
                      />
                    </div>
                  </div>
                )}
              </Glass>
            );
          })
        )}
      </div>
    </Layout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-xl px-3 py-2">
      <p className="text-[10px] text-white/40">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function ActBtn({
  label, color, icon, loading, onClick,
}: {
  label: string;
  color: "red" | "green" | "orange" | "blue" | "primary";
  icon?: React.ReactNode;
  loading: boolean;
  onClick: () => void;
}) {
  const colors: Record<string, string> = {
    red: "bg-red-500/20 text-red-400 border-red-500/30",
    green: "bg-green-500/20 text-green-400 border-green-500/30",
    orange: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    primary: "bg-primary text-white border-primary w-full justify-center",
  };
  return (
    <button
      onClick={() => { haptic("medium"); onClick(); }}
      disabled={loading}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border pressable disabled:opacity-50 ${colors[color]}`}
    >
      {icon}{loading ? "…" : label}
    </button>
  );
}
