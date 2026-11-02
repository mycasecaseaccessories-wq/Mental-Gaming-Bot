import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { after, before, test } from "node:test";
import {
  ADMIN_PORTAL_NONCE_LIFETIME_MS,
  claimAdminPortalNonce,
} from "./adminPortalNonceStore.ts";

const uri = process.env.MONGODB_TEST_URI;
if (!uri) throw new Error("MONGODB_TEST_URI is required for API integration tests");

const databaseName = `mg_nonce_ci_${process.pid}`;
const clientA = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
const clientB = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
const dbA = clientA.db(databaseName);
const dbB = clientB.db(databaseName);
const collectionA = dbA.collection("admin_portal_nonces");
const collectionB = dbB.collection("admin_portal_nonces");

before(async () => {
  await Promise.all([clientA.connect(), clientB.connect()]);
});

after(async () => {
  await dbA.dropDatabase();
  await Promise.all([clientA.close(), clientB.close()]);
});

test("separate MongoDB clients admit exactly one concurrent nonce claim", async () => {
  await collectionA.deleteMany({});
  const key = "ci-admin@example.com:concurrent-nonce-123456";
  const now = Date.now();

  const results = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      claimAdminPortalNonce(index % 2 === 0 ? collectionA : collectionB, key, now),
    ),
  );

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((claimed) => !claimed).length, 23);
});

test("separate MongoDB clients atomically allow an expired nonce to be reclaimed only once", async () => {
  await collectionA.deleteMany({});
  const key = "ci-admin@example.com:expired-nonce-123456";
  const now = Date.now();

  assert.equal(await claimAdminPortalNonce(collectionA, key, now), true);
  assert.equal(
    await claimAdminPortalNonce(
      collectionB,
      key,
      now + ADMIN_PORTAL_NONCE_LIFETIME_MS - 1,
    ),
    false,
  );

  const expiry = now + ADMIN_PORTAL_NONCE_LIFETIME_MS;
  const replacements = await Promise.all([
    claimAdminPortalNonce(collectionA, key, expiry),
    claimAdminPortalNonce(collectionB, key, expiry),
  ]);

  assert.equal(replacements.filter(Boolean).length, 1);
  const stored = await collectionA.findOne({ _id: key });
  assert.equal(
    stored?.expiresAt.getTime(),
    expiry + ADMIN_PORTAL_NONCE_LIFETIME_MS,
  );
});
