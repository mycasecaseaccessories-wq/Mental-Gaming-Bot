import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Sparkles, Wallet, ArrowRight, Flame, ChevronRight, Gamepad2, TrendingUp, Clock, Bell } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, type Me, type ShopResponse, type Product, type Banner, type PopularResponse, type NotificationsResponse } from "@/lib/api";
import { ks, coin } from "@/lib/format";
import { haptic } from "@/lib/telegram";
import { useState, useEffect } from "react";

const TIER_EMOJI: Record<string, string> = {
  Bronze: "🥉", Silver: "🥈", Gold: "🥇", Platinum: "🪙", Diamond: "💎",
};

export default function HomePage() {
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const flashQ = useQuery({
    queryKey: ["flashsale"],
    queryFn: () => api.get<{ products: Product[] }>("/flashsale"),
  });
  const shopQ = useQuery({
    queryKey: ["shop"],
    queryFn: () => api.get<ShopResponse>("/products"),
  });
  const bannersQ = useQuery({
    queryKey: ["banners"],
    queryFn: () => api.get<{ banners: Banner[] }>("/banners"),
    staleTime: 60_000,
  });
  const popularQ = useQuery({
    queryKey: ["popular"],
    queryFn: () => api.get<PopularResponse>("/popular"),
    staleTime: 120_000,
  });
  const notifQ = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationsResponse>("/notifications"),
    staleTime: 30_000,
  });

  const [, nav] = useLocation();
  const unread = notifQ.data?.unreadCount ?? 0;

  return (
    <Layout showNav title="Mental Gaming">
      <div className="space-y-5 pt-1">
        {/* Notification bell */}
        <div className="flex justify-end -mb-3">
          <button
            onClick={() => { haptic("light"); nav("/notifications"); }}
            className="pressable relative flex items-center gap-1 text-xs text-muted-foreground px-2 py-1 rounded-lg"
          >
            <Bell className="h-4 w-4" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[9px] font-bold flex items-center justify-center text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        </div>

        {/* Promotion Banners */}
        {bannersQ.data && bannersQ.data.banners.length > 0 && (
          <BannerCarousel banners={bannersQ.data.banners} />
        )}

        {/* Wallet card */}
        <Glass variant="blue" className="p-5" data-testid="card-wallet">
          {meQ.isLoading ? (
            <Skeleton className="h-24" />
          ) : meQ.data ? (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-wider text-white/70">
                    Hi, {meQ.data.firstName || "there"}
                  </div>
                  <div className="text-3xl font-bold mt-1" data-testid="text-balance-ks">
                    {ks(meQ.data.balanceKS)}
                  </div>
                  <div className="text-sm text-white/70 mt-0.5" data-testid="text-balance-coin">
                    + {coin(meQ.data.balanceCoin)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-white/60">Tier</div>
                  <div className="text-base font-semibold">
                    {TIER_EMOJI[meQ.data.activeTier ?? meQ.data.tier] ?? ""}{" "}
                    {meQ.data.activeTier ?? meQ.data.tier}
                  </div>
                  {meQ.data.tierDiscountPct > 0 && (
                    <div className="text-xs text-white/70 mt-0.5">
                      −{meQ.data.tierDiscountPct}% all orders
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4">
                <Link
                  href="/topup"
                  className="pressable glass-strong rounded-xl py-3 text-center text-sm font-medium flex items-center justify-center gap-1.5"
                  data-testid="button-topup"
                >
                  <Wallet className="h-4 w-4" /> Top Up
                </Link>
                <Link
                  href="/shop"
                  className="pressable bg-white text-black rounded-xl py-3 text-center text-sm font-semibold flex items-center justify-center gap-1.5"
                  data-testid="button-shop-now"
                >
                  <Sparkles className="h-4 w-4" /> Shop Now
                </Link>
              </div>
            </>
          ) : (
            <div className="text-sm text-white/80">Connecting to Telegram…</div>
          )}
        </Glass>

        {/* Play & Earn shortcuts */}
        <section data-testid="section-play">
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Gamepad2 className="h-4 w-4 text-primary" /> Play & Earn
            </h2>
            <Link href="/play" className="text-xs text-primary flex items-center">
              All <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { href: "/spin",     emoji: "🎰", label: "Spin" },
              { href: "/checkin",  emoji: "📅", label: "Check-In" },
              { href: "/referral", emoji: "🤝", label: "Referral" },
            ].map((item) => (
              <Link key={item.href} href={item.href}>
                <Glass className="pressable p-3 flex flex-col items-center gap-1 text-center">
                  <span className="text-2xl">{item.emoji}</span>
                  <span className="text-xs font-medium">{item.label}</span>
                </Glass>
              </Link>
            ))}
          </div>
        </section>

        {/* Flash sale */}
        {flashQ.data && flashQ.data.products.length > 0 && (
          <section data-testid="section-flashsale">
            <div className="flex items-center justify-between mb-2 px-1">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Flame className="h-4 w-4 text-orange-400" /> Flash Sale
              </h2>
              <Link href="/shop" className="text-xs text-primary flex items-center">
                See all <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-1">
              {flashQ.data.products.map((p) => (
                <Link key={p.id} href={`/product/${p.id}`} className="shrink-0 w-40">
                  <ProductMiniCard p={p} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Popular Products */}
        {popularQ.data && popularQ.data.popular.length > 0 && (
          <section data-testid="section-popular">
            <div className="flex items-center justify-between mb-2 px-1">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <TrendingUp className="h-4 w-4 text-green-400" /> Popular
              </h2>
              <Link href="/shop" className="text-xs text-primary flex items-center">
                See all <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-1">
              {popularQ.data.popular.slice(0, 6).map((p) => (
                <Link key={p.id} href={`/product/${p.id}`} className="shrink-0 w-36">
                  <ProductMiniCard p={p} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Recently Purchased */}
        {popularQ.data && popularQ.data.recent.length > 0 && (
          <section data-testid="section-recent">
            <div className="flex items-center justify-between mb-2 px-1">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-blue-400" /> Recently Purchased
              </h2>
            </div>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-1">
              {popularQ.data.recent.slice(0, 5).map((p) => (
                <Link key={p.id} href={`/product/${p.id}`} className="shrink-0 w-36">
                  <ProductMiniCard p={p} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Categories */}
        {shopQ.data && shopQ.data.categories.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-2 px-1">
              <h2 className="text-sm font-semibold">Categories</h2>
              <Link href="/shop" className="text-xs text-primary flex items-center">
                Browse <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {shopQ.data.categories.slice(0, 6).map((c) => (
                <Link
                  key={c.name}
                  href={`/shop?category=${encodeURIComponent(c.name)}`}
                  data-testid={`category-${c.name}`}
                >
                  <Glass className="pressable p-4 flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.count} items</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </Glass>
                </Link>
              ))}
            </div>
          </section>
        )}

        {shopQ.isLoading && (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

// ── Banner Carousel ────────────────────────────────────────────────────────────

function BannerCarousel({ banners }: { banners: Banner[] }) {
  const [active, setActive] = useState(0);
  const [, nav] = useLocation();

  useEffect(() => {
    if (banners.length <= 1) return;
    const id = setInterval(() => setActive((a) => (a + 1) % banners.length), 4000);
    return () => clearInterval(id);
  }, [banners.length]);

  const b = banners[active];
  if (!b) return null;

  function handleBannerClick() {
    haptic("light");
    if (!b) return;
    if (b.targetType === "product" && b.targetId) nav(`/product/${b.targetId}`);
    else if (b.targetType === "category" && b.targetId)
      nav(`/shop?category=${encodeURIComponent(b.targetId)}`);
    else if (b.targetType === "shop") nav("/shop");
    else if (b.targetType === "url" && b.targetId) window.open(b.targetId, "_blank");
  }

  return (
    <div className="relative">
      <div
        className="pressable relative h-36 rounded-2xl overflow-hidden cursor-pointer"
        style={{
          background: b.imageUrl
            ? `url(${b.imageUrl}) center/cover no-repeat`
            : "linear-gradient(135deg, #1e3a5f 0%, #0f2240 100%)",
        }}
        onClick={handleBannerClick}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-4">
          <div className="text-white font-bold text-sm leading-tight">{b.title}</div>
          {b.subtitle && (
            <div className="text-white/80 text-xs mt-0.5 line-clamp-1">{b.subtitle}</div>
          )}
          {b.buttonText && (
            <div className="mt-2 inline-flex items-center gap-1 text-xs bg-white text-black rounded-full px-3 py-1 font-semibold">
              {b.buttonText} <ChevronRight className="h-3 w-3" />
            </div>
          )}
        </div>
      </div>

      {banners.length > 1 && (
        <div className="flex justify-center gap-1.5 mt-2">
          {banners.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === active ? "w-4 bg-primary" : "w-1.5 bg-white/30"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Product Mini Card ──────────────────────────────────────────────────────────

function ProductMiniCard({ p }: { p: Product }) {
  const statusLabel =
    p.status === "out_of_stock" ? "Sold Out" : p.status === "coming_soon" ? "Soon" : null;
  return (
    <Glass className="pressable p-3" data-testid={`mini-product-${p.id}`}>
      <div className="aspect-square rounded-xl bg-white/5 mb-2 overflow-hidden flex items-center justify-center text-2xl relative">
        {p.imageUrl ? (
          <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
        ) : (
          <span>🎮</span>
        )}
        {statusLabel && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <span className="text-[10px] font-bold text-white/80">{statusLabel}</span>
          </div>
        )}
      </div>
      <div className="text-xs font-medium truncate">{p.name}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={`text-sm font-bold ${
            p.status === "out_of_stock" ? "text-muted-foreground" : ""
          }`}
        >
          {p.status === "coming_soon" ? "Coming Soon" : ks(p.effectivePrice)}
        </span>
        {p.onSale && p.status === "active" && (
          <span className="text-[10px] line-through text-muted-foreground">{ks(p.price)}</span>
        )}
      </div>
    </Glass>
  );
}
