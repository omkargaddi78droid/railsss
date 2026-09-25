// Optional MongoDB connection. Routing never queries MongoDB on the hot path; it stores the normalized
// station/train master data, ingest reports and (optionally) query history.
import { MongoClient, type Db } from "mongodb";
import type { Logger } from "../logger.ts";

export interface Mongo {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(uri: string, dbName: string, logger: Logger): Promise<Mongo | null> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, appName: "railway-api" });
  try {
    await client.connect();
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    logger.info({ db: dbName }, "mongodb connected");
    return { client, db };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "mongodb unavailable; continuing without it");
    await client.close().catch(() => {});
    return null;
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection("stations").createIndexes([
    { key: { code: 1 }, unique: true },
    { key: { name: 1 } },
    { key: { train_count: -1 } },
  ]);
  await db.collection("trains").createIndexes([
    { key: { number: 1 }, unique: true },
    { key: { "stops.code": 1 } },
    { key: { type: 1 } },
  ]);
  await db.collection("ingest_reports").createIndex({ generated_at: -1 });
}
