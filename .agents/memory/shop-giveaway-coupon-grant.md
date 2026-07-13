---
name: Shop-Product giveaways are coupon grants, not reservations
description: Why the Free Giveaway shop path does not reserve Product stock at claim time
---

Free Giveaway (`commands/accountGiveaway.js`) hands out regular shop `Product`s by minting a
personal 100%-off coupon (`PromoService.generateCoupon`, prefix GIFT) that the user redeems in
`/shop`. It intentionally does NOT decrement/reserve `Product.stockCount` at claim time.

**Why:** the shop order flow (`orderScene.js` → `OrderService.createOrder`) already atomically
decrements `Product.stockCount` at order time. Reserving stock at claim would double-decrement.
This mirrors the pre-existing referral `product_free` reward (`RefCampaignService`), which grants
the same kind of 100%-off shop coupon without reservation. Over-issuance of coupons is bounded by
the giveaway's own `maxClaims` quota (atomic `claimedCount` guard).

**How to apply:** treat shop giveaways as "coupon lottery" semantics — a successful claim means the
user holds a redeemable coupon, not a guaranteed reserved unit. If you ever need hard reservation,
you must also stop the redemption order from decrementing again, or you will double-count.
Account giveaways (single/shared/invite) DO reserve immediately (claimOne/claimSlots).
