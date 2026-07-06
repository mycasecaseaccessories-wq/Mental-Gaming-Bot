/* eslint-disable @typescript-eslint/no-explicit-any */
interface TgWebApp {
  initData: string;
  initDataUnsafe: {
    user?: { id: number; first_name?: string; username?: string; photo_url?: string };
  };
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  close: () => void;
  setHeaderColor: (c: string) => void;
  setBackgroundColor: (c: string) => void;
  enableClosingConfirmation: () => void;
  MainButton: {
    text: string;
    show: () => void;
    hide: () => void;
    enable: () => void;
    disable: () => void;
    setText: (t: string) => void;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
  };
  BackButton: {
    show: () => void;
    hide: () => void;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
  };
  HapticFeedback: {
    impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
    selectionChanged: () => void;
  };
  showAlert: (msg: string, cb?: () => void) => void;
  showConfirm: (msg: string, cb: (ok: boolean) => void) => void;
  openTelegramLink: (url: string) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export function getTg(): TgWebApp | null {
  return typeof window !== "undefined" ? window.Telegram?.WebApp ?? null : null;
}

export function initDataString(): string {
  return getTg()?.initData || "";
}

export function haptic(kind: "light" | "medium" | "success" | "error" | "selection" = "light") {
  const tg = getTg();
  if (!tg) return;
  try {
    if (kind === "success") tg.HapticFeedback.notificationOccurred("success");
    else if (kind === "error") tg.HapticFeedback.notificationOccurred("error");
    else if (kind === "selection") tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.impactOccurred(kind);
  } catch {
    /* noop */
  }
}

export function bootTelegram() {
  const tg = getTg();
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor("#05070A");
    tg.setBackgroundColor("#05070A");
  } catch {
    /* ignore */
  }
}

export type { TgWebApp };
