import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_PORTAL_NONCE_LIFETIME_MS,
  claimAdminPortalNonce,
} from "./adminPortalNonceStore.ts";

class FakeNonceCollection {
  documents = new Map();

  async insertOne(document) {
    if (this.documents.has(document._id)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    this.documents.set(document._id, { ...document });
    return { acknowledged: true };
  }

  async replaceOne(filter, replacement) {
    const existing = this.documents.get(filter._id);
    if (!existing || existing.expiresAt > filter.expiresAt.$lte) {
      return { modifiedCount: 0 };
    }
    this.documents.set(filter._id, { ...replacement });
    return { modifiedCount: 1 };
  }
}

test("only one concurrent request can claim the same nonce", async () => {
  const collection = new FakeNonceCollection();
  const results = await Promise.all([
    claimAdminPortalNonce(collection, "admin@example.com:nonce-123456789012", 1_000),
    claimAdminPortalNonce(collection, "admin@example.com:nonce-123456789012", 1_000),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((claimed) => !claimed).length, 1);
});

test("an unexpired nonce cannot be reused", async () => {
  const collection = new FakeNonceCollection();
  const key = "admin@example.com:nonce-123456789012";

  assert.equal(await claimAdminPortalNonce(collection, key, 10_000), true);
  assert.equal(
    await claimAdminPortalNonce(collection, key, 10_000 + ADMIN_PORTAL_NONCE_LIFETIME_MS - 1),
    false,
  );
});

test("an expired nonce can be claimed again atomically", async () => {
  const collection = new FakeNonceCollection();
  const key = "admin@example.com:nonce-123456789012";

  assert.equal(await claimAdminPortalNonce(collection, key, 20_000), true);
  assert.equal(
    await claimAdminPortalNonce(collection, key, 20_000 + ADMIN_PORTAL_NONCE_LIFETIME_MS),
    true,
  );
});

test("database errors fail closed instead of granting the nonce", async () => {
  const unavailable = {
    async insertOne() {
      throw new Error("database unavailable");
    },
    async replaceOne() {
      return { modifiedCount: 0 };
    },
  };

  await assert.rejects(
    claimAdminPortalNonce(unavailable, "admin@example.com:nonce-123456789012", 30_000),
    /database unavailable/,
  );
});
