import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ChevronDown, HelpCircle, PlayCircle } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, type Faq } from "@/lib/api";
import { cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

const CATEGORIES: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "general", label: "General" },
  { key: "order", label: "Orders" },
  { key: "payment", label: "Payment" },
  { key: "game", label: "Game" },
  { key: "account", label: "Account" },
  { key: "promo", label: "Promo" },
];

export default function FAQPage() {
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const query = search.trim().length >= 2 ? { q: search.trim() } : { category };
  const qs = new URLSearchParams(
    query.q ? { q: query.q } : query.category ? { category: query.category } : {}
  ).toString();

  const q = useQuery({
    queryKey: ["faqs", query],
    queryFn: () => api.get<{ faqs: Faq[] }>(`/faqs${qs ? `?${qs}` : ""}`),
  });

  const faqs = q.data?.faqs ?? [];

  const toggle = (id: string) => {
    haptic("selection");
    setOpen((cur) => (cur === id ? null : id));
    if (open !== id) {
      api.post(`/faqs/${id}/view`, {}).catch(() => {});
    }
  };

  return (
    <Layout title="Help Center" showBack showNav={false}>
      <div className="space-y-4 pb-28 pt-1">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search questions…"
            className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-3 py-2.5 outline-none focus:border-primary text-sm"
            data-testid="input-faq-search"
          />
        </div>

        {/* Category chips (hidden while searching) */}
        {search.trim().length < 2 && (
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {CATEGORIES.map((c) => (
              <button
                key={c.key || "all"}
                onClick={() => {
                  haptic("selection");
                  setCategory(c.key);
                  setOpen(null);
                }}
                className={cn(
                  "pressable flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border",
                  category === c.key
                    ? "bg-primary text-white border-primary"
                    : "glass border-white/10 text-muted-foreground"
                )}
                data-testid={`chip-cat-${c.key || "all"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {/* List */}
        {q.isLoading ? (
          <Skeleton className="h-48" />
        ) : faqs.length === 0 ? (
          <Glass className="p-8 text-center">
            <HelpCircle className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <div className="font-semibold">No answers found</div>
            <div className="text-xs text-muted-foreground mt-1">
              Try a different search, or contact support.
            </div>
          </Glass>
        ) : (
          <div className="space-y-2">
            {faqs.map((f) => (
              <Glass key={f.faqId} className="overflow-hidden">
                <button
                  onClick={() => toggle(f.faqId)}
                  className="pressable w-full flex items-center gap-3 px-4 py-3.5 text-left"
                  data-testid={`faq-${f.faqId}`}
                >
                  <span className="flex-1 text-sm font-medium">{f.question}</span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 text-muted-foreground transition-transform flex-shrink-0",
                      open === f.faqId && "rotate-180"
                    )}
                  />
                </button>
                {open === f.faqId && (
                  <div className="px-4 pb-4 -mt-1 space-y-3">
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                      {f.answer}
                    </p>
                    {f.videoUrl && (
                      <a
                        href={f.videoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="pressable inline-flex items-center gap-1.5 text-xs text-primary"
                        data-testid={`faq-video-${f.faqId}`}
                      >
                        <PlayCircle className="h-4 w-4" />
                        {f.videoCaption || "Watch tutorial"}
                      </a>
                    )}
                  </div>
                )}
              </Glass>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
