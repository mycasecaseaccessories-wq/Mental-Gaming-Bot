import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Languages, Palette, Check } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, type Me } from "@/lib/api";
import { haptic } from "@/lib/telegram";
import { cn } from "@/lib/utils";

type Lang = "en" | "mm";
type Theme = "auto" | "light" | "dark";

const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: "en", label: "🇬🇧 English" },
  { value: "mm", label: "🇲🇲 မြန်မာ" },
];

const THEME_OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "auto",  label: "Auto",  hint: "Follow Myanmar time / device" },
  { value: "light", label: "Light", hint: "Bright theme" },
  { value: "dark",  label: "Dark",  hint: "Dark theme" },
];

export default function Settings() {
  const qc = useQueryClient();
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });

  const save = useMutation({
    mutationFn: (body: { language?: Lang; theme?: Theme }) =>
      api.patch<{ ok: boolean; language: Lang; theme: Theme }>("/me", body),
    onMutate: () => haptic("selection"),
    onSuccess: () => {
      haptic("success");
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () => haptic("error"),
  });

  const me = meQ.data;
  const currentLang: Lang = me?.language ?? "en";
  const currentTheme: Theme = me?.theme ?? "auto";

  return (
    <Layout title="Settings">
      <div className="space-y-4">
        {meQ.isLoading || !me ? (
          <>
            <Skeleton className="h-32 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </>
        ) : (
          <>
            <Glass className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Languages className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Language</h2>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {LANG_OPTIONS.map((opt) => {
                  const active = currentLang === opt.value;
                  return (
                    <button
                      key={opt.value}
                      disabled={save.isPending}
                      onClick={() => {
                        if (!active) save.mutate({ language: opt.value });
                      }}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition",
                        active
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10"
                      )}
                    >
                      {opt.label}
                      {active && <Check className="h-3.5 w-3.5" />}
                    </button>
                  );
                })}
              </div>
            </Glass>

            <Glass className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Palette className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Theme</h2>
              </div>
              <div className="space-y-2">
                {THEME_OPTIONS.map((opt) => {
                  const active = currentTheme === opt.value;
                  return (
                    <button
                      key={opt.value}
                      disabled={save.isPending}
                      onClick={() => {
                        if (!active) save.mutate({ theme: opt.value });
                      }}
                      className={cn(
                        "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition",
                        active
                          ? "border-primary bg-primary/15"
                          : "border-white/10 bg-white/5 hover:bg-white/10"
                      )}
                    >
                      <div>
                        <div className={cn("text-sm font-medium", active ? "text-primary" : "text-foreground")}>
                          {opt.label}
                        </div>
                        <div className="text-xs text-muted-foreground">{opt.hint}</div>
                      </div>
                      {active && <Check className="h-4 w-4 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </Glass>

            <p className="px-1 text-xs text-muted-foreground">
              Your preferences are saved to your account and shared with the Telegram bot.
            </p>
          </>
        )}
      </div>
    </Layout>
  );
}
