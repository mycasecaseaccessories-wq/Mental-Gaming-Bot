/**
 * MongoDB native driver client for the API server.
 *
 * Used exclusively for writing WebhookEvent documents — the bot (Mongoose)
 * owns the full schema; the API server only needs raw insert + minimal reads.
 *
 * Connection is lazy-initialized on first use and reused across requests.
 */

import { MongoClient, type Db, type Collection } from "mongodb";
import { logger } from "./logger";

let _client: MongoClient | null = null;
let _db: Db | null = null;

function getMongoUri(): string {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI environment variable is required");
  return uri;
}

export async function getDb(): Promise<Db> {
  if (_db) return _db;

  _client = new MongoClient(getMongoUri(), {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await _client.connect();
  _db = _client.db(); // uses the DB name from the URI
  logger.info("MongoDB native client connected (API server)");
  return _db;
}

export async function getClient(): Promise<MongoClient> {
  if (!_client) await getDb();
  return _client as MongoClient;
}

export async function getCollection<T extends object>(
  name: string
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}
