# Multi-Category Telegram Shop — System Architecture

## Product decision
Build on the existing Mental Gaming Store monorepo and Telegram bot. Do not replace the existing bot, storefront, API, MongoDB deployment, or production catalog. All work starts on `feature/multi-category-ecommerce`.

## Scope
One Telegram shop supports three top-level categories:
- Gaming top-ups and game currencies
- Digital products and subscriptions
- Physical products and accessories

Each product has an explicit fulfillment mode:
- `automatic`: fulfilled by a verified provider integration or a controlled stock/delivery workflow
- `manual`: admin reviews payment and fulfills the order
- `hybrid`: automation is attempted when eligible; exceptions are routed to admins

The shop currency is MMK (Ks). Product price, stock, and availability are always read from the server, never trusted from Telegram callback data.

## Existing platform reuse
- Telegram interface: existing Node.js + Telegraf bot under `artifacts/bot`
- Data: existing MongoDB store database and API; use additive collections/fields only after compatibility review
- Admin: existing separate `mental-gaming-admin` website; add order/payment/fulfillment screens there
- Hosting: existing Vercel projects where suitable; bot runtime must use a deployment mode compatible with persistent Telegram updates (webhook or supported worker), not assume a short-lived function can run polling forever
- Existing catalog/storefront remains operational throughout rollout

## Logical architecture
```text
Telegram Customer
      |
      v
Telegraf Bot  -----> Store API -----> MongoDB
      |                  |              |
      |                  |              +-- categories / products
      |                  |              +-- carts / orders / payments
      |                  |              +-- fulfillment jobs / stock
      |                  |
      |                  +----> Payment & provider adapters
      |
      +-----> Admin notifications

Admin Web Dashboard
      |
      v
Protected Admin API -----> Store API -----> MongoDB
      |
      +----> payment review / order status / delivery / inventory
```

## Customer journey
1. `/start`: language/welcome and shop menu.
2. Browse category → subcategory → product.
3. View product details, price, availability, delivery method and estimated processing time.
4. Select variant/quantity and add to cart.
5. Checkout collects only necessary details:
   - Gaming: game/player ID, server/region and selected denomination
   - Digital: recipient email/account details only when required; never request passwords or OTPs
   - Physical: recipient name, phone, township/city, full delivery address and delivery preference
6. Server creates a pending order with a price snapshot and unique order number.
7. Customer selects a configured payment method and receives payment instructions.
8. Customer uploads payment proof or uses a supported verified payment integration.
9. Payment is marked `submitted`; admin or trusted payment adapter verifies it.
10. On verified payment, order moves to `paid` and the fulfillment policy runs.
11. Customer receives progress and completion messages; physical orders also receive shipment/tracking details.

## Order and payment states
Order states:
`pending_payment` → `payment_submitted` → `paid` → `processing` → `partially_fulfilled` / `fulfilled`
Exception/terminal states: `payment_rejected`, `cancelled`, `refunded`, `fulfillment_failed`.

Payment states:
`unpaid`, `submitted`, `verified`, `rejected`, `refunded`.

Every transition is validated server-side and recorded in an immutable order event/audit trail. A screenshot is evidence, not proof of payment. Never auto-mark a payment verified solely because an image was uploaded.

## Fulfillment policies
### Automatic
- Only enable after a provider API or secure inventory source is integrated and tested.
- Use idempotency keys so retries cannot deliver twice.
- Record provider request/response identifiers and sanitized outcomes.
- Never store provider secrets in product descriptions or Telegram messages.

### Manual
- Admin queue shows payment state, customer inputs and product instructions.
- Admin confirms payment separately from marking fulfillment complete.
- Delivery details are sent only to the customer who owns the order.

### Hybrid
- Auto-fulfill only eligible products after verified payment.
- On timeout, provider error, stock mismatch or ambiguous response, pause and route to admin review.
- Do not retry non-idempotent provider actions blindly.

## Admin capabilities
- Category/subcategory management
- Product CRUD, images, variants, price and availability
- Per-product fulfillment mode and required customer fields
- Payment method configuration and payment-proof review
- Order queue, filters, assignment, status changes and audit history
- Digital stock/code inventory with secure reveal-once delivery
- Physical inventory and shipment/tracking fields
- Refund/cancellation records
- Customer lookup and support notes
- Sales summary and CSV export

## Security and reliability
- Keep Telegram bot token, MongoDB URI, provider credentials and admin API secrets server-side only.
- Verify Telegram webhook secret token when using webhook mode.
- Validate callback ownership, order ownership, product status, stock and current price on every write.
- Rate-limit checkout/payment-proof submissions and protect against duplicate updates.
- Store only the minimum personal data needed for delivery.
- Never ask customers for account passwords, OTPs, recovery codes or card PINs.
- Restrict admin operations by role; log sensitive actions.
- Use signed, expiring media links or protected delivery messages for digital goods.
- Back up the database and test restore before production rollout.

## Rollout strategy
1. Feature branch + design/schema review.
2. Additive database models and API tests.
3. Bot browsing/cart/checkout in staging.
4. Admin order and payment review screens.
5. Manual fulfillment pilot with a small catalog.
6. Add automatic fulfillment adapters one provider at a time.
7. Physical shipping workflow.
8. Production rollout behind a feature flag with rollback plan.

## Explicit non-goals for initial release
- No direct payment gateway integration until a provider account/API and verification method are supplied.
- No automatic game top-up claims without a real authorized provider integration.
- No customer password/OTP collection.
- No production database migration or destructive catalog rewrite during the initial design phase.
