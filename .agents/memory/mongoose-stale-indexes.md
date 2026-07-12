---
name: Mongoose stale indexes
description: Changing a schema's index options does NOT drop the old index in MongoDB — you must drop it manually.
---

# Mongoose does not replace indexes when you change their options

When you change an index definition in a Mongoose schema (e.g. remove a
`unique`/`partialFilterExpression`, or change its keys), Mongoose's `autoIndex`
will **not** drop the pre-existing index in the live database. The old index
keeps enforcing its old constraints, and Mongoose only logs a conflict rather
than fixing it.

**Why:** dropping indexes can be destructive/expensive, so Mongoose refuses to
do it automatically. `syncIndexes()` would drop extras, but it is not called on
normal model init and can be risky on large collections.

**How to apply:** whenever you relax or change a unique/partial index that
already exists in production data, run a one-off migration against the live DB:
`collection.dropIndex('<name>')` then `collection.createIndex(<new spec>)`.
Verify with `collection.indexes()` before and after. Check for data that would
violate a *new* unique index (count duplicates) before creating it, or the build
fails.

Concrete case: the free-giveaway feature switched from "one active giveaway"
(partial-unique index on `isActive:true`) to "many active, one per product"
(unique index on `productId`). Simply editing the schema left the old
partial-unique `isActive_1` index live in Atlas, still blocking a second active
giveaway. Had to drop `isActive_1` and recreate it non-unique.
