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

echo "==> [1/5] Latest code ဆွဲနေသည် (git pull)..."
git pull --ff-only

echo "==> [2/5] Dependencies install (pnpm)..."
pnpm install --frozen-lockfile

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
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save --force

echo ""
echo "✅ Deploy ပြီးပါပြီ။"
echo "   pm2 status        — process တွေ ကြည့်ရန်"
echo "   pm2 logs mgs-bot  — bot log ကြည့်ရန်"
echo "   pm2 logs mgs-api  — api log ကြည့်ရန်"
