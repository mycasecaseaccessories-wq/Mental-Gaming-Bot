# Mental Gaming Store API — Admin Integration Audit

Audit baseline: supplied `Mental-Gaming-Bot` source archive and GitHub repository metadata on 2026-11-01. This is a source-level audit, not a live production verification.

## Repository layout

- `artifacts/bot`: Telegram bot (Telegraf, MongoDB)
- `artifacts/api-server`: Express API, auth middleware, routes and MongoDB models
- `artifacts/landing`: customer storefront
- Shop website and API are in this monorepo; there is no separate `mental-gaming-store` source repository in the supplied project layout.

## Data ownership

MongoDB remains authoritative for customer records, wallet balances/units, deposits/top-ups, orders, transactions, product/catalog data, payment methods and bot operational records.

Admin A's Supabase project is for back-office identity, roles, permissions, audit logs, settings, notifications and announcements. Do not dual-write business records or move wallet/order data into Supabase.

## Existing integration surface observed

- Customer login uses Telegram Login Widget / Telegram WebApp init data validation.
- Storefront calls the API using `VITE_API_URL` and Telegram auth headers.
- Store API has customer routes for products/catalog, orders, wallet, payment methods, banners, notifications and related features.
- Legacy admin routes/pages exist in the storefront and API (orders, products, top-ups, users, analytics, config, gateways, export); API admin routes are protected by Telegram auth plus admin auth.
- Admin A uses a separate HMAC service-authenticated product/catalog/media proxy.
- Admin-portal HMAC validation checks timestamp, nonce, email, signature, allowed route and request details.

## Findings and follow-ups

1. **HMAC replay defense:** source stores used nonces in an in-memory Map. This does not provide reliable shared replay prevention across serverless instances or restarts. Use a shared durable/atomic nonce store or equivalent before adding more privileged writes.
2. **Legacy admin overlap:** retain legacy admin endpoints/UI until Admin A has tested feature parity. Once parity is proven, redirect/deprecate the web admin separately; do not remove Telegram bot admin commands unless explicitly included.
3. **Financial workflow safety:** trace payment submission → manual verification → wallet credit/order completion. Add idempotency and immutable audit events before any new Admin A approval actions.
4. **Read/write separation:** start Admin A with read-only views for users, orders, wallets and transactions. Add narrowly scoped writes only after permission matrix and tests.
5. **Notifications:** route bot/customer/admin notifications through authoritative API events with retry handling; do not let Telegram message delivery determine financial success.
6. **Source TODO discrepancy:** any catalog deletion note in a local archive is not proof of current live catalog state. Recheck the live Store API after Vercel access is authorized; do not infer current counts from stale notes.

## Phase gates

### Gate A — Audit
- Map each Admin A proxy route to the matching Store API handler.
- Map MongoDB models and ownership for all financial entities.
- Trace customer Telegram auth and bot notification events.
- Add API contract tests and document environment-variable *names* only (never values).

### Gate B — Admin integration
- Support Admin A service-auth routes with cross-instance replay defense.
- Add read-only orders/users/wallet/transaction endpoints with pagination and least-data responses.
- Add role-gated payment review endpoints only after idempotency, audit and tests.

### Gate C — Bot integration
- Customer order/payment notifications.
- Admin pending-review notifications.
- Verified payment → exactly-once unit credit.
- Order state updates and retry/dead-letter behavior.

### Gate D — Production
- Security/API/mobile/payment regression tests.
- Vercel build/deployment/domain/env-name verification.
- Smoke test and rollback plan.

## Safety constraints

- Never commit `.env`, bot tokens, MongoDB URIs, HMAC secrets or user/payment data.
- Never mutate production balances, orders or catalog as part of the audit.
- Never disable existing admin paths until Admin A parity and rollback are verified.
- No production deployment from this audit branch.
