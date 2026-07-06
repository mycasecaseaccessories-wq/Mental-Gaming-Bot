import type { ReactNode } from "react";
import { Glass } from "./Glass";

export function EmptyState({
  icon, title, hint, action,
}: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <Glass className="p-8 flex flex-col items-center text-center gap-3">
      {icon && <div className="text-primary">{icon}</div>}
      <div>
        <div className="font-semibold">{title}</div>
        {hint && <div className="text-sm text-muted-foreground mt-1">{hint}</div>}
      </div>
      {action}
    </Glass>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-2xl bg-white/5 ${className}`}
      aria-hidden
    />
  );
}
