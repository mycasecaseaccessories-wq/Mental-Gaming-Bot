---
name: Mongo atomic counter pattern for bot rewards
description: How to make reward/quota accounting concurrency-safe in this Mongoose bot
---
Reward/quota systems (campaigns, claims) must never use read-modify-save on counters.
**Why:** parallel top-up approvals raced and could double-pay rewards / overshoot quotas (caught in architect review).
**How to apply:** use conditional `findOneAndUpdate` + `$inc` (filter enforces the limit, e.g. `{totalRewardsClaimed: {$lt: limit}}`); roll back with a compensating `$inc` if a later step fails; enforce singletons with partial unique indexes (e.g. one active campaign via unique index on `{isActive:1}` with `partialFilterExpression`). One-shot claims: create the unique claim record BEFORE crediting.
