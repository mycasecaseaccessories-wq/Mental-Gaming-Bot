import { cn } from "@/lib/format";
import type { OrderStatus } from "@/lib/api";

const styles: Record<OrderStatus, string> = {
  Pending:    "bg-amber-500/15 text-amber-300 border-amber-400/30",
  Processing: "bg-blue-500/15 text-blue-300 border-blue-400/30",
  Success:    "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  Cancelled:  "bg-zinc-500/15 text-zinc-300 border-zinc-400/30",
  Refunded:   "bg-rose-500/15 text-rose-300 border-rose-400/30",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border",
        styles[status]
      )}
      data-testid={`status-${status.toLowerCase()}`}
    >
      {status}
    </span>
  );
}
