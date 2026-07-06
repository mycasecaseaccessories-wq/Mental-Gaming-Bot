import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/format";

interface Props extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "strong" | "blue";
}

export const Glass = forwardRef<HTMLDivElement, Props>(
  ({ variant = "default", className, ...rest }, ref) => {
    const base =
      variant === "blue" ? "glass-blue" : variant === "strong" ? "glass-strong" : "glass";
    return (
      <div
        ref={ref}
        className={cn(base, "rounded-2xl", className)}
        {...rest}
      />
    );
  }
);
Glass.displayName = "Glass";
