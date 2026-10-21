import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowRight, ChevronRight, Clock3, Search, ShieldCheck, ShoppingBag, Sparkles, WalletCards, Zap } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Skeleton } from "@/components/EmptyState";
import { api, type Banner, type Product, type ShopResponse } from "@/lib/api";
import { ks } from "@/lib/format";

const CATEGORY_ICONS: Record<string, string> = {
  "Mobile Legends": "⚔️",
  "PUBG Mobile": "🎯",
  "Free Fire": "🔥",
  "Genshin Impact": "✨",
  Valorant: "💥",
  Steam: "🎮",
  Google: "▶️",
  Apple: "",
};

function categoryIcon(name: string) {
  const match = Object.keys(CATEGORY_ICONS).find((key) => name.toLowerCase().includes(key.toLowerCase()));
  return match ? CATEGORY_ICONS[match] : "🎮";
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const shopQ = useQuery({
    queryKey: ["shop"],
    queryFn: () => api.get<ShopResponse>("/products"),
    staleTime: 60_000,
  });
  const bannersQ = useQuery({
    queryKey: ["banners"],
    queryFn: () => api.get<{ banners: Banner[] }>("/banners"),
    staleTime: 60_000,
  });

  const products = shopQ.data?.products ?? [];
  const categories = shopQ.data?.categories ?? [];
  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => `${p.name} ${p.category} ${p.region}`.toLowerCase().includes(q));
  }, [products, search]);
  const featured = (bannersQ.data?.banners ?? [])[0];

  return (
    <Layout showNav={false}>
      <div className="mx-auto max-w-6xl space-y-8 pb-14 pt-5 md:pt-9">
        <section className="grid gap-5 lg:grid-cols-[1.45fr_.8fr]">
          <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-700 p-7 shadow-2xl shadow-blue-950/30 md:p-10">
            <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/15 blur-3xl" />
            <div className="relative max-w-xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90">
                <Zap className="h-3.5 w-3.5" /> Fast digital delivery
              </div>
              <h1 className="text-3xl font-black tracking-tight text-white md:text-5xl">Top up. Play more. Pay less.</h1>
              <p className="mt-4 max-w-md text-sm leading-6 text-blue-100 md:text-base">Game credits, gift cards and digital products delivered quickly by Mental Gaming Store.</p>
              <button onClick={() => navigate("/shop")} className="pressable mt-7 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-blue-700 shadow-lg shadow-blue-950/20">
                Browse products <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="rounded-[2rem] border border-white/10 bg-white/[.045] p-6">
            <div className="flex items-center gap-2 text-sm font-bold"><ShieldCheck className="h-5 w-5 text-emerald-400" /> Safe and simple</div>
            <div className="mt-6 space-y-5 text-sm text-muted-foreground">
              <Feature icon={<Clock3 />} title="Quick delivery" text="Most products are delivered within minutes." />
              <Feature icon={<WalletCards />} title="Easy top up" text="Add balance and checkout without friction." />
              <Feature icon={<ShoppingBag />} title="Order history" text="Track your purchases from one place." />
            </div>
          </div>
        </section>

        {featured && <FeaturedBanner banner={featured} onClick={() => navigate(featured.targetType === "product" && featured.targetId ? `/product/${featured.targetId}` : "/shop")} />}

        <section className="space-y-3">
          <div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.2em] text-primary">Explore</p><h2 className="mt-1 text-xl font-bold">Shop by category</h2></div><Link href="/shop" className="text-sm text-muted-foreground hover:text-white">View all <ChevronRight className="inline h-4 w-4" /></Link></div>
          {shopQ.isLoading ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{categories.slice(0, 12).map((cat) => <Link key={cat.name} href={`/shop?category=${encodeURIComponent(cat.name)}`} className="pressable rounded-2xl border border-white/10 bg-white/[.045] p-4 hover:border-primary/50 hover:bg-primary/10"><div className="text-2xl">{categoryIcon(cat.name)}</div><div className="mt-3 truncate text-sm font-semibold">{cat.name}</div><div className="mt-1 text-xs text-muted-foreground">{cat.count} items</div></Link>)}</div>}
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.2em] text-primary">Storefront</p><h2 className="mt-1 text-xl font-bold">Popular products</h2></div><div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[.045] px-3 py-2 sm:max-w-xs"><Search className="h-4 w-4 text-muted-foreground" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" /></div></div>
          {shopQ.isLoading ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"><ProductSkeleton /><ProductSkeleton /><ProductSkeleton /><ProductSkeleton /></div> : visibleProducts.length === 0 ? <div className="rounded-2xl border border-dashed border-white/15 py-14 text-center text-sm text-muted-foreground">No products found. Try another search.</div> : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{visibleProducts.slice(0, 12).map((product) => <ProductCard key={product.id} product={product} />)}</div>}
        </section>
      </div>
    </Layout>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="flex gap-3"><div className="rounded-xl bg-primary/15 p-2 text-primary">{icon}</div><div><div className="font-semibold text-foreground">{title}</div><div className="mt-1 text-xs leading-5">{text}</div></div></div>; }

function FeaturedBanner({ banner, onClick }: { banner: Banner; onClick: () => void }) { return <button onClick={onClick} className="pressable relative h-44 w-full overflow-hidden rounded-[1.75rem] border border-white/10 text-left md:h-56" style={{ background: banner.imageUrl ? `url(${banner.imageUrl}) center/cover` : "linear-gradient(110deg,#172554,#312e81)" }}><div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/35 to-transparent" /><div className="absolute bottom-6 left-6 max-w-lg md:left-8"><div className="text-xs font-semibold uppercase tracking-[.18em] text-blue-200">Special offer</div><div className="mt-2 text-xl font-bold text-white md:text-2xl">{banner.title}</div>{banner.subtitle && <div className="mt-1 text-sm text-white/75">{banner.subtitle}</div>}</div></button>; }

function ProductCard({ product }: { product: Product }) { return <Link href={`/product/${product.id}`} className="pressable group rounded-2xl border border-white/10 bg-white/[.045] p-3 hover:-translate-y-0.5 hover:border-primary/50"><div className="relative aspect-square overflow-hidden rounded-xl bg-black/25">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" /> : <div className="flex h-full items-center justify-center text-4xl">🎮</div>}{product.onSale && <span className="absolute left-2 top-2 rounded-md bg-rose-500 px-2 py-1 text-[10px] font-bold">SALE</span>}</div><div className="mt-3 line-clamp-2 min-h-10 text-sm font-semibold">{product.name}</div><div className="mt-2 flex items-baseline gap-2"><span className="font-bold text-primary">{ks(product.effectivePrice)}</span>{product.onSale && <span className="text-xs text-muted-foreground line-through">{ks(product.price)}</span>}</div><div className="mt-1 text-xs text-muted-foreground">{product.region || "Global"} · {product.inStock ? "Available" : "Out of stock"}</div></Link>; }

function ProductSkeleton() { return <div className="space-y-3"><Skeleton className="aspect-square" /><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>; }
