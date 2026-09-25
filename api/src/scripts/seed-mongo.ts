// Loads the preprocessed dataset into MongoDB (idempotent upserts).
//   MONGODB_URI=mongodb://localhost:27017 node src/scripts/seed-mongo.ts [processed_dir] [reports_dir]
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMongo, ensureIndexes } from "../db/mongo.ts";
import { createLogger } from "../logger.ts";

const here = dirname(fileURLToPath(import.meta.url));
const processed = resolve(process.argv[2] ?? process.env.PROCESSED_DIR ?? resolve(here, "../../../data/processed"));
const reports = resolve(process.argv[3] ?? process.env.REPORTS_DIR ?? resolve(here, "../../../data/reports"));
const logger = createLogger(process.env.LOG_LEVEL || "info");
const uri = process.env.MONGODB_URI;
if (!uri) {
  logger.error("MONGODB_URI is required");
  process.exit(1);
}

const mongo = await connectMongo(uri, process.env.MONGODB_DB || "railway", logger);
if (!mongo) process.exit(1);
const { db, client } = mongo;
try {
  await ensureIndexes(db);
  const stations = JSON.parse(await readFile(resolve(processed, "stations.json"), "utf8")) as any[];
  const trains = JSON.parse(await readFile(resolve(processed, "trains.json"), "utf8")) as any[];
  const now = new Date();

  const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  for (const part of chunk(stations, 1000)) {
    await db.collection("stations").bulkWrite(part.map((s) => ({ replaceOne: { filter: { code: s.code }, replacement: { ...s, updated_at: now }, upsert: true } })));
  }
  for (const part of chunk(trains, 500)) {
    await db.collection("trains").bulkWrite(part.map((t) => ({ replaceOne: { filter: { number: t.number }, replacement: { ...t, updated_at: now }, upsert: true } })));
  }
  // remove records that no longer exist in the dataset
  await db.collection("stations").deleteMany({ code: { $nin: stations.map((s) => s.code) } });
  await db.collection("trains").deleteMany({ number: { $nin: trains.map((t) => t.number) } });

  try {
    const report = JSON.parse(await readFile(resolve(reports, "quality-report.json"), "utf8"));
    await db.collection("ingest_reports").insertOne({ generated_at: now, raw: report.raw, cleaned: report.cleaned, issue_counts: report.issue_counts });
  } catch {
    logger.warn("quality report not found; skipped ingest_reports");
  }
  logger.info({ stations: stations.length, trains: trains.length }, "mongodb seeded");
} finally {
  await client.close();
}
