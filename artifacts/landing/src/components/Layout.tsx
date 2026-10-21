import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, CircleUserRound, ClipboardList, CreditCard, Gamepad2, Store } from "lucide-react";
import { BottomNav } from "./BottomNav";
import { getTg, haptic } from "@/lib/telegram";

interface Props {
  title?: string;
  showBack?: boolean;
  showNav?: boolean;
  right?: ReactNode;
  children: ReactNode;
}

export function Layout({ title, showBack, showNav = true, right, children }: Props) {
  const [, navigate] = useLocation();

  useEffect(() => {
    const tg = getTg();
    if (!tg) return undefined;
    if (!showBack) {
      tg.BackButton.hide();
      return undefined;
    }
    const handler = () => {
      haptic("light");
      if (history.length > 1) history.back();
      else navigate("/");
    };
    tg.BackButton.show();
    tg.BackButton.onClick(handler);
    return () => {
      tg.BackButton.offClick(handler);
      tg.BackButton.hide();
    };
  }, [showBack, navigate]);

  return (
    <div className="min-h-screen pb-20 md:pb-8">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#05070A]/85 px-4 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4">
            {showBack && (
              <button
                aria-label="Back"
                onClick={() => {
                  haptic("light");
                  history.length > 1 ? history.back() : navigate("/");
                }}
                className="pressable glass h-9 w-9 rounded-full flex items-center justify-center"
                data-testid="header-back"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <a href="/" className="flex shrink-0 items-center gap-2 text-lg font-black tracking-tight"><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-white"><Gamepad2 className="h-5 w-5" /></span><span>Mental <span className="text-primary">Gaming</span></span></a>
            <nav className="hidden flex-1 items-center justify-center gap-1 md:flex">
              <NavLink href="/shop" icon={<Store className="h-4 w-4" />} label="Shop" />
              <NavLink href="/orders" icon={<ClipboardList className="h-4 w-4" />} label="Orders" />
              <NavLink href="/topup" icon={<CreditCard className="h-4 w-4" />} label="Top Up" />
            </nav>
            {title && title !== "Mental Gaming" && <h1 className="hidden flex-1 truncate text-base font-semibold tracking-tight lg:block">{title}</h1>}
            {right}
            <a href="/profile" className="ml-auto hidden items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-3 py-2 text-sm font-semibold hover:border-primary/50 sm:flex"><CircleUserRound className="h-4 w-4 text-primary" /> Profile</a>
        </div>
      </header>
      <main className="px-4">{children}</main>
      {showNav && <BottomNav />}
    </div>
  );
}

function NavLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return <a href={href} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-white/[.06] hover:text-white">{icon}{label}</a>;
}
