import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { EmptyState, Skeleton } from "@/components/EmptyState";
import { api, type Product, type Me } from "@/lib/api";
import { ks } from "@/lib/format";
import { haptic } from "@/lib/telegram";

export default function ProductDetailPage() {
  const [, params] = useRoute<{ id: string }>("/product/:id");
  const [, navigate] = useLocation();
  const id = params?.id || "";

  const pQ = useQuery({
    queryKey: ["product", id],
    queryFn: () => api.get<Product>(`/products/${id}`),
    enabled: !!id,
  });
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });

  return (
    <Layout title="Product" showBack showNav={false}>
      {pQ.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-20" />
        </div>
      ) : !pQ.data ? (
        <EmptyState title="Product not found" />
      ) : (
        <div className="space-y-4">
          <Glass className="overflow-hidden">
            <div className="aspect-[4/3] bg-white/5 flex items-center justify-center text-6xl">
              {pQ.data.imageUrl
                ? <img src={pQ.data.imageUrl} alt={pQ.data.name} className="w-full h-full object-cover" />
                : <span>🎮</span>}
            </div>
            <div className="p-4">
              <div className="text-xs text-muted-foreground">
                {pQ.data.category} · {pQ.data.region}
              </div>
              <h2 className="text-xl font-bold mt-0.5">{pQ.data.name}</h2>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-bold">{ks(pQ.data.effectivePrice)}</span>
                {pQ.data.onSale && (
                  <span className="text-sm line-through text-muted-foreground">
                    {ks(pQ.data.price)}
                  </span>
                )}
              </div>
              {meQ.data && meQ.data.tierDiscountPct > 0 && (
                <div className="mt-1 text-xs text-primary">
                  {meQ.data.tier} tier saves you {meQ.data.tierDiscountPct}% more at checkout
                </div>
              )}
              {pQ.data.description && (
                <p className="mt-3 text-sm text-muted-foreground whitespace-pre-wrap">
                  {pQ.data.description}
                </p>
              )}
              {!pQ.data.inStock && (
                <div className="mt-3 text-sm text-rose-300">Currently out of stock</div>
              )}
            </div>
          </Glass>

          <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 bg-gradient-to-t from-background to-transparent">
            <button
              disabled={!pQ.data.inStock}
              onClick={() => {
                haptic("medium");
                navigate(`/order/${pQ.data!.id}`);
              }}
              className="pressable w-full bg-primary text-white rounded-2xl py-4 font-semibold disabled:opacity-50"
              data-testid="button-buy"
            >
              {pQ.data.inStock ? `Buy for ${ks(pQ.data.effectivePrice)}` : "Out of stock"}
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}
