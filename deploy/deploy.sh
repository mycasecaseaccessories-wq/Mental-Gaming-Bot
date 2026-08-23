#!/usr/bin/env bash
# =============================================================================
# Mental Gaming Store — VPS deploy / update script
# -----------------------------------------------------------------------------
# ပထမဆုံး setup ပြီးရင်၊ code update လုပ်တိုင်း ဒီ script ကို run လိုက်ရုံ:
#   bash deploy/deploy.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Vite 7 requires Node >=20.19.0. VPS images often still default to Node 18.
node_is_supported="$(node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.stdout.write(String((major === 20 && minor >= 19) || major >= 22 ? 1 : 0))' 2>/dev/null || echo 0)"
if [ "$node_is_supported" != "1" ]; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "==> nvm မတွေ့ပါ။ Node.js 22 bootstrap လုပ်နေသည်..."
    command -v curl >/dev/null 2>&1 || { echo "❌ curl မတွေ့ပါ။ curl ကို install လုပ်ပြီး ပြန် run ပါ။"; exit 1; }
    export PROFILE=/dev/null
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "❌ nvm install မအောင်မြင်ပါ။ အောက်ပါ command ဖြင့် Node.js 22 ကို install လုပ်ပြီး ပြန် run ပါ။"
    echo "   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    exit 1
  fi
  echo "==> Node.js 20.19+ လိုအပ်သောကြောင့် Node.js 22 သို့ ပြောင်းနေသည်..."
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  command -v corepack >/dev/null 2>&1 && corepack enable
fi

if ! command -v pnpm >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || { echo "❌ pnpm မတွေ့ပါ။ Node.js 22/corepack ကို enable လုပ်ပါ။"; exit 1; }
  corepack prepare pnpm@10.34.5 --activate
fi

echo "==> [1/5] Latest code ဆွဲနေသည် (git pull)..."
git pull --ff-only

echo "==> [2/5] Dependencies install (pnpm)..."
# Re-fetch optional native packages (Tailwind/Rollup) for the active OS + Node runtime.
pnpm install --frozen-lockfile --force

echo "==> [3/5] Backend + shared libs build..."
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run build

echo "==> [4/5] Mini app frontend build..."
pnpm --filter @workspace/landing run build

echo "==> Frontend build ကို /var/www/mgs/landing သို့ ကူးနေသည်..."
sudo mkdir -p /var/www/mgs/landing
sudo rm -rf /var/www/mgs/landing/*
sudo cp -r artifacts/landing/dist/* /var/www/mgs/landing/

echo "==> [5/5] PM2 restart (bot + api-server)..."
# Use the ecosystem file as the source of truth. This avoids failures caused
# by manually restarting an old process name such as `mental-bot`.
# Remove the obsolete name if it was created by an older deployment.
pm2 delete mental-bot >/dev/null 2>&1 || true
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save --force
pm2 status

echo ""
echo "✅ Deploy ပြီးပါပြီ။"
echo "   pm2 status        — process တွေ ကြည့်ရန်"
echo "   pm2 logs mgs-bot  — bot log ကြည့်ရန်"
echo "   pm2 logs mgs-api  — api log ကြည့်ရန်"
