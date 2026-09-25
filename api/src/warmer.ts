// Cache-warmer: a one-shot service that computes the most likely searches into the Redis route cache
// (see services/prewarm.ts for what is warmed), then exits. Same image as the API:
//   node src/warmer.ts
// It builds the same services as the API (bootstrap.ts), so its cache keys match the API's. It waits up
// to WARMER_WAIT_MS for Redis and the engines, and exits nonzero if either never becomes reachable.
// A Redis lock lets only one warmer run at a time across the deployment.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createServices, resolveEngineIdentity } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { planPrewarm, runPrewarm } from "./services/prewarm.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const waitMs = Number.parseInt(process.env.WARMER_WAIT_MS || "120000", 10);

async function main(): Promise<number> {
  const services = await createServices(config, logger);
  const { redis, routes, stations, cache } = services;
  if (!redis || !cache.enabled) {
    logger.error("the cache-warmer needs CACHE_BACKEND=redis and REDIS_URL");
    return 1;
  }
  const deadline = Date.now() + waitMs;
  while (!redis.ready || !(await resolveEngineIdentity(services, logger))) {
    if (Date.now() > deadline) {
      logger.error({ redis: redis.ready, wait_ms: waitMs }, "redis or routing engine never became reachable");
      return 1;
    }
    await sleep(2000);
  }

  const p = config.prewarm;
  const lock = `prewarm:${routes.configHash}`;
  const token = randomUUID();
  if (!(await redis.tryLock(lock, token, p.lockMs))) {
    logger.info("cache prewarm already running in another warmer");
    return 0;
  }
  try {
    const extra = p.file ? JSON.parse(readFileSync(p.file, "utf8")) : [];
    const plan = planPrewarm(stations.all(), { pairs: p.pairs, times: p.times, days: p.days, tz: p.tz, extra })
      .filter((q) => stations.get(q.source) && stations.get(q.destination) && q.source !== q.destination);
    logger.info({ queries: plan.length, pairs: p.pairs, days: p.days, concurrency: p.concurrency }, "cache prewarm started");
    const stats = await runPrewarm(plan, (q) => routes.warm(q, p.ttlSeconds), p.concurrency, logger);
    logger.info(stats, "cache prewarm finished");
    return stats.failed > 0 && stats.failed === stats.total ? 1 : 0;
  } finally {
    await redis.unlock(lock, token).catch(() => {});
  }
}

const code = await main().catch((e) => {
  logger.error({ err: (e as Error).message }, "cache prewarm failed");
  return 1;
});
// Open handles (Redis, Mongo, pool health timer) would keep the process alive.
process.exit(code);
