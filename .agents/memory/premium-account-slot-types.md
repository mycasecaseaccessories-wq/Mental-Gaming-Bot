---
name: Premium Account slot types (shared / invite)
description: How the multi-device / invite-link account types differ from classic single accounts, and the invariants that keep money + stock consistent.
---

# Premium Account types (artifacts/bot)

Three `AccountProduct.accountType` values: `single` (classic, one login/pw per buyer), `shared` (one login/pw shared by up to `slotsPerUnit` devices), `invite` (one URL shared by up to `slotsPerUnit` members).

- **Single vs multi are two separate sale ledgers.** Single records the sale on the `AccountCredential` itself (`claimOne`, `countAvailable`). Shared/invite record each buyer's purchase in a separate `AccountSlot` doc, because ONE credential is sold to many buyers (one per device/member seat). `AccountCredential.capacity`/`usedSlots` track the seat count; the cred flips to `sold` only when full.
- **Pricing is PER slot** for shared/invite: total = `finalPrice() × qty`. A buyer always draws all `qty` seats from a SINGLE credential (`claimSlots` is atomic `$expr` + pipeline update). The qty picker is capped at `min(maxFreeInOne, 8, slotsPerUnit)`.

**Why:** the two-ledger split lets a single VPN/family account be resold seat-by-seat without the classic flow ever changing behaviour.

**How to apply:**
- **Claim stock BEFORE debiting**, then debit the price computed from the credential ACTUALLY claimed (`priceForCredential(cred)`). This is the only ordering where the aging/stock-date price shown equals the price charged — peek-then-charge always races (a concurrent buyer can take the peeked credential). On debit failure, release the claim (`releaseOne` / `releaseSlots`), verify the release returned a doc, and alert the owner if it didn't (free-entitlement guard); nothing was charged, so no refund. Only steps AFTER the debit (e.g. `AccountSlot.create`) need a compensating refund, which must use the IMMUTABLE charged amount, never a mutated display price.
- Anything that consumes an `AccountProduct` must be type-aware or explicitly restrict to single. The Free Giveaway (`accountGiveaway.js`) only supports single (delivers one login/pw via `claimOne`); its product pickers filter `{ accountType: { $nin: ['shared','invite'] } }` — that `$nin` form also matches legacy docs missing the field, unlike `{ accountType: 'single' }`.
- Expiry reminders (`CronService.notifyExpiringAccounts`) must scan BOTH `AccountCredential` (single) and `AccountSlot` (multi); each has its own `notified3d`/`notifiedExpired` flags.

## Stock-date expiry & aging price (opt-in per product)

`AccountProduct.stockDateExpiry` makes a credential's fixed lifetime count from the **stock-add date**, not purchase. Two clocks exist and must not be confused:
- `AccountCredential.stockExpiresAt` = when the *unsold stock* dies (set at stock-add: `now + durationDays`). Governs what buyers can still see/buy.
- Buyer expiry (`AccountCredential.expiresAt` for single/giveaway, `AccountSlot.expiresAt` for multi) = when the *sold* access dies. For stock-date products it's set to `stockExpiresAt` (inherit remaining days), NOT `now + durationDays`.

**Why:** pre-paid cards / date-anchored accounts expire on a real-world date regardless of when sold; a late buyer must get only leftover days.

**How to apply:**
- Availability is gated by `freshStock()` (`stockExpiresAt null OR > now`) spread into every claim/count static — expired stock is invisible even before the cron retires it. `retireExpiredStock()` (available→`expired`) runs at the top of `notifyExpiringAccounts`. Status enum is `available|sold|expired`; product delete must purge `available`+`expired`.
- Buyer-facing price must come from `effPrice(p)` (peeks `nextAvailable`, applies `priceForCredential`), never bare `finalPrice()`, or the aging discount silently won't apply. Aging fires when `remaining ≤ agingThresholdDays`; `agingDiscountPercent` 100% = free → skip both debit AND refund (guard `fp>0`/`total>0`).
- Only stock added AFTER enabling gets a `stockExpiresAt`; pre-existing stock stays null (never expires). Tell the admin to re-add stock.
