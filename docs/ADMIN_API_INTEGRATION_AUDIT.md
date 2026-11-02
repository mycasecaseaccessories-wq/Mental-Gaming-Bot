# Mental Gaming Store API — Admin Integration Audit

Audit baseline: source-level review of the GitHub repositories and supplied archives, with preview deployment and CI checks through 2026-11-02. This is not a production runtime, live MongoDB data, or payment-flow verification.

## Repository layout

- `artifacts/bot`: Telegram bot (Telegraf, MongoDB)
- `artifacts/api-server`: Express API, authentication middleware, routes and MongoDB access
- `artifacts/landing`: customer storefront
- The Storefront and API source live in this monorepo; the separate Vercel projects do not imply separate source repositories.

## Data ownership

MongoDB remains authoritative for customer records, wallet balances/units, deposits/top-ups, orders, transactions, product/catalog data, payment methods and bot operational records.

The separate Supabase project `mental-gaming-admin` is reserved for admin-side staff profiles, roles, permissions, activity logs, settings, notifications and announcements. It must not become a second source of truth for MongoDB business entities.

Do not dual-write financial/order entities or move customer wallet/order data to Supabase. Do not touch the separate MY CASE Supabase project.

## Integration route map

### Admin A → Store API HMAC portal

Admin A currently uses a server-side HMAC proxy for product/catalog/media operations. The Store API portal allowlist covers:

- `GET /api/store/admin-portal/products` (limited query keys: `page`, `search`, `catalogId`)
- `POST /api/store/admin-portal/products`
- `PATCH /api/store/admin-portal/products/:id`
- `GET /api/store/admin-portal/catalogs`
- `PATCH /api/store/admin-portal/catalogs/:id`
- `POST /api/store/admin-portal/media`

The HMAC payload binds method, original URL, timestamp, nonce, normalized admin email and a SHA-256 hash of the JSON request body. The allowlist rejects unsupported methods, routes and query parameters.

### Customer storefront → Store API

- Customer login uses Telegram Login Widget / Telegram WebApp init-data validation.
- The storefront calls the API using `VITE_API_URL` and Telegram authentication headers.
- Customer-facing features include shop/catalog, product detail, checkout/orders, wallet/top-up, profile/settings, address book, FAQ, reviews, referrals/rewards, check-in, spin wheel, support and notifications.

### Legacy Telegram admin → Store API

Legacy admin endpoints remain in the Store API for summary, orders, top-ups, users, analytics, config, gateways and export. They use Telegram authentication plus the legacy admin check.

The legacy `adminAuth` check uses the configured admin identity / MongoDB admin records; it does not provide the fine-grained permission matrix planned for Admin A. Keep these routes/UI available until Admin A parity and rollback are verified.

## Phase 1 security work

### HMAC replay protection — implemented in draft PR #24

The original process-local nonce Map was unsafe for multi-instance/serverless replay prevention. The updated implementation:

- Stores nonce claims in MongoDB collection `admin_portal_nonces`.
- Uses MongoDB's unique `_id` index with an atomic insert, keyed by normalized email plus nonce.
- Allows a nonce to be reclaimed only after its prior `expiresAt` has passed, using a conditional atomic replacement.
- Rejects replay attempts with HTTP 409.
- Fails closed with HTTP 503 if durable nonce storage is unavailable.
- Uses a 120-second nonce record lifetime and a 60-second request timestamp skew window.
- Caches the in-flight MongoDB connection promise so simultaneous cold-start requests share one connection attempt.

Four API unit tests cover concurrent duplicate claims, unexpired replay rejection, expired nonce reuse and database-unavailable failure. The tests use a deterministic in-memory fake collection; they do not replace a live MongoDB multi-instance integration test.

### Production dependency security — included in draft PR #24

The previous production audit reported 32 findings (1 critical, 16 high, 14 moderate, 1 low). The dependency branch upgrades the affected Axios, Multer, Zod and transitive packages including `proxy-addr`, `body-parser`, `follow-redirects`, `qs` and `ip-address`.

The isolated production audit now reports `No known vulnerabilities found`. GitHub CI and the API test suite are being rechecked on the consolidated branch before the draft PR is considered ready.

## Findings still requiring implementation or verification

1. **Admin A feature parity:** Orders, users, wallets, transactions, top-up review, analytics, payment gateways, staff, roles/permissions and audit-log UI are not yet integrated into Admin A.
2. **RBAC:** The Supabase private schema has the admin-side foundation, but Admin A's current Email/Password session is not yet mapped to server-side staff profiles/roles/permissions. Do not trust client-supplied role claims.
3. **Financial consistency:** Legacy top-up approval writes multiple MongoDB records and must be reviewed for transactionality/idempotency before exposing it to Admin A. Legacy balance adjustment updates the user record separately from the transaction record; reconcile failure cases before reuse.
4. **Analytics semantics:** Existing profit/COGS calculations are estimates based on product profit fields, not audited accounting. Label them as estimates if surfaced.
5. **Multipart integrity:** The HMAC body digest currently covers the parsed JSON body. Review file-byte integrity for the media upload route before expanding its use or exposing it to additional callers.
6. **Secrets:** Vercel metadata shows the expected secret variable names, but the sensitive `MG_PRODUCT_API_SECRET` values could not be compared. Do not assume they match across Admin A, Storefront and API projects.
7. **Vercel API build:** The API project's preview build logs emit `skip-api-build`; a READY deployment therefore does not prove that the API bundle was built or executed by Vercel. The serverless bundle command was separately run successfully in an isolated sandbox. The Vercel API build/ignore configuration and a safe runtime smoke test remain open.
8. **Live business flows:** No live MongoDB customer/wallet/order records were read or mutated for this audit. Payment submission → manual review → wallet credit/order completion and Telegram notification delivery still need a controlled test environment.

## Phase gates

### Gate A — Audit and security baseline

- [x] Map customer, legacy-admin and Admin A HMAC integration surfaces at source level.
- [x] Document MongoDB/Supabase data ownership and no-dual-write rule.
- [x] Replace process-local HMAC nonce replay tracking with durable atomic storage in draft PR #24.
- [x] Add deterministic nonce-claim unit tests.
- [x] Clear the production dependency audit on the security branch.
- [ ] Verify GitHub CI after the API test step is added.
- [ ] Verify Vercel API build configuration and run a non-production runtime smoke test.
- [ ] Run isolated MongoDB multi-instance replay tests.

### Gate B — Admin integration

- Add read-only orders/users/wallet/transaction endpoints with pagination and least-data responses.
- Connect Admin A staff identity to the Supabase role/permission model while preserving Email + Password login.
- Add role-gated payment review only after atomicity, idempotency, audit logging and contract tests are proven.

### Gate C — Bot integration

- Customer order/payment notifications.
- Admin pending-review notifications.
- Verified payment → exactly-once unit credit.
- Order state updates and retry/dead-letter behavior.

### Gate D — Production

- Security/API/mobile/payment regression tests.
- Vercel build/deployment/domain/environment-name verification.
- Controlled smoke test, backup confirmation and rollback plan.

## Safety constraints

- Never commit `.env`, bot tokens, MongoDB URIs, HMAC secrets or customer/payment data.
- Never mutate production balances, orders or catalog as part of this audit.
- Never disable existing admin paths until Admin A parity and rollback are verified.
- No production deployment, production environment-secret changes or financial-data migration from this audit branch.
