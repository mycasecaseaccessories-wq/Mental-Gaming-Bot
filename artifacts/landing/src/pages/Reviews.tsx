import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, Quote, MessageSquarePlus, CheckCircle2 } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import {
  api,
  type PublicReview,
  type ReviewStats,
  type RatableOrder,
  type ApiError,
} from "@/lib/api";
import { cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

function Stars({ value, size = 16 }: { value: number; size?: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          style={{ width: size, height: size }}
          className={cn(
            i <= value ? "fill-amber-400 text-amber-400" : "text-white/20"
          )}
        />
      ))}
    </div>
  );
}

function RateCard({
  order,
  onDone,
}: {
  order: RatableOrder;
  onDone: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const qc = useQueryClient();

  const mut = useMutation<{ ok: boolean }, ApiError, void>({
    mutationFn: () =>
      api.post("/reviews", {
        orderId: order.orderId,
        rating,
        comment: comment.trim() || undefined,
      }),
    onSuccess: () => {
      haptic("success");
      qc.invalidateQueries({ queryKey: ["reviews-wall"] });
      qc.invalidateQueries({ queryKey: ["reviews-mine"] });
      qc.invalidateQueries({ queryKey: ["reviews-ratable"] });
      onDone();
    },
    onError: () => haptic("error"),
  });

  return (
    <Glass className="p-4 space-y-3">
      <div className="text-sm font-medium">{order.productName}</div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            onClick={() => {
              haptic("selection");
              setRating(i);
            }}
            className="pressable p-1"
            data-testid={`star-${order.orderId}-${i}`}
            aria-label={`${i} stars`}
          >
            <Star
              className={cn(
                "h-7 w-7 transition-colors",
                i <= rating ? "fill-amber-400 text-amber-400" : "text-white/25"
              )}
            />
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 500))}
            placeholder={
              rating >= 4
                ? "Tell others what you loved (optional)…"
                : "How can we improve? (optional)"
            }
            rows={2}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 outline-none focus:border-primary text-sm resize-none"
            data-testid={`comment-${order.orderId}`}
          />
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="pressable w-full bg-primary text-white rounded-xl py-2.5 text-sm font-semibold disabled:opacity-60"
            data-testid={`submit-review-${order.orderId}`}
          >
            {mut.isPending ? "Submitting…" : "Submit review"}
          </button>
        </>
      )}
    </Glass>
  );
}

export default function ReviewsPage() {
  const wall = useQuery({
    queryKey: ["reviews-wall"],
    queryFn: () => api.get<{ reviews: PublicReview[]; stats: ReviewStats }>("/reviews"),
  });
  const ratable = useQuery({
    queryKey: ["reviews-ratable"],
    queryFn: () => api.get<{ orders: RatableOrder[] }>("/reviews/ratable"),
  });

  const stats = wall.data?.stats;
  const reviews = wall.data?.reviews ?? [];
  const ratableOrders = ratable.data?.orders ?? [];

  return (
    <Layout title="Reviews" showBack showNav={false}>
      <div className="space-y-5 pb-28 pt-1">
        {/* Stats header */}
        {wall.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <Glass className="p-5 text-center">
            <div className="text-4xl font-bold text-amber-400">
              {stats?.avgRating ?? 0}
              <span className="text-lg text-muted-foreground">/5</span>
            </div>
            <div className="flex justify-center mt-2">
              <Stars value={Math.round(stats?.avgRating ?? 0)} size={18} />
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {stats?.rated ?? 0} ratings · {stats?.fiveStars ?? 0} five-star
            </div>
          </Glass>
        )}

        {/* Rate your orders */}
        {ratableOrders.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <MessageSquarePlus className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Rate your orders</h2>
            </div>
            {ratableOrders.map((o) => (
              <RateCard
                key={o.orderId}
                order={o}
                onDone={() => {
                  /* invalidation handled in mutation */
                }}
              />
            ))}
          </section>
        )}

        {/* Public wall */}
        <section className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <Quote className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">What customers say</h2>
          </div>

          {wall.isLoading ? (
            <Skeleton className="h-40" />
          ) : reviews.length === 0 ? (
            <Glass className="p-8 text-center">
              <CheckCircle2 className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
              <div className="font-semibold">No reviews yet</div>
              <div className="text-xs text-muted-foreground mt-1">
                Be the first to rate a completed order!
              </div>
            </Glass>
          ) : (
            <div className="space-y-2">
              {reviews.map((r) => (
                <Glass key={r.id} className="p-4 space-y-2" data-testid={`review-${r.id}`}>
                  <div className="flex items-center justify-between">
                    <Stars value={r.rating} />
                    <span className="text-xs text-muted-foreground">{r.author}</span>
                  </div>
                  <p className="text-sm leading-relaxed">"{r.comment}"</p>
                  <div className="text-xs text-muted-foreground">🛒 {r.productName}</div>
                </Glass>
              ))}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
