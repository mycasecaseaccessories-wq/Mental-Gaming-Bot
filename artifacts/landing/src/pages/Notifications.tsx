import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, CheckCheck, Package, Gift, Megaphone, Star } from "lucide-react";
import { useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, type NotificationsResponse } from "@/lib/api";
import { haptic } from "@/lib/telegram";

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  order_completed:      { icon: <Package className="h-4 w-4" />,   color: "text-green-400" },
  order_cancelled:      { icon: <Package className="h-4 w-4" />,   color: "text-red-400" },
  refund_completed:     { icon: <Gift className="h-4 w-4" />,      color: "text-yellow-400" },
  new_promotion:        { icon: <Megaphone className="h-4 w-4" />, color: "text-purple-400" },
  reward_unlocked:      { icon: <Gift className="h-4 w-4" />,      color: "text-yellow-400" },
  review_reward:        { icon: <Star className="h-4 w-4" />,      color: "text-yellow-400" },
  system_announcement:  { icon: <Bell className="h-4 w-4" />,      color: "text-blue-400" },
};

function timeAgo(dateStr: string | null) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [, nav] = useLocation();

  const notifQ = useQuery<NotificationsResponse>({
    queryKey: ["notifications"],
    queryFn: () => api.get("/notifications"),
  });

  const readMut = useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const readAllMut = useMutation({
    mutationFn: () => api.patch("/notifications/read-all", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  function handleTap(n: { id: string; isRead: boolean; targetType: string; targetId: string | null }) {
    haptic("light");
    if (!n.isRead) readMut.mutate(n.id);
    if (n.targetType === "order" && n.targetId) {
      nav(`/order/${n.targetId}`);
    } else if (n.targetType === "product" && n.targetId) {
      nav(`/product/${n.targetId}`);
    }
  }

  const notifications = notifQ.data?.notifications ?? [];
  const unread = notifQ.data?.unreadCount ?? 0;

  return (
    <Layout title="Notifications" showBack showNav>
      <div className="space-y-3 pt-1">
        {unread > 0 && (
          <div className="flex justify-end px-1">
            <button
              onClick={() => { haptic("light"); readAllMut.mutate(); }}
              className="pressable text-xs text-primary flex items-center gap-1.5"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          </div>
        )}

        {notifQ.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : notifications.length === 0 ? (
          <Glass className="p-8 flex flex-col items-center gap-3 text-center">
            <BellOff className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <div className="font-medium text-sm">No notifications yet</div>
              <div className="text-xs text-muted-foreground mt-1">
                Order updates, rewards, and announcements will appear here.
              </div>
            </div>
          </Glass>
        ) : (
          <Glass className="divide-y divide-white/5">
            {notifications.map((n) => {
              const cfg = TYPE_CONFIG[n.type] ?? TYPE_CONFIG["system_announcement"];
              return (
                <div
                  key={n.id}
                  className={`pressable flex items-start gap-3 px-4 py-3.5 cursor-pointer ${!n.isRead ? "bg-white/[0.03]" : ""}`}
                  onClick={() => handleTap(n)}
                >
                  <div className={`mt-0.5 h-8 w-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 ${cfg.color}`}>
                    {cfg.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{n.title}</span>
                      {!n.isRead && (
                        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
                      )}
                    </div>
                    {n.body && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground/60 mt-1">{timeAgo(n.at)}</p>
                  </div>
                  {n.isRead && (
                    <Check className="h-3 w-3 text-muted-foreground/30 mt-1 shrink-0" />
                  )}
                </div>
              );
            })}
          </Glass>
        )}
      </div>
    </Layout>
  );
}
