import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Search, ArrowLeft, ChevronRight } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { EmptyState, Skeleton } from "@/components/EmptyState";
import { api, type ShopResponse, type Catalog, type CatalogDetail } from "@/lib/api";
import { ks, cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

const CATEGORY_ICONS: Record<string, string> = {
  "Mobile Legends": "🗡️",
  "PUBG Mobile": "🎯",
  "Free Fire": "🔥",
  "Genshin Impact": "🌟",
  "Valorant": "💥",
  "Steam": "🎮",
  "Google Play": "▶️",
  "App Store": "🍎",
  "Netflix": "🎬",
  "Spotify": "🎵",
  "PlayStation": "🕹️",
  "Xbox": "🎮",
};
function catIcon(name: string) {
  for (const [k, v] of Object.entries(CATEGORY_ICONS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return "🎮";
}

type NavState =
  | { view: "root" }
  | { view: "catalog"; catalogId: string; catalogName: string; parentId?: string; parentName?: string };

export default function ShopPage() {
  const [nav, setNav] = useState<NavState>({ view: "root" });
  const [q, setQ] = useState("");

  // Root catalogs
  const rootQ = useQuery({
    queryKey: ["catalogs"],
    queryFn: () => api.get<{ catalogs: Catalog[] }>("/catalogs"),
    staleTime: 5 * 60 * 1000,
  });

  // Catalog detail (sub-catalogs + products) when drilling in
  const selectedId = nav.view === "catalog" ? nav.catalogId : null;
  const detailQ = useQuery({
    queryKey: ["catalog", selectedId],
    queryFn: () => api.get<CatalogDetail>(`/catalogs/${selectedId}`),
    enabled: selectedId !== null,
    staleTime: 5 * 60 * 1000,
  });

  // Search
  const searchQ = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.get<ShopResponse>(`/products?search=${encodeURIComponent(q)}`),
    enabled: q.length > 1,
    staleTime: 60_000,
  });

  // ── Search view ────────────────────────────────────────────────────────────
  if (q.length > 1) {
    const results = searchQ.data?.products ?? [];
    return (
      <Layout title="Search" showNav>
        <div className="space-y-4 pt-1">
          <SearchBar q={q} setQ={setQ} onBack={() => setQ("")} placeholder="Search all products…" />
          {searchQ.isLoading ? (
            <ProductSkeleton />
          ) : results.length === 0 ? (
            <EmptyState title="No results" hint="Try a different search term." />
          ) : (
            <ProductGrid products={results} />
          )}
        </div>
      </Layout>
    );
  }

  // ── Catalog drill-in view ──────────────────────────────────────────────────
  if (nav.view === "catalog") {
    const detail = detailQ.data;
    const hasSubCats = (detail?.subCatalogs?.length ?? 0) > 0;
    const showProducts = !hasSubCats;

    return (
      <Layout title={nav.catalogName} showNav>
        <div className="space-y-4 pt-1">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                haptic("selection");
                if (nav.parentId) {
                  setNav({ view: "catalog", catalogId: nav.parentId, catalogName: nav.parentName! });
                } else {
                  setNav({ view: "root" });
                }
              }}
              className="pressable h-9 w-9 rounded-full glass border border-white/10 flex items-center justify-center flex-shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <SearchBar q={q} setQ={setQ} placeholder={`Search in ${nav.catalogName}…`} />
          </div>

          {detailQ.isLoading ? (
            hasSubCats !== false ? (
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
              </div>
            ) : <ProductSkeleton />
          ) : !detail ? (
            <EmptyState title="Not found" hint="Category unavailable." />
          ) : hasSubCats ? (
            // Show sub-catalogs grid
            <div className="grid grid-cols-2 gap-3">
              {detail.subCatalogs.map((sub) => (
                <button
                  key={sub.id}
                  onClick={() => { haptic("selection"); setNav({ view: "catalog", catalogId: sub.id, catalogName: sub.name, parentId: nav.catalogId, parentName: nav.catalogName }); }}
                  className="pressable text-left"
                >
                  <Glass className="p-4 flex flex-col gap-2 h-full">
                    <div className="w-12 h-12 rounded-xl overflow-hidden flex items-center justify-center text-2xl bg-white/5 flex-shrink-0">
                      {sub.imageUrl
                        ? <img src={sub.imageUrl} alt={sub.name} className="w-full h-full object-cover" />
                        : <span>{catIcon(sub.name)}</span>}
                    </div>
                    <div className="text-sm font-semibold leading-tight">{sub.name}</div>
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  </Glass>
                </button>
              ))}
            </div>
          ) : showProducts && detail.products.length === 0 ? (
            <EmptyState title="No products" hint="Nothing here yet." />
          ) : (
            <ProductGrid products={detail.products} />
          )}
        </div>
      </Layout>
    );
  }

  // ── Root catalog grid ──────────────────────────────────────────────────────
  const rootCatalogs = rootQ.data?.catalogs ?? [];

  return (
    <Layout title="Shop" showNav>
      <div className="space-y-4 pt-1">
        <SearchBar q={q} setQ={setQ} placeholder="Search games, packs…" />

        {rootQ.isLoading ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : rootCatalogs.length === 0 ? (
          <EmptyState title="No categories yet" hint="Products will appear here." />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {rootCatalogs.map((cat) => {
              const hasSubs = (cat.subCatalogs?.length ?? 0) > 0;
              const totalCount = hasSubs
                ? (cat.subCatalogs ?? []).reduce((s, c) => s + c.productCount, 0)
                : cat.productCount;
              return (
                <button
                  key={cat.id}
                  onClick={() => { haptic("selection"); setNav({ view: "catalog", catalogId: cat.id, catalogName: cat.name }); }}
                  className="pressable text-left"
                  data-testid={`cat-${cat.name}`}
                >
                  <Glass className="p-4 flex flex-col gap-2 h-full">
                    <div className="w-12 h-12 rounded-xl overflow-hidden flex items-center justify-center text-2xl bg-white/5">
                      {cat.imageUrl
                        ? <img src={cat.imageUrl} alt={cat.name} className="w-full h-full object-cover" />
                        : <span>{catIcon(cat.name)}</span>}
                    </div>
                    <div className="text-sm font-semibold leading-tight">{cat.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {hasSubs
                        ? `${cat.subCatalogs!.length} categories`
                        : `${totalCount} ${totalCount === 1 ? "product" : "products"}`}
                    </div>
                  </Glass>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SearchBar({ q, setQ, placeholder, onBack }: {
  q: string;
  setQ: (v: string) => void;
  placeholder?: string;
  onBack?: () => void;
}) {
  return (
    <Glass className={cn("flex items-center gap-2 px-3 py-2", onBack && "flex-1")}>
      <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder ?? "Search…"}
        className="bg-transparent outline-none flex-1 text-sm placeholder:text-muted-foreground"
        data-testid="input-search"
      />
      {q && (
        <button onClick={() => setQ("")} className="text-muted-foreground text-xs">✕</button>
      )}
    </Glass>
  );
}

function ProductSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}
    </div>
  );
}

function ProductGrid({ products }: { products: import("@/lib/api").Product[] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {products.map((p) => (
        <Link key={p.id} href={`/product/${p.id}`} data-testid={`product-${p.id}`}>
          <Glass className="pressable p-3 h-full flex flex-col">
            <div className="aspect-square rounded-xl bg-white/5 mb-2 overflow-hidden flex items-center justify-center text-3xl">
              {p.imageUrl
                ? <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                : <span>🎮</span>}
            </div>
            <div className="text-xs font-medium line-clamp-2 min-h-[2rem]">{p.name}</div>
            <div className="mt-auto pt-1 flex items-baseline gap-1">
              <span className="text-sm font-bold">{ks(p.effectivePrice)}</span>
              {p.onSale && (
                <span className="text-[10px] line-through text-muted-foreground">
                  {ks(p.price)}
                </span>
              )}
            </div>
            {!p.inStock && (
              <div className="text-[10px] text-rose-300 mt-0.5">Out of stock</div>
            )}
          </Glass>
        </Link>
      ))}
    </div>
  );
}
