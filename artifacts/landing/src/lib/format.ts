export const ks = (n: number) => `${Math.round(n).toLocaleString()} KS`;
export const coin = (n: number) => `${Math.round(n).toLocaleString()} MC`;

export function timeAgo(iso: string | Date | null): string {
  if (!iso) return "";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const sec = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString();
}

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
