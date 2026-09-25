// One API process: load config, station master (MongoDB or file), wire services (bootstrap.ts), listen.
// Started by server.ts, either directly or as a node:cluster worker (NODE_CLUSTER > 1).
import cluster from "node:cluster";
import { createServer } from "node:http";
import { AggregatorRegistry } from "prom-client";
import { createApp } from "./app.ts";
import { createServices, resolveEngineIdentity } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createMetrics } from "./metrics.ts";
import type { RouteCache } from "./services/routeCache.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const services = await createServices(config, logger);
const { mongo, stations, engine, redis, cache, routes } = services;

// The engines' routing configuration and timetable hash are part of the cache key (results are never
// reused across configs or timetables). The cache is prewarmed by the separate cache-warmer service.
async function refreshEngineIdentity(): Promise<void> {
  try {
    if (!(await resolveEngineIdentity(services, logger))) setTimeout(refreshEngineIdentity, 5000).unref();
  } catch (e) {
    logger.fatal({ err: (e as Error).message }, "refusing to start");
    process.exit(1);
  }
}
await refreshEngineIdentity();

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
  mongoStatus: () => services.mongoState,
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
