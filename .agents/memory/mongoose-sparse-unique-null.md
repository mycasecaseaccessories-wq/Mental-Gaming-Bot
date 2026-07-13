---
name: Mongoose sparse-unique index + default:null trap
description: Why new-document creation silently fails with E11000 when a unique+sparse index meets a field whose schema default is null
---

# Sparse unique index + `default: null` silently blocks all new inserts

**Symptom:** brand-new records stop being saved to a collection. In the bot this looked like: new Telegram users never appear in the admin bot, aren't counted, and any callback button shows "❌ /start အရင်နှိပ်ပါ" (findByTelegramId returns null) — even right after they pressed /start. The welcome panel still renders because it uses `ctx.user?.` fallbacks, and onboarding is skipped because `ctx.user` is undefined.

**Root cause:** A `unique + sparse` index does NOT skip documents whose field is explicitly `null` — sparse only skips documents where the field is *absent*. When the schema declares the field with `default: null` (e.g. `referralCode: { type: String, default: null }`), Mongoose writes an explicit `null` on every new doc. The first such doc occupies the single allowed null slot; every subsequent `create` fails with duplicate-key `E11000`. In `findOrCreate`, the E11000 branch then does `findOne({telegramId})` which returns null (doc never persisted) → returns null → caller drops the user.

**Fix:** Use a PARTIAL unique index that only indexes real values, not nulls:
```js
schema.index({ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } });
```
Then reconcile the live index (the same pattern already used for `AccountGiveaway` in `database.js`): `await Model.syncIndexes();` after connect drops the stale sparse index and builds the partial one. Because dev and the prod VPS bot share the same MongoDB Atlas cluster, fixing the index once repairs both.

**Why:** partial `$type: 'string'` filter never indexes null/missing, so uniqueness applies only to actual codes; `default: null` becomes harmless.

**How to apply:** any time you see a `unique + sparse` index on a field that also has `default: null` (or is otherwise written as explicit null), it's a latent single-insert trap — convert to a partial index. `syncIndexes()` is collection-wide and drops indexes not declared in the schema, so make sure every intended index is declared before calling it.

**Diagnosing:** connect read-only and compare `countDocuments({field: null})` (matches null AND missing) vs `countDocuments({field: {$exists:false}})` (missing only); the difference is the count of explicit-null docs holding the slot.
