// Service wiring shared by the API process (apiProcess.ts) and the cache-warmer (warmer.ts), so both
// build the same pool, cache and route service, and therefore the same cache keys.
import type { Config } from "./config.ts";
import { connectMongo, type Mongo } from "./db/mongo.ts";
import type { Logger } from "./logger.ts";
import type { EngineResult } from "./services/engineClient.ts";
import { EnginePool } from "./services/enginePool.ts";
import { JourneyRenderer } from "./services/journeyRenderer.ts";
import { RedisStore } from "./services/redisStore.ts";
import { RouteCache } from "./services/routeCache.ts";
import { engineIdentity, RouteService } from "./services/routeService.ts";
import { loadStationsFromFile, loadStationsFromMongo, StationService } from "./services/stationService.ts";

export interface Services {
  mongo: Mongo | null;
  mongoState: "connected" | "disabled" | "error";
  stations: StationService;
  engine: EnginePool;
  redis: RedisStore | null;
  cache: RouteCache<EngineResult>;
  renderer: JourneyRenderer;
  routes: RouteService;
}

export async function createServices(config: Config, logger: Logger): Promise<Services> {
  let mongo: Mongo | null = null;
  let mongoState: Services["mongoState"] = "disabled";
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

  const renderer = JourneyRenderer.fromFile(config.timetablePath);
  logger.info({ path: config.timetablePath, timetable: renderer.hash }, "timetable loaded for rendering");

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
  const routes = new RouteService(engine, stations, cache, renderer, config.maxResults);
  return { mongo, mongoState, stations, engine, redis, cache, renderer, routes };
}

// Waits for the engines' /health, checks their timetable against the renderer's and sets the cache-key
// identity. Returns false while no engine is reachable; throws on a timetable mismatch.
export async function resolveEngineIdentity(s: Services, logger: Logger): Promise<boolean> {
  let h: Record<string, unknown>;
  try {
    h = await s.engine.health();
  } catch (e) {
    logger.warn({ workers: s.engine.urls, err: (e as Error).message }, "routing engine not reachable yet");
    return false;
  }
  s.renderer.check(h.timetable);
  s.routes.configHash = engineIdentity(h);
  logger.info({ workers: s.engine.urls.length, timetable: h.timetable, config: h.config }, "routing engine reachable");
  return true;
}
