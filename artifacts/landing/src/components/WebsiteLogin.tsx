import { useEffect } from "react";

type TelegramLoginPayload = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
  language_code?: string;
};

declare global {
  interface Window {
    __mentalGamingTelegramAuth?: (user: TelegramLoginPayload) => void;
  }
}

export default function WebsiteLogin({ onAuthenticated }: { onAuthenticated: () => void }) {
  const botUsername = String(import.meta.env.VITE_TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");

  useEffect(() => {
    if (!botUsername) return;

    window.__mentalGamingTelegramAuth = (user) => {
      window.localStorage.setItem("telegram-login-data", JSON.stringify(user));
      onAuthenticated();
    };

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.dataset.telegramLogin = botUsername;
    script.dataset.size = "large";
    script.dataset.userpic = "false";
    script.dataset.requestAccess = "write";
    script.dataset.onauth = "__mentalGamingTelegramAuth(user)";
    document.getElementById("telegram-login-widget")?.appendChild(script);

    return () => {
      script.remove();
      delete window.__mentalGamingTelegramAuth;
    };
  }, [botUsername, onAuthenticated]);

  return (
    <main className="min-h-screen flex items-center justify-center px-5">
      <section className="glass-strong w-full max-w-md rounded-3xl p-7 text-center">
        <div className="text-5xl mb-5">🎮</div>
        <h1 className="text-2xl font-bold">Mental Gaming Store</h1>
        <p className="text-zinc-400 mt-2 mb-7">Sign in with Telegram to continue</p>

        {botUsername ? (
          <div id="telegram-login-widget" className="min-h-11 flex justify-center" />
        ) : (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
            Telegram website login is not configured yet. Set VITE_TELEGRAM_BOT_USERNAME in Vercel and redeploy.
          </div>
        )}

        <p className="text-xs text-zinc-500 mt-6">
          Your Telegram account is verified securely by the Mental Gaming bot.
        </p>
      </section>
    </main>
  );
}
