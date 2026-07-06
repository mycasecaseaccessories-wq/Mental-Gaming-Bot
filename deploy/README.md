# Mental Gaming Store — VPS Deployment Guide (မြန်မာ)

Telegram **Bot** ရော **Mini App** (web) ရော VPS တစ်ခုတည်းပေါ်မှာ 24/7 run ဖို့ လမ်းညွှန်။

---

## 📦 VPS ပေါ်မှာ run ရမယ့် အပိုင်း ၃ ခု

| အပိုင်း | ဘာလဲ | ဘယ်လို run |
|---|---|---|
| **bot** | Telegram bot (Telegraf) | PM2 → `mgs-bot` |
| **api-server** | Mini app backend (Express, port 8000) | PM2 → `mgs-api` |
| **landing** | Mini app frontend (React static) | Nginx serve |

---

## ✅ ကြိုတင် လိုအပ်ချက်

1. **VPS** — Ubuntu 22.04 / 24.04 (RAM ≥ 2GB) — Vultr / Contabo / DigitalOcean
2. **Domain** — ဥပမာ `store.example.com` (A record → VPS IP သို့ point)
3. **MongoDB Atlas** — connection string (Network Access မှာ VPS IP whitelist)
4. **Bot token** — @BotFather ကနေ

---

## 🚀 အဆင့်ဆင့် Setup

### 1) VPS မှာ လိုအပ်တာတွေ install

```bash
# Node.js 20 + build tools
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx

# pnpm + PM2
sudo npm install -g pnpm pm2
```

### 2) Code ကို ယူ

```bash
cd ~
git clone <YOUR_REPO_URL> mgs
cd mgs
```
> Git မသုံးရင် — code ကို zip လုပ်ပြီး `scp` နဲ့ VPS ဆီ upload လုပ်လည်း ရ။

### 3) Environment variables ဖြည့်

```bash
cp deploy/.env.example .env
nano .env      # တန်ဖိုးတွေ ဖြည့် (BOT_TOKEN, MONGODB_URI, ...)
```

### 4) dotenv install (PM2 က .env ဖတ်ဖို့)

```bash
pnpm add -w dotenv
```

### 5) ပထမဆုံး deploy

```bash
bash deploy/deploy.sh
```
ဒါက — install → build (api + frontend) → frontend ကို `/var/www/mgs/landing` ကူး → PM2 နဲ့ bot + api start လုပ်ပေးမယ်။

### 6) PM2 ကို server reboot မှာ auto-start

```bash
pm2 save
pm2 startup      # ထွက်လာတဲ့ command ကို copy ပြီး run
```

### 7) Nginx config

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mgs
sudo nano /etc/nginx/sites-available/mgs     # YOUR_DOMAIN ကို ကိုယ့် domain ဖြင့် အစားထိုး
sudo ln -s /etc/nginx/sites-available/mgs /etc/nginx/sites-enabled/mgs
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 8) HTTPS (SSL) — Telegram Mini App အတွက် မဖြစ်မနေ

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d store.example.com
```
Certbot က SSL auto-setup + auto-renew လုပ်ပေးမယ်။

### 9) @BotFather မှာ Mini App URL register

```
/mybots → (bot ရွေး) → Bot Settings → Menu Button / Web App
→ URL: https://store.example.com
```

---

## 🔄 နောက်ပိုင်း update လုပ်နည်း

Code ပြင်ပြီးတိုင်း VPS မှာ:
```bash
cd ~/mgs
bash deploy/deploy.sh
```

---

## 🛠️ အသုံးဝင်တဲ့ command များ

```bash
pm2 status              # process အခြေအနေ
pm2 logs mgs-bot        # bot log
pm2 logs mgs-api        # api log
pm2 restart mgs-bot     # bot restart
sudo systemctl reload nginx    # nginx reload
```

---

## 🐛 ပြဿနာ ဖြစ်ရင်

| လက္ခဏာ | စစ်ဆေးရန် |
|---|---|
| Bot မတုံ့ပြန် | `pm2 logs mgs-bot` — BOT_TOKEN / MONGODB_URI မှန်လား |
| Mini app 502 error | `pm2 logs mgs-api` — api-server တက်လား, PORT=8000 လား |
| Mini app "not secure" | SSL setup လုပ်ပြီးလား (certbot) |
| DB connect မရ | Atlas Network Access မှာ VPS IP whitelist ထည့်ပြီးလား |
| Frontend blank | `landing/dist` build ဖြစ်လား, `/var/www/mgs/landing` ထဲ file ရှိလား |

---

## 📁 Deploy files

| File | ဘာလဲ |
|---|---|
| `.env.example` | env var template |
| `ecosystem.config.cjs` | PM2 config (bot + api) |
| `nginx.conf` | Nginx (static + API proxy) |
| `deploy.sh` | install + build + restart automation |
| `README.md` | ဒီ guide |
