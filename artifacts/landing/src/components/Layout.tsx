import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { ChevronLeft } from "lucide-react";
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
    <div className="min-h-screen pb-28">
      {(title || showBack || right) && (
        <header className="sticky top-0 z-40 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 backdrop-blur-xl">
          <div className="flex items-center gap-2 h-11">
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
            <h1 className="flex-1 text-base font-semibold tracking-tight truncate">
              {title}
            </h1>
            {right}
          </div>
        </header>
      )}
      <main className="px-4">{children}</main>
      {showNav && <BottomNav />}
    </div>
  );
}
