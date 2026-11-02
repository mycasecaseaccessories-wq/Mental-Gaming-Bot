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

## Financial write-path audit — do not expose these actions in Admin A yet

The legacy Telegram admin handlers are useful as a source of current behavior, but their multi-document write paths are not yet safe to reuse as Admin A financial APIs.

- **Top-up approval** (`PATCH /store/admin/topups/:id/approve`): reads the pending transaction and user, computes new balances from the read snapshot, marks the transaction Completed, then separately writes the user's KS/Coin balances and tier. A failure between the two writes can leave a completed top-up without credited balance. Two different pending top-ups for the same user can also read the same old balance and overwrite each other's calculated `$set` values. The duplicate-`txId` check only addresses repeat approval of the same top-up; it does not make the transaction + wallet update atomic.
- **Balance adjustment** (`PATCH /store/admin/users/:id` with `action=adjustBalance`): the user balance change uses an atomic `findOneAndUpdate($inc)` with a sufficient-balance guard, but the transaction ledger entry is inserted afterward. If that insert fails, the wallet changes without a corresponding ledger entry. Use a MongoDB transaction or a durable outbox/idempotency design before exposing this action in Admin A.
- **Order status change** (`PATCH /store/admin/orders/:id`): writes the new order status before attempting stock restoration. A stock update failure can leave order status and stock inconsistent. The `Refunded` status branch in this handler does not itself create a refund transaction or credit the user's wallet; do not treat this status change as a completed financial refund.
- **Audit logging**: the legacy `writeAudit` helper catches and logs failures instead of failing the underlying user action. It is best-effort logging, not a guaranteed financial audit trail.
- **Warning counters**: user warning actions calculate a new count from a prior read and then set it; concurrent actions can overwrite each other. Use atomic increments/conditional updates if these actions are migrated.

Required before Admin A exposes any financial write:
1. MongoDB transaction or equivalent atomic/idempotent design covering the transaction record, wallet/order state and audit record.
2. Unique idempotency key and conditional state transition so retries/concurrent requests cannot double-credit or lose updates.
3. Contract tests for success, duplicate retry, concurrent requests, mid-write failure and insufficient balance.
4. Explicit refund semantics (wallet credit, ledger entry, stock handling and notification) separated from a plain order status edit.

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

Four API unit tests cover concurrent duplicate claims, unexpired replay rejection, expired nonce reuse and database-unavailable failure. Two additional MongoDB integration tests use two independent MongoClient connections against an isolated MongoDB 7 service to verify cross-client concurrent claims and atomic expired-nonce reuse. GitHub Actions run #142 passed both integration tests.

### Admin A Preview isolation — implemented in draft PR #1

The Admin A product proxy previously used a hard-coded production Storefront origin, including in Preview deployments. Draft PR #1 adds `MG_PRODUCT_API_ORIGIN` and changes the default behavior:

- Production uses the existing Storefront origin only when `VERCEL_ENV=production`.
- Preview/local environments require an explicit `MG_PRODUCT_API_ORIGIN`.
- The configured value must be an HTTPS origin only (no credentials, path, query or fragment).
- If it is missing or invalid, the proxy returns HTTP 503 and does not call the upstream API.
- Six new tests cover production default, Preview isolation, explicit origin, insecure URL rejection, local fail-closed behavior and the actual 503/no-upstream-call path.

No Vercel environment variable was changed. Configure the Preview-only origin and verify the Preview HMAC secret before attempting Admin A product/catalog operations.

### Production dependency security — included in draft PR #24

The previous production audit reported 32 findings (1 critical, 16 high, 14 moderate, 1 low). The dependency branch upgrades the affected Axios, Multer, Zod and transitive packages including `proxy-addr`, `body-parser`, `follow-redirects`, `qs` and `ip-address`.

The isolated production audit now reports `No known vulnerabilities found`. GitHub Actions run #142 on the consolidated security branch passed frozen-lockfile install, formatting, TypeScript checks, bot tests, API nonce unit tests (4/4), MongoDB integration tests (2/2), full workspace build, Vercel serverless bundle build, production-mode health smoke test and production dependency audit.

## Admin A feature-parity matrix

