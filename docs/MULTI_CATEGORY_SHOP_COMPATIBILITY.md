# Existing Mental Gaming Bot — Compatibility Assessment

Reviewed on 2026-11-06 against the current `main` branch.

## Existing building blocks confirmed
- Node.js / Telegraf Telegram bot in `artifacts/bot`.
- MongoDB / Mongoose models.
- Hierarchical `Catalog` model and catalog admin command.
- `Product` model already has category, catalogId, checkout field overrides, stock count, price, warranty, waiting time, `deliveryMode: Manual | Auto`, provider slug and provider SKU.
- `Order` model already supports a single product order, quantity, price snapshots, dynamic checkoutData, payment source, inventory reservation and status history.
- `PaymentMethod` model already supports account name/number, instructions and QR image.
- Existing customer commands include shop, orders, wallet and top-up.
- Existing staff/admin commands include pending orders, product delivery mode, provider configuration, payment methods and catalog management.
- Existing store mini-app and API are part of the same monorepo; separate admin website exists.

## Main compatibility gap for a general multi-category shop
1. `Product.productType` currently only allows `DirectTopup` and `DigitalCode`. Physical products need a backward-compatible extension or a distinct product classification field.
2. `Order` currently models one product per order. A multi-item cart needs an `items[]` snapshot while retaining legacy `productId`, `amount` and `productType` fields for old order readers.
3. Product `deliveryMode` currently expresses Manual/Auto. Hybrid should be implemented as a routing policy, not by treating a third enum as an existing provider behavior.
4. Physical delivery requires address, shipping fee, shipment status and tracking fields; these are not represented in the reviewed Order schema.
5. Payment proof submission and admin verification should be audited separately. Existing wallet/payment features must be reviewed before reusing their logic for external transfers.

## Safe implementation direction
- Keep the existing gaming catalog and checkout behavior working.
- Add optional fields and new collections only after checking all readers/writers and existing indexes.
- Prefer a new cart/order service that creates backward-compatible orders, or version the order shape explicitly.
- Introduce physical product and shipping behavior behind a feature flag.
- Reuse provider integrations only after confirming their product coverage and idempotency guarantees.
- Do not migrate or rewrite existing customer orders.
- Do not put payment credentials, bot tokens or provider secrets in Git or customer-visible messages.

## Not yet verified
- Live database collection contents and production indexes.
- Exact payment proof and wallet debit transaction flow.
- Provider-specific support for all intended game top-ups.
- Existing admin website support for order review/fulfillment (the reviewed README documents catalog/product management; it does not establish these order screens).
- Telegram bot token, webhook/polling hosting configuration and staging credentials.
