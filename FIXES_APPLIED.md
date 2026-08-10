# Fixes Applied — 2026-08-09

This patched copy addresses the critical reliability/security findings from the source review.

## Order and stock safety
- Mini App orders now reserve the full requested quantity atomically before wallet debit.
- Failed order creation restores reserved stock, wallet funds, and consumed promo state.
- Bot orders reserve finite stock inside the MongoDB transaction and debit wallet conditionally.
- Reward redemptions (Bot + Mini App API) atomically reserve stock and compensate on failure.
- Customer self-cancel now uses `OrderService.cancelAndRefund`, restoring wallet funds and stock.

## Top-up safety
- Added a DB partial unique index so each user can have at most one Pending Topup.
- Mini App creates a pending reservation before sending the screenshot to admin, closing the concurrent-submit race.
- Screenshot bytes are SHA-256 hashed before Telegram forwarding to catch Mini App duplicates early.
- Telegram duplicate detection is retained; stale admin messages are deleted on rollback where possible.

## Web/API security
- Production webhook requests require `WEBHOOK_SECRET` (HMAC SHA-256).
- Production webhook IP access fails closed unless an allow-list is configured or `WEBHOOK_ALLOW_ANY_IP=true` is explicitly set.
- Added a 1 MiB webhook payload cap and a dedicated webhook rate limiter.
- Production browser CORS is allow-list based via `CORS_ALLOWED_ORIGINS`.
- Telegram Mini App `initData` is accepted only from `X-Telegram-Init-Data`, not query strings.
- Added a root `.gitignore` to reduce accidental secret/build artifact commits.

## Deployment action required
Set these in production `.env` before deploying:

```env
WEBHOOK_SECRET=<long-random-secret>
WEBHOOK_ALLOWED_IPS=<provider-ip-1,provider-ip-2>
WEBHOOK_ALLOW_ANY_IP=false
CORS_ALLOWED_ORIGINS=https://your-mini-app-domain.example
```

If the provider cannot supply fixed callback IPs, set `WEBHOOK_ALLOW_ANY_IP=true`; HMAC remains required.

## Validation performed
- JavaScript syntax checks passed for modified bot files.
- Modified TypeScript files passed TypeScript transpile/syntax diagnostics.
- Full workspace typecheck could not run in the review environment because project dependencies were not installed and registry network access was unavailable.
