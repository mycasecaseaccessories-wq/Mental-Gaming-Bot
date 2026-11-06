# Multi-Category Shop — Proposed Data Model

This is a logical MongoDB model proposal. It is not a production migration. Confirm current collections and existing schemas before implementation.

## categories
```js
{
  _id,
  name,
  slug,
  parentId: null | ObjectId,
  description,
  imageUrl,
  sortOrder: Number,
  isActive: Boolean,
  createdAt,
  updatedAt
}
```

## products
```js
{
  _id,
  categoryId,
  name,
  slug,
  description,
  images: [String],
  productType: "gaming_topup" | "digital" | "physical",
  fulfillmentMode: "automatic" | "manual" | "hybrid",
  priceMMK: Number,
  compareAtPriceMMK: Number | null,
  variants: [{
    sku, label, priceMMK, stockMode: "unlimited" | "tracked" | "preorder",
    stockQty: Number | null, isActive: Boolean
  }],
  requiredCustomerFields: ["game_uid", "server", "recipient_phone", "delivery_address"],
  deliveryInstructions,
  estimatedFulfillmentMinutes: Number | null,
  isActive: Boolean,
  createdAt,
  updatedAt
}
```

## carts
One active cart per Telegram customer, with server-validated product/variant references and quantities. Recalculate totals from current product prices before checkout.

## orders
```js
{
  _id,
  orderNo,                 // unique, human-readable
  customerId,
  telegramUserId,
  items: [{
    productId, variantSku, productNameSnapshot,
    unitPriceMMK, quantity, lineTotalMMK,
    fulfillmentModeSnapshot, customerInputs
  }],
  subtotalMMK,
  deliveryFeeMMK,
  discountMMK,
  totalMMK,
  currency: "MMK",
  status,
  paymentStatus,
  paymentMethodId,
  deliveryAddressSnapshot: null | Object,
  createdAt,
  updatedAt,
  paidAt: null | Date,
  fulfilledAt: null | Date
}
```

## payments
```js
{
  _id,
  orderId,
  method: "kpay" | "wavepay" | "bank_transfer" | "other",
  amountMMK,
  referenceText: String | null,
  proofMediaId: String | null,
  status: "submitted" | "verified" | "rejected" | "refunded",
  reviewedBy: String | null,
  reviewedAt: Date | null,
  rejectionReason: String | null,
  createdAt,
  updatedAt
}
```

## fulfillment_jobs
```js
{
  _id,
  orderId,
  orderItemIndex,
  mode: "automatic" | "manual",
  provider: String | null,
  idempotencyKey,           // unique
  status: "queued" | "processing" | "completed" | "failed" | "needs_review",
  attempts: Number,
  providerReference: String | null,
  resultSummary: String | null, // sanitized; no secrets
  assignedAdminId: String | null,
  completedAt: Date | null,
  createdAt,
  updatedAt
}
```

## digital_inventory
For one-time codes/licenses only. Encrypt secrets at rest or use a secure secret store. Never return raw inventory through public catalog APIs.
```js
{
  _id,
  productId,
  variantSku,
  encryptedPayload,
  status: "available" | "reserved" | "delivered" | "void",
  reservedOrderId: ObjectId | null,
  deliveredAt: Date | null,
  createdAt
}
```

## order_events
Append-only audit history:
```js
{
  _id,
  orderId,
  actorType: "customer" | "admin" | "system" | "provider",
  actorId,
  eventType,
  fromStatus: String | null,
  toStatus: String | null,
  note: String | null,
  metadata: Object, // sanitized; never store credentials or payment secrets
  createdAt
}
```

## Required indexes
- categories: unique `slug`; `parentId + sortOrder`
- products: `categoryId + isActive`; unique sparse `slug`; unique sparse variant SKU if globally unique
- carts: unique `customerId`
- orders: unique `orderNo`; `telegramUserId + createdAt`; `status + createdAt`
- payments: `orderId + createdAt`
- fulfillment_jobs: unique `idempotencyKey`; `status + createdAt`; `orderId`
- digital_inventory: `productId + variantSku + status`
- order_events: `orderId + createdAt`

## Integrity rules
- Store integer MMK amounts; reject negative, fractional or unsafe numeric values.
- Store price snapshots in order items so later catalog price changes do not alter past orders.
- Use atomic stock reservation/decrement and release reservations on expiry/cancellation.
- Enforce one verified payment per order unless partial/multiple payments are explicitly supported.
- Never trust a Telegram callback's displayed price or total.
- Make order creation and fulfillment idempotent.
- Validate all status transitions in service functions, not in the UI.
