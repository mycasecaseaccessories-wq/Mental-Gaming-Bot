---
name: Bot promo claims & discount revalidation
description: Safe patterns for one-time bonuses and session-cached discounts in the Telegram bot
---
**Rule 1:** For once-per-period bonuses (birthday, win-back), claim the marker field atomically via conditional findOneAndUpdate FIRST (prevents double-credit), but if the subsequent creditCoin fails, roll the claim back so a later run retries. Message-send failure after credit is non-fatal — keep the claim.
**Why:** Claim-first alone silently drops gifts on transient DB errors; credit-first double-pays on concurrent runs.
**Rule 2:** Any discount computed at scene start and cached in session (e.g. first-order discount) must be revalidated right before createOrder — users can open parallel checkout flows.
**Rule 3:** Limited-use codes (maxUses / per-user limit) must be consumed via a single conditional findOneAndUpdate (`currentUses < maxUses` + `$expr` count of `usedBy` entries < perUserLimit), and consumed BEFORE granting the benefit so a race strips the discount instead of silently granting it. Never validate-then-save separately.
**How to apply:** Any new promo mechanic in artifacts/bot that credits MC once per period, bakes discounts into session prices, or caps code usage.
