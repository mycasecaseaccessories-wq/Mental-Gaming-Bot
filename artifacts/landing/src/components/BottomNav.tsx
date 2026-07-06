import { Link, useLocation } from "wouter";
import { Home, Store, Gamepad2, Wallet as WalletIcon, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/format";
import { haptic } from "@/lib/telegram";

const tabs = [
  { href: "/",        label: "Home",   icon: Home },
  { href: "/shop",    label: "Shop",   icon: Store },
  { href: "/play",    label: "Play",   icon: Gamepad2 },
  { href: "/wallet",  label: "Wallet", icon: WalletIcon },
  { href: "/profile", label: "Me",     icon: UserIcon },
] as const;

export function BottomNav() {
  const [loc] = useLocation();
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-50 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2"
      data-testid="bottom-nav"
    >
      <div className="glass-strong rounded-3xl mx-auto max-w-md px-2 py-1.5 flex items-center justify-between">
        {tabs.map((t) => {
          const active = loc === t.href || (t.href !== "/" && loc.startsWith(t.href));
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              onClick={() => haptic("selection")}
              className="flex-1"
              data-testid={`nav-${t.label.toLowerCase()}`}
            >
              <div
                className={cn(
                  "pressable flex flex-col items-center justify-center gap-0.5 rounded-2xl py-2 px-1",
                  active ? "bg-primary/15 text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 2} />
                <span className="text-[10px] font-medium leading-none">{t.label}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
