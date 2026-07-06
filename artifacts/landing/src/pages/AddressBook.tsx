import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Star, Gamepad2 } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, ApiError, type SavedAddress } from "@/lib/api";
import { haptic } from "@/lib/telegram";

export default function AddressBookPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<{ addresses: SavedAddress[] }>("/addresses"),
  });

  const [showForm, setShowForm] = useState(false);
  const [gameName, setGameName] = useState("");
  const [gameId, setGameId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [nickname, setNickname] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const resetForm = () => {
    setShowForm(false);
    setGameName("");
    setGameId("");
    setZoneId("");
    setNickname("");
    setErr(null);
  };

  const addM = useMutation({
    mutationFn: () =>
      api.post<{ address: SavedAddress }>("/addresses", {
        gameName: gameName.trim(),
        gameId: gameId.trim(),
        zoneId: zoneId.trim() || undefined,
        nickname: nickname.trim() || undefined,
      }),
    onSuccess: () => {
      haptic("success");
      resetForm();
      qc.invalidateQueries({ queryKey: ["addresses"] });
    },
    onError: (e) => {
      haptic("error");
      setErr(e instanceof ApiError ? e.message : "Failed to save");
    },
  });

  const delM = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/addresses/${id}`),
    onSuccess: () => {
      haptic("light");
      qc.invalidateQueries({ queryKey: ["addresses"] });
    },
  });

  const defM = useMutation({
    mutationFn: (id: string) => api.patch<{ ok: boolean }>(`/addresses/${id}/default`, {}),
    onSuccess: () => {
      haptic("selection");
      qc.invalidateQueries({ queryKey: ["addresses"] });
    },
  });

  const entries = q.data?.addresses ?? [];
  const byGame: Record<string, SavedAddress[]> = {};
  for (const e of entries) {
    (byGame[e.gameName] ||= []).push(e);
  }

  return (
    <Layout title="Saved Game IDs" showBack showNav={false}>
      <div className="space-y-4 pb-28 pt-1">
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : entries.length === 0 && !showForm ? (
          <Glass className="p-8 text-center">
            <Gamepad2 className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <div className="font-semibold">No saved IDs yet</div>
            <div className="text-xs text-muted-foreground mt-1">
              Save your game IDs to check out faster next time.
            </div>
          </Glass>
        ) : (
          Object.entries(byGame).map(([game, ids]) => (
            <Glass key={game} className="p-4">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                {game}
              </div>
              <div className="space-y-2">
                {ids.map((e) => (
                  <div key={e.id} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium flex items-center gap-1.5 truncate">
                        {e.isDefault && (
                          <Star className="h-3.5 w-3.5 text-amber-300 fill-amber-300 flex-shrink-0" />
                        )}
                        {e.nickname && e.nickname !== e.gameId ? e.nickname : e.gameId}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        ID: {e.gameId}
                        {e.zoneId ? ` · Zone ${e.zoneId}` : ""}
                      </div>
                    </div>
                    {!e.isDefault && (
                      <button
                        onClick={() => defM.mutate(e.id)}
                        className="pressable h-8 w-8 rounded-full glass border border-white/10 flex items-center justify-center"
                        aria-label="Set default"
                        data-testid={`button-default-${e.id}`}
                      >
                        <Star className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => delM.mutate(e.id)}
                      className="pressable h-8 w-8 rounded-full glass border border-white/10 flex items-center justify-center text-rose-300"
                      aria-label="Delete"
                      data-testid={`button-delete-${e.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </Glass>
          ))
        )}

        {showForm ? (
          <Glass className="p-4 space-y-3">
            <div className="text-sm font-semibold">New Game ID</div>
            <Field label="Game name" value={gameName} onChange={setGameName} placeholder="e.g. Mobile Legends" testId="input-gamename" />
            <Field label="Game ID" value={gameId} onChange={setGameId} placeholder="Your in-game ID" testId="input-gameid" />
            <Field label="Zone ID (optional)" value={zoneId} onChange={setZoneId} placeholder="Server / Zone" testId="input-zoneid" />
            <Field label="Nickname (optional)" value={nickname} onChange={setNickname} placeholder="e.g. My Main" testId="input-nickname" />
            {err && <div className="text-xs text-rose-300">{err}</div>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={resetForm}
                className="pressable flex-1 rounded-xl py-2.5 glass border border-white/10 text-sm"
                data-testid="button-cancel-address"
              >
                Cancel
              </button>
              <button
                disabled={!gameName.trim() || !gameId.trim() || addM.isPending}
                onClick={() => {
                  setErr(null);
                  addM.mutate();
                }}
                className="pressable flex-1 rounded-xl py-2.5 bg-primary text-white font-medium text-sm disabled:opacity-40"
                data-testid="button-save-address"
              >
                {addM.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </Glass>
        ) : (
          <button
            onClick={() => {
              haptic("light");
              setShowForm(true);
            }}
            className="pressable w-full rounded-2xl py-3.5 glass border border-white/10 flex items-center justify-center gap-2 text-sm font-medium"
            data-testid="button-add-address"
          >
            <Plus className="h-4 w-4" /> Add Game ID
          </button>
        )}
      </div>
    </Layout>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full mt-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 outline-none focus:border-primary text-sm"
        data-testid={testId}
      />
    </div>
  );
}
