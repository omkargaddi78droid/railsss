// All deployment-specific settings come from environment variables (see ../../.env.example).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LB_STRATEGIES, type LbStrategy } from "./services/enginePool.ts";

const here = dirname(fileURLToPath(import.meta.url));

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function oneOf<T extends string>(name: string, values: readonly T[], def: T): T {
  const v = process.env[name] || def;
  if (!(values as readonly string[]).includes(v)) throw new Error(`env ${name} must be one of ${values.join(", ")}, got "${v}"`);
  return v as T;
}

function strategy(v: string): LbStrategy {
  if (!(LB_STRATEGIES as readonly string[]).includes(v)) throw new Error(`env LB_STRATEGY must be one of ${LB_STRATEGIES.join(", ")}, got "${v}"`);
  return v as LbStrategy;
}

function prewarmTimes(v: string): string[] | "hourly" {
  if (v === "hourly") return v;
  const times = v.split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`env PREWARM_TIMES: "${t}" is not HH:MM`);
  return times;
}

export interface Config {
  port: number;
  host: string;
  engineUrls: string[];        // one or more engine workers (ENGINE_URLS, comma-separated; falls back to ENGINE_URL)
  engineTimeoutMs: number;
  engineConcurrency: number;   // max in-flight requests per worker (keep below that worker's ENGINE_THREADS)
  lbStrategy: LbStrategy;
  retryMax: number;
  hedgeAfterMs: number;
  maxQueue: number;            // -1 = unlimited; otherwise 429 beyond workers * concurrency + maxQueue in flight
  failThreshold: number;
  healthIntervalMs: number;
  mongoUri: string | null;
  mongoDb: string;
  stationsFile: string;
  cacheEnabled: boolean;
  cacheBackend: "none" | "redis";  // results are cached only in Redis (needs REDIS_URL), never in process
  cacheCoalesce: boolean;
  redisUrl: string | null;
  redisTimeoutMs: number;
  redisLockMs: number;         // 0 = no cross-process stampede lock
  engineRegistryKey: string | null; // Redis set of worker URLs; when set, the pool follows it
  metricsPort: number;         // 0 = no metrics listener
  nodeCluster: number;         // API processes (node:cluster); 1 = single process
  cacheTtlSeconds: number;
  prewarm: {
    enabled: boolean;          // warm the Redis cache with popular searches on startup
    pairs: number;             // busiest origin/destination pairs
    times: string[] | "hourly";
    days: number;              // today plus days-1 following dates
    tz: string;                // time zone that defines "today" and the current hour
    concurrency: number;       // prewarm searches in flight (leaves the rest of the pool to live traffic)
    ttlSeconds: number;        // TTL of prewarmed entries
    file: string | null;       // extra queries: JSON array of {source, destination, time}
  };
  corsOrigin: string | null;
  logLevel: string;
  maxResults: number;          // routes computed per search and cap per request (engine TOP_K must be >= this)
  maxDurationFilterMinutes: number;
}

export function loadConfig(): Config {
  return {
    port: int("API_PORT", 4000),
    host: process.env.API_HOST || "0.0.0.0",
    engineUrls: (process.env.ENGINE_URLS || process.env.ENGINE_URL || "http://127.0.0.1:7070")
      .split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean),
    engineTimeoutMs: int("ENGINE_TIMEOUT_MS", 5000),
    engineConcurrency: Math.max(1, int("ENGINE_CONCURRENCY", 4)),
    lbStrategy: strategy(process.env.LB_STRATEGY || "round_robin"),
    retryMax: Math.max(0, int("RETRY_MAX", 1)),
    hedgeAfterMs: Math.max(0, int("HEDGE_AFTER_MS", 0)),
    maxQueue: int("MAX_QUEUE", -1),
    failThreshold: Math.max(1, int("FAIL_THRESHOLD", 3)),
    healthIntervalMs: Math.max(0, int("HEALTH_INTERVAL_MS", 2000)),
    mongoUri: process.env.MONGODB_URI || null,
    mongoDb: process.env.MONGODB_DB || "railway",
    stationsFile: process.env.STATIONS_FILE || resolve(here, "../../data/processed/stations.json"),
    cacheEnabled: bool("CACHE_ENABLED", true),
    cacheBackend: oneOf("CACHE_BACKEND", ["none", "redis"] as const, "redis"),
    cacheCoalesce: bool("CACHE_COALESCE", true),
    redisUrl: process.env.REDIS_URL || null,
    redisTimeoutMs: Math.max(1, int("REDIS_TIMEOUT_MS", 50)),
    redisLockMs: Math.max(0, int("REDIS_LOCK_MS", 0)),
    engineRegistryKey: process.env.ENGINE_REGISTRY_KEY || null,
    metricsPort: int("METRICS_PORT", 9464),
    nodeCluster: Math.max(1, int("NODE_CLUSTER", 1)),
    cacheTtlSeconds: int("CACHE_TTL_SECONDS", 3600),
    prewarm: {
      enabled: bool("PREWARM", true),
      pairs: Math.max(0, int("PREWARM_PAIRS", 50)),
      times: prewarmTimes(process.env.PREWARM_TIMES || "hourly"),
      days: Math.max(1, int("PREWARM_DAYS", 1)),
      tz: process.env.PREWARM_TZ || "Asia/Kolkata",
      concurrency: Math.max(1, int("PREWARM_CONCURRENCY", 2)),
      ttlSeconds: int("PREWARM_TTL_SECONDS", (Math.max(1, int("PREWARM_DAYS", 1)) + 1) * 86_400),
      file: process.env.PREWARM_FILE || null,
    },
    corsOrigin: process.env.CORS_ORIGIN || null,
    logLevel: process.env.LOG_LEVEL || "info",
    maxResults: Math.max(1, int("MAX_RESULTS", 50)),
    maxDurationFilterMinutes: 3000,
  };
}