| Admin capability | Current Admin A status | Existing Store API/source |
|---|---|---|
| Login/session | Implemented with custom Email + Password, signed session cookie and CSRF | Admin A `server/adminAuth.ts`; keep this login method |
| Dashboard | UI exists but live order/user/wallet metrics are placeholders | Legacy `GET /store/admin/summary`; not connected to Admin A |
| Products | Connected through HMAC service proxy | `/store/admin-portal/products` |
| Catalogs/subcatalogs/images | Connected through HMAC service proxy | `/store/admin-portal/catalogs`, `/store/admin-portal/media` |
| Orders | Not connected to Admin A | Legacy `GET/PATCH /store/admin/orders` |
| Users/customer profiles | Not connected to Admin A | Legacy `GET /store/admin/users`, user detail and action routes |
| Wallet KS/Coin | Not connected to Admin A | MongoDB user balance fields; legacy balance-adjust action |
| Top-up/deposit review | Not connected to Admin A | Legacy `GET/PATCH /store/admin/topups` approve/reject actions |
| Transactions | No Admin A transaction history/ledger view | MongoDB `transactions` collection; used by legacy top-up flows |
| Analytics | Not connected to Admin A | Legacy `GET /store/admin/analytics`; estimated profit/COGS only |
| Payment methods/gateways | Not connected to Admin A | Legacy config/gateway endpoints |
| Staff, roles, permissions, audit | Supabase private schema foundation only; no Admin A UI/API enforcement yet | Separate `mental-gaming-admin` Supabase project |

Admin A is the only planned main web admin. The legacy Telegram admin routes remain available during parity work; do not disable them until the equivalent Admin A workflows, tests and rollback are verified.

## Findings still requiring implementation or verification

1. **Admin A feature parity:** Orders, users, wallets, transactions, top-up review, analytics, payment gateways, staff, roles/permissions and audit-log UI are not yet integrated into Admin A.
2. **RBAC:** The Supabase private schema has the admin-side foundation, but Admin A's current Email/Password session is not yet mapped to server-side staff profiles/roles/permissions. Do not trust client-supplied role claims.
3. **Financial consistency:** The source-level write-path audit is documented above. Legacy top-up approval, balance adjustment and order/refund flows still need transactionality/idempotency changes and contract tests before exposing financial writes in Admin A.
4. **Analytics semantics:** Existing profit/COGS calculations are estimates based on product profit fields, not audited accounting. Label them as estimates if surfaced.
5. **Media upload validation:** The media route accepts base64 WebP inside the JSON body, so the HMAC body digest covers the uploaded bytes' encoded representation. The handler also checks canonical base64, the size limit and WebP signature before writing to GridFS. Preserve these checks and add route-level tests before expanding media access.
6. **Secrets:** Vercel metadata shows the expected secret variable names, but the sensitive `MG_PRODUCT_API_SECRET` values could not be compared. Do not assume they match across Admin A, Storefront and API projects.
7. **Vercel API build:** The API project's preview build logs emit `skip-api-build`; a READY deployment therefore does not prove that the API bundle was built or executed by that Vercel project. GitHub CI run #142 successfully compiled the serverless bundle and ran its production-mode `/api/healthz` route. The Vercel API project's build/ignore configuration and a protected-preview runtime smoke test remain open.
8. **Live business flows:** No live MongoDB customer/wallet/order records were read or mutated for this audit. Payment submission → manual review → wallet credit/order completion and Telegram notification delivery still need a controlled test environment.

## Phase gates

### Gate A — Audit and security baseline

- [x] Map customer, legacy-admin and Admin A HMAC integration surfaces at source level.
- [x] Document MongoDB/Supabase data ownership and the no-dual-write rule.
- [x] Replace process-local HMAC nonce replay tracking with durable atomic MongoDB storage in draft PR #24.
- [x] Add four deterministic nonce-claim unit tests.
- [x] Add two MongoDB cross-client integration tests using two independent MongoClient connections (run #142 passed).
- [x] Clear the production dependency audit (run #142: no known vulnerabilities).
- [x] Verify GitHub CI, full workspace build and Vercel serverless bundle health smoke test (run #142 passed).
- [x] Complete the source-level financial write-path risk audit and document required atomicity/idempotency controls.
- [x] Add Admin A Preview origin isolation and HTTPS-only validation in draft PR #1.
- [ ] Verify the Vercel API project's build/ignore configuration and run a protected-preview runtime smoke test.

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
