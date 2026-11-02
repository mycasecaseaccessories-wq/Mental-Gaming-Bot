import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { after, before, test } from "node:test";
import {
  ADMIN_PORTAL_NONCE_LIFETIME_MS,
  claimAdminPortalNonce,
} from "./adminPortalNonceStore.ts";

const uri = process.env.MONGODB_TEST_URI;
if (!uri) throw new Error("MONGODB_TEST_URI is required for API integration tests");

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
const db = client.db(`mg_nonce_ci_${process.pid}`);
const collection = db.collection("admin_portal_nonces");

before(async () => {
  await client.connect();
});

after(async () => {
  await db.dropDatabase();
  await client.close();
});

test("MongoDB unique _id index allows exactly one concurrent nonce claim", async () => {
  await collection.deleteMany({});
  const key = "ci-admin@example.com:concurrent-nonce-123456";
  const now = Date.now();

  const results = await Promise.all(
    Array.from({ length: 24 }, () => claimAdminPortalNonce(collection, key, now)),
  );

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((claimed) => !claimed).length, 23);
});

test("MongoDB atomically allows an expired nonce to be reclaimed only once", async () => {
  await collection.deleteMany({});
  const key = "ci-admin@example.com:expired-nonce-123456";
  const now = Date.now();

  assert.equal(await claimAdminPortalNonce(collection, key, now), true);
  assert.equal(
    await claimAdminPortalNonce(
      collection,
      key,
      now + ADMIN_PORTAL_NONCE_LIFETIME_MS - 1,
    ),
    false,
  );

  const expiry = now + ADMIN_PORTAL_NONCE_LIFETIME_MS;
  const replacements = await Promise.all([
    claimAdminPortalNonce(collection, key, expiry),
    claimAdminPortalNonce(collection, key, expiry),
  ]);

  assert.equal(replacements.filter(Boolean).length, 1);
  const stored = await collection.findOne({ _id: key });
  assert.equal(
    stored?.expiresAt.getTime(),
    expiry + ADMIN_PORTAL_NONCE_LIFETIME_MS,
  );
});
