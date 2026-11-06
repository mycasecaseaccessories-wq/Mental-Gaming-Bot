# Multi-Category Telegram Shop — Implementation Plan

## Phase 0 — Repository and production safety
- [x] Inspect existing Mental Gaming bot and admin repositories.
- [x] Create isolated feature branch `feature/multi-category-ecommerce`.
- [ ] Map existing product/category/order collections and current Telegram handlers.
- [ ] Confirm staging database and Vercel deployment target.
- [ ] Add feature flag; do not change live customer behavior by default.

## Phase 1 — Catalog foundation
- [ ] Define category and product type enums.
- [ ] Add product fulfillment mode and required customer fields.
- [ ] Preserve compatibility with existing gaming products and catalog API.
- [ ] Add category browsing, product details, variants and server-side search.
- [ ] Add availability and stock validation.

## Phase 2 — Cart and checkout
- [ ] Implement Telegram cart and quantity controls.
- [ ] Recalculate totals server-side at checkout.
- [ ] Collect category-specific details using a finite-state conversation.
- [ ] Create order number and immutable price snapshots.
- [ ] Add checkout timeout and cart expiry.

## Phase 3 — Payment review
- [ ] Configure KPay, WavePay and bank transfer instructions in admin.
- [ ] Accept payment reference and proof image.
- [ ] Add admin approve/reject queue.
- [ ] Separate proof submission from payment verification.
- [ ] Notify customer on each state change.

## Phase 4 — Fulfillment
- [ ] Manual admin fulfillment for all product types.
- [ ] Digital inventory reservation and secure delivery.
- [ ] Physical packing/shipping/tracking workflow.
- [ ] Automatic provider adapter interface with idempotency.
- [ ] Hybrid routing, retry limits and exception queue.

## Phase 5 — Admin dashboard
- [ ] Orders overview and filters.
- [ ] Order details, customer inputs and event timeline.
- [ ] Payment proof review.
- [ ] Fulfillment queue and assignment.
- [ ] Inventory and shipment management.
- [ ] Sales summaries and exports.

## Phase 6 — QA and release
- [ ] Unit tests for pricing, stock, status transitions and idempotency.
- [ ] Integration tests for Telegram updates and store API.
- [ ] Security tests for customer/order ownership and admin roles.
- [ ] Test duplicate Telegram updates, payment submissions and provider timeouts.
- [ ] Restore test from database backup.
- [ ] Pilot with manual fulfillment and a limited catalog.
- [ ] Enable production feature flag gradually; document rollback.

## Current status
Architecture, logical data model and staged implementation plan have been drafted on the feature branch. No production database, Telegram bot token, payment account, Vercel environment variable or live deployment has been changed.

## Inputs needed before live integration
- Telegram bot username/token confirmation (never paste the token into chat; configure it in hosting secrets).
- Which existing Vercel project should host the bot webhook/API, or confirmation to use the existing bot deployment.
- Payment account display names, account numbers and QR images to be entered privately in Admin.
- Physical delivery fee rules and service areas.
- Authorized game top-up/provider API details for any automatic game fulfillment.
