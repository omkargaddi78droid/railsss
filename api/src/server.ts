// API entry point: load config, station master (MongoDB or file), wire services, listen.
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { connectMongo, type Mongo } from "./db/mongo.ts";
import { createLogger } from "./logger.ts";
import { HttpRoutingEngine, type EngineResult } from "./services/engineClient.ts";
import { RouteCache } from "./services/routeCache.ts";
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

const engine = new HttpRoutingEngine(config.engineUrl, config.engineTimeoutMs, config.engineConcurrency);
const cache = new RouteCache<EngineResult>(config.cacheMaxEntries, config.cacheTtlSeconds, config.cacheEnabled);
const routes = new RouteService(engine, stations, cache, config.maxResults);

// The engine's routing configuration is part of the cache key (never reuse results across configs).
async function refreshEngineConfig(): Promise<void> {
  try {
    const h = await engine.health();
    routes.configHash = JSON.stringify(h.config ?? {});
    logger.info({ engine: config.engineUrl, config: h.config }, "routing engine reachable");
  } catch (e) {
    logger.warn({ engine: config.engineUrl, err: (e as Error).message }, "routing engine not reachable yet");
    setTimeout(refreshEngineConfig, 5000).unref();
  }
}
await refreshEngineConfig();

const app = createApp({
  logger,
  stations,
  routes,
  engine,
  maxResults: config.maxResults,
  maxDurationFilterMinutes: config.maxDurationFilterMinutes,
  corsOrigin: config.corsOrigin,
  mongoStatus: () => mongoState,
});

const server = app.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, "api listening"));
server.keepAliveTimeout = 65_000;

const shutdown = (signal: string) => {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void mongo?.client.close().finally(() => process.exit(0));
    if (!mongo) process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
