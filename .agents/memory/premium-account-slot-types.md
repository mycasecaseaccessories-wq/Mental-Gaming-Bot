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
- Any money-moving path after a wallet debit must be able to fully roll back. For multi purchases: debit → `claimSlots` → `AccountSlot.create` → deliver. If `create` fails, call `AccountCredential.releaseSlots(credId, qty)` (compensating decrement) + refund + abort BEFORE delivering. Never leave a charged buyer with an untracked credential.
- Anything that consumes an `AccountProduct` must be type-aware or explicitly restrict to single. The Free Giveaway (`accountGiveaway.js`) only supports single (delivers one login/pw via `claimOne`); its product pickers filter `{ accountType: { $nin: ['shared','invite'] } }` — that `$nin` form also matches legacy docs missing the field, unlike `{ accountType: 'single' }`.
- Expiry reminders (`CronService.notifyExpiringAccounts`) must scan BOTH `AccountCredential` (single) and `AccountSlot` (multi); each has its own `notified3d`/`notifiedExpired` flags.
