// All deployment-specific settings come from environment variables (see ../../.env.example).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

export interface Config {
  port: number;
  host: string;
  engineUrl: string;
  engineTimeoutMs: number;
  engineConcurrency: number;   // max in-flight engine requests (keep below the engine's ENGINE_THREADS)
  mongoUri: string | null;
  mongoDb: string;
  stationsFile: string;
  cacheEnabled: boolean;
  cacheMaxEntries: number;
  cacheTtlSeconds: number;
  corsOrigin: string | null;
  logLevel: string;
  maxResults: number;          // hard cap on routes per request (spec: 20)
  maxDurationFilterMinutes: number;
}

export function loadConfig(): Config {
  return {
    port: int("API_PORT", 4000),
    host: process.env.API_HOST || "0.0.0.0",
    engineUrl: (process.env.ENGINE_URL || "http://127.0.0.1:7070").replace(/\/$/, ""),
    engineTimeoutMs: int("ENGINE_TIMEOUT_MS", 5000),
    engineConcurrency: Math.max(1, int("ENGINE_CONCURRENCY", 4)),
    mongoUri: process.env.MONGODB_URI || null,
    mongoDb: process.env.MONGODB_DB || "railway",
    stationsFile: process.env.STATIONS_FILE || resolve(here, "../../data/processed/stations.json"),
    cacheEnabled: bool("CACHE_ENABLED", true),
    cacheMaxEntries: int("CACHE_MAX_ENTRIES", 1000),
    cacheTtlSeconds: int("CACHE_TTL_SECONDS", 3600),
    corsOrigin: process.env.CORS_ORIGIN || null,
    logLevel: process.env.LOG_LEVEL || "info",
    maxResults: 20,
    maxDurationFilterMinutes: 3000,
  };
}
