// One API process: load config, station master (MongoDB or file), wire services, listen.
// Started by server.ts, either directly or as a node:cluster worker (NODE_CLUSTER > 1).
import { randomUUID } from "node:crypto";
import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { AggregatorRegistry } from "prom-client";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { connectMongo, type Mongo } from "./db/mongo.ts";
import { createLogger } from "./logger.ts";
import { createMetrics } from "./metrics.ts";
import type { EngineResult } from "./services/engineClient.ts";
import { EnginePool } from "./services/enginePool.ts";
import { planPrewarm, runPrewarm } from "./services/prewarm.ts";
import { RouteCache } from "./services/routeCache.ts";
import { RedisStore } from "./services/redisStore.ts";
import { RouteService } from "./services/routeService.ts";
import { loadStationsFromFile, loadStationsFromMongo, StationService } from "./services/stationService.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);

let mongo: Mongo | null = null;
let mongoState: "connected" | "disabled" | "error" = "disabled";
const stations = new StationService();

if (config.mongoUri) {
  mongo = await connectMongo(config.mongoUri, config.mongoDb, logger);
  mongoState = mongo ? "connected" : "error";
}
if (mongo) {
  const fromDb = await loadStationsFromMongo(mongo.db).catch(() => []);
  if (fromDb.length) stations.load(fromDb, "mongodb");
}
if (stations.size === 0) {
  stations.load(await loadStationsFromFile(config.stationsFile), "file");
  if (mongo) logger.warn("stations collection empty; loaded station master from file (run `npm run seed`)");
}
logger.info({ stations: stations.size, source: stations.source }, "station master loaded");

const engine = new EnginePool({
  urls: config.engineUrls,
  timeoutMs: config.engineTimeoutMs,
  perWorkerConcurrency: config.engineConcurrency,
  strategy: config.lbStrategy,
  retryMax: config.retryMax,
  hedgeAfterMs: config.hedgeAfterMs,
  maxQueue: config.maxQueue,
  failThreshold: config.failThreshold,
  healthIntervalMs: config.healthIntervalMs,
});

let redis: RedisStore | null = null;
const useCache = config.cacheEnabled && config.cacheBackend === "redis";
if (useCache && !config.redisUrl) logger.warn("CACHE_BACKEND=redis but REDIS_URL is not set: route cache disabled");
if (config.redisUrl && (useCache || config.engineRegistryKey)) {
  redis = new RedisStore(config.redisUrl, logger, config.redisTimeoutMs);
  // Not fatal: the cache fails open and the pool keeps its static list until Redis is reachable.
  await redis.connect().catch((e) => logger.warn({ err: (e as Error).message }, "redis not reachable yet"));
}
// Results live only in Redis; with no Redis the cache is off.
const cache = new RouteCache<EngineResult>(useCache ? redis : null, config.cacheTtlSeconds, {
  coalesce: config.cacheCoalesce,
  lockMs: config.redisLockMs,
});
const routes = new RouteService(engine, stations, cache, config.maxResults);

// The engine's routing configuration is part of the cache key (never reuse results across configs).
async function refreshEngineConfig(): Promise<void> {
  try {
    const h = await engine.health();
    routes.configHash = JSON.stringify(h.config ?? {});
    logger.info({ workers: config.engineUrls.length, strategy: config.lbStrategy, config: h.config }, "routing engine reachable");
    startPrewarm();
  } catch (e) {
    logger.warn({ workers: config.engineUrls, err: (e as Error).message }, "routing engine not reachable yet");
    setTimeout(refreshEngineConfig, 5000).unref();
  }
}
// Prewarm (see services/prewarm.ts): starts once the engine config (part of the cache key) is known,
// runs in the background, and holds a Redis lock so one process in the deployment does the work.
let prewarmStarted = false;
let prewarmAttempts = 0;
const prewarmToken = randomUUID();
function startPrewarm(): void {
  const p = config.prewarm;
  if (prewarmStarted || !p.enabled || !cache.enabled || !redis) return;
  if (!redis.ready) {
    setTimeout(startPrewarm, 5000).unref(); // computing without Redis would discard every result
    return;
  }
  prewarmStarted = true;
  const lock = `prewarm:${routes.configHash}`;
  void (async () => {
    try {
      if (!(await redis.tryLock(lock, prewarmToken, 10 * 60_000))) {
        logger.info("cache prewarm already running in another process");
        return;
      }
      const extra = p.file ? JSON.parse(readFileSync(p.file, "utf8")) : [];
      const plan = planPrewarm(stations.all(), { pairs: p.pairs, times: p.times, days: p.days, tz: p.tz, extra })
        .filter((q) => stations.get(q.source) && stations.get(q.destination) && q.source !== q.destination);
      logger.info({ queries: plan.length, pairs: p.pairs, days: p.days, concurrency: p.concurrency }, "cache prewarm started");
      const stats = await runPrewarm(plan, (q) => routes.warm(q, p.ttlSeconds), p.concurrency, logger);
      logger.info(stats, "cache prewarm finished");
      await redis.unlock(lock, prewarmToken);
    } catch (e) {
      // e.g. Redis unreachable for the lock: try again a few times
      const retry = ++prewarmAttempts < 5;
      logger.warn({ err: (e as Error).message, retry }, "cache prewarm failed");
      if (retry) {
        prewarmStarted = false;
        setTimeout(startPrewarm, 5000).unref();
      }
    }
  })();
}

await refreshEngineConfig();

// Dynamic membership: follow a Redis set of worker URLs (workers joining or leaving during a test).
if (redis && config.engineRegistryKey) {
  const key = config.engineRegistryKey;
  const sync = async () => {
    try {
      const urls = (await redis.members(key)).sort();
      if (urls.length && urls.join(",") !== engine.urls.join(",")) {
        engine.setWorkers(urls);
        logger.info({ workers: urls.length }, "engine worker set changed");
      }
    } catch {
      // keep the current list
    }
  };
  await sync();
  setInterval(sync, 1000).unref();
}

const metrics = createMetrics(engine, cache as RouteCache<unknown>);
if (cluster.isWorker) {
  new AggregatorRegistry(); // installs the listener that answers the primary's metrics requests
  AggregatorRegistry.setRegistries([metrics.registry]);
} else if (config.metricsPort > 0) {
  createServer(async (_req, res) => {
    res.setHeader("content-type", metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  }).listen(config.metricsPort, config.host);
}

const app = createApp({
  logger,
  stations,
  routes,
  engine,
  maxResults: config.maxResults,
  maxDurationFilterMinutes: config.maxDurationFilterMinutes,
  corsOrigin: config.corsOrigin,
  mongoStatus: () => mongoState,
  observe: metrics.observe,
});

const server = app.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, "api listening"));
server.keepAliveTimeout = 65_000;

const shutdown = (signal: string) => {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void Promise.allSettled([mongo?.client.close(), redis?.client.quit()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
