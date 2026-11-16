/**
 * MongoDB native driver client for the API server.
 *
 * Used for API-side MongoDB operations; the bot (Mongoose) owns the full
 * business schemas. The API uses this client for minimal reads and writes.
 *
 * Connection is lazy-initialized once and shared across concurrent requests.
 */

import { MongoClient, type Db, type Collection } from "mongodb";
import { logger } from "./logger";

let _client: MongoClient | null = null;
let _db: Db | null = null;
let _dbPromise: Promise<Db> | null = null;

function getMongoUri(): string {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI environment variable is required");
  return uri;
}

export async function getDb(): Promise<Db> {
  if (_db) return _db;

  // Cache the in-flight connection as well as the connected DB. Without this,
  // simultaneous cold-start requests can each create a MongoClient and race
  // to overwrite the module-level client reference.
  if (!_dbPromise) {
    const client = new MongoClient(getMongoUri(), {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    _client = client;

    _dbPromise = client
      .connect()
      .then(() => {
        const db = client.db(); // uses the DB name from the URI
        _db = db;
        logger.info("MongoDB native client connected (API server)");
        return db;
      })
      .catch(async (error: unknown) => {
        if (_client === client) {
          _client = null;
          _db = null;
          _dbPromise = null;
        }
        await client.close().catch(() => undefined);
        throw error;
      });
  }

  return _dbPromise;
}

export async function getClient(): Promise<MongoClient> {
  await getDb();
  if (!_client) throw new Error("MongoDB client is not connected");
  return _client;
}

export async function getCollection<T extends object>(
  name: string
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

export async function closeDb(): Promise<void> {
  // Wait for a pending connection to settle before closing its client.
  if (_dbPromise) await _dbPromise.catch(() => undefined);

  const client = _client;
  if (client) await client.close();

  if (_client === client) {
    _client = null;
    _db = null;
    _dbPromise = null;
  }
}
