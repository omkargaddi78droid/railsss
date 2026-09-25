// API entry point. NODE_CLUSTER=n forks n API processes sharing the port (node:cluster); the primary
// then only supervises them and serves their summed Prometheus metrics on METRICS_PORT.
import cluster from "node:cluster";
import { createServer } from "node:http";
import { AggregatorRegistry } from "prom-client";
import { loadConfig } from "./config.ts";

const config = loadConfig();

if (config.nodeCluster > 1 && cluster.isPrimary) {
  let stopping = false;
  for (let i = 0; i < config.nodeCluster; i++) cluster.fork();
  cluster.on("exit", (w, code) => {
    if (stopping) return;
    console.error(JSON.stringify({ level: "error", msg: "api worker exited, restarting", pid: w.process.pid, code }));
    cluster.fork();
  });
  if (config.metricsPort > 0) {
    const aggregator = new AggregatorRegistry();
    createServer(async (_req, res) => {
      try {
        res.setHeader("content-type", aggregator.contentType);
        res.end(await aggregator.clusterMetrics());
      } catch (e) {
        res.statusCode = 500;
        res.end((e as Error).message);
      }
    }).listen(config.metricsPort, config.host);
  }
  const stop = () => {
    stopping = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 11_000).unref();
    cluster.on("exit", () => { if (!Object.keys(cluster.workers ?? {}).length) process.exit(0); });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  await import("./apiProcess.ts");
}
