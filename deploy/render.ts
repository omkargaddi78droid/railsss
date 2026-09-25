// Renders one deployment variant from deploy/inventory.json into deploy/.out/<variant>/:
//   <host>/compose.yml         every service that host runs (host networking, pinned engines)
//   <host>/targets/*.json       Prometheus file_sd targets (monitoring host only)
//   plan.json                   hosts, deploy phases, worker/API URLs, public entry points
//   variant.env                 the fully resolved variant (defaults + file + overrides)
//
//   node deploy/render.ts <variant> [KEY=VALUE ...]
//
// <variant> names deploy/variants/<variant>.env; its keys override deploy/variants/defaults.env and
// command-line KEY=VALUE pairs override both. Unknown keys are an error, so a typo never silently
// runs the wrong experiment. Compose files are written as JSON, which is valid YAML.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export type Role = "worker" | "api" | "nginx" | "redis" | "monitoring";
export interface Host { name: string; public_ip: string; private_ip: string; roles: Role[] }
export interface Inventory {
  region: string;
  instance_type: string;
  registry: string;
  repositories: { engine: string; api: string };
  hosts: Host[];
  k6?: { public_ip: string };
}

// Which variant keys reach which service. Anything else in a variant file is rejected.
const ENGINE_KEYS = ["ENGINE_THREADS", "TOP_K", "MAX_LABELS", "K_NODE", "MIN_TRANSFER_MINUTES", "MAX_TRANSFERS_INTERNAL",
  "SEARCH_HORIZON_MINUTES", "PRUNE_STAY_ON", "PRUNE_BOARD_EARLIER", "SHUTDOWN_GRACE_MS"];
const API_KEYS = ["ENGINE_TIMEOUT_MS", "ENGINE_CONCURRENCY", "LB_STRATEGY", "RETRY_MAX", "HEDGE_AFTER_MS", "MAX_QUEUE",
  "FAIL_THRESHOLD", "HEALTH_INTERVAL_MS", "NODE_CLUSTER", "CACHE_ENABLED", "CACHE_BACKEND", "CACHE_COALESCE",
  "CACHE_TTL_SECONDS", "REDIS_TIMEOUT_MS", "REDIS_LOCK_MS", "ENGINE_REGISTRY_KEY", "LOG_LEVEL"];
const WARMER_KEYS = ["PREWARM_PAIRS", "PREWARM_TIMES", "PREWARM_DAYS", "PREWARM_TZ", "PREWARM_CONCURRENCY", "PREWARM_TTL_SECONDS"];
const LAYOUT_KEYS = ["IMAGE_TAG", "WORKERS", "WORKERS_PER_HOST", "WORKER_PLACEMENT", "PREWARM", "GZIP", "REDIS_MAXMEMORY",
  "ENGINE_PORT_BASE", "PROMETHEUS_RETENTION"];
const KNOWN = new Set([...ENGINE_KEYS, ...API_KEYS, ...WARMER_KEYS, ...LAYOUT_KEYS]);

export function parseEnv(text: string, source: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`${source}:${i + 1}: expected KEY=VALUE, got "${line}"`);
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  });
  return out;
}

export function resolveVariant(variant: string, overrides: string[], dir = join(here, "variants")): Record<string, string> {
  const file = join(dir, `${variant}.env`);
  if (!existsSync(file)) throw new Error(`no variant file ${file}`);
  const env = {
    ...parseEnv(readFileSync(join(dir, "defaults.env"), "utf8"), "defaults.env"),
    ...parseEnv(readFileSync(file, "utf8"), `${variant}.env`),
    ...parseEnv(overrides.join("\n"), "command line"),
  };
  const unknown = Object.keys(env).filter((k) => !KNOWN.has(k));
  if (unknown.length) throw new Error(`unknown variant keys: ${unknown.join(", ")}`);
  return env;
}

export interface WorkerSlot { host: Host; slot: number; id: string; port: number; adminPort: number; cpuset: string | null }

// Engine processes: WORKERS_PER_HOST slots on each worker host. "spread" fills slot a on every host
// before any slot b (no HT sharing until more workers than hosts); "pack" fills host by host.
export function workerSlots(inv: Inventory, env: Record<string, string>): WorkerSlot[] {
  const hosts = inv.hosts.filter((h) => h.roles.includes("worker"));
  const perHost = int(env, "WORKERS_PER_HOST");
  if (perHost < 1 || perHost > 2) throw new Error("WORKERS_PER_HOST must be 1 or 2 (2 vCPU hosts)");
  const all: WorkerSlot[] = [];
  const base = int(env, "ENGINE_PORT_BASE");
  for (const host of hosts) {
    for (let slot = 0; slot < perHost; slot++) {
      all.push({
        host, slot,
        id: `${host.name}${"ab"[slot]}`,
        port: base + slot * 10,
        adminPort: base + slot * 10 + 1,
        // one process per vCPU when two share a host; a lone process may use both hyperthreads
        cpuset: perHost === 2 ? String(slot) : null,
      });
    }
  }
  const order = env.WORKER_PLACEMENT === "pack" ? all
    : env.WORKER_PLACEMENT === "spread" ? [...all].sort((a, b) => a.slot - b.slot)
    : (() => { throw new Error("WORKER_PLACEMENT must be spread or pack"); })();
  const n = env.WORKERS === "all" ? all.length : int(env, "WORKERS");
  if (n < 1 || n > all.length) throw new Error(`WORKERS=${n}, but the inventory has ${all.length} worker slots`);
  return order.slice(0, n);
}

function int(env: Record<string, string>, key: string): number {
  const n = Number.parseInt(env[key], 10);
  if (!Number.isFinite(n)) throw new Error(`${key} must be an integer, got "${env[key]}"`);
  return n;
}

function pick(env: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => env[k] !== undefined && env[k] !== "").map((k) => [k, env[k]]));
}

function only(inv: Inventory, role: Role): Host[] {
  return inv.hosts.filter((h) => h.roles.includes(role));
}

function one(inv: Inventory, role: Role): Host {
  const hs = only(inv, role);
  if (hs.length !== 1) throw new Error(`exactly one host must have role ${role}, found ${hs.length}`);
  return hs[0];
}

const OPT = "/opt/railway"; // on every host: compose.yml, loadtest/{grafana,nginx}, targets/

export function render(inv: Inventory, env: Record<string, string>) {
  const tag = env.IMAGE_TAG;
  if (!tag) throw new Error("IMAGE_TAG is empty: run deploy/images.sh first (it writes deploy/.out/image-tag)");
  const engineImage = `${inv.repositories.engine}:${tag}`;
  const apiImage = `${inv.repositories.api}:${tag}`;
  const workers = workerSlots(inv, env);
  const apis = only(inv, "api");
  if (!apis.length) throw new Error("no host has role api");
  const nginx = one(inv, "nginx");
  const redis = one(inv, "redis");
  const monitoring = one(inv, "monitoring");
  const engineUrls = workers.map((w) => `http://${w.host.private_ip}:${w.port}`);
  const redisUrl = `redis://${redis.private_ip}:6379`;
  const common = { restart: "unless-stopped", network_mode: "host" };

  const apiEnv = {
    ...pick(env, API_KEYS),
    API_PORT: "4000",
    METRICS_PORT: "9464",
    ENGINE_URLS: engineUrls.join(","),
    REDIS_URL: redisUrl,
    MAX_RESULTS: env.TOP_K,
  };

  const files: Record<string, string> = {};
  for (const host of inv.hosts) {
    const s: Record<string, unknown> = {};
    for (const w of workers.filter((x) => x.host === host)) {
      s[`engine-${"ab"[w.slot]}`] = {
        ...common,
        image: engineImage,
        container_name: `${host.name}-engine-${"ab"[w.slot]}`,
        ...(w.cpuset !== null ? { cpuset: w.cpuset } : {}),
        stop_grace_period: "20s",
        environment: {
          ...pick(env, ENGINE_KEYS),
          WORKER_ID: w.id,
          ENGINE_HOST: "0.0.0.0",
          ENGINE_PORT: String(w.port),
          ADMIN_PORT: String(w.adminPort),
        },
        healthcheck: {
          test: ["CMD", "curl", "-fsS", `http://127.0.0.1:${w.adminPort}/health`],
          interval: "5s", timeout: "3s", start_period: "10s", retries: 3,
        },
      };
    }
    if (host.roles.includes("api")) {
      s.api = { ...common, image: apiImage, container_name: `${host.name}-api`, environment: apiEnv };
      if (host === apis[0]) {
        // one-shot, run by deploy.sh when PREWARM=true (E10); never started by `up`
        s["cache-warmer"] = {
          network_mode: "host",
          image: apiImage,
          container_name: `${host.name}-cache-warmer`,
          profiles: ["warm"],
          command: ["node", "src/warmer.ts"],
          restart: "no",
          healthcheck: { disable: true },
          environment: {
            ...pick(env, WARMER_KEYS), ...pick(apiEnv, ["ENGINE_URLS", "ENGINE_CONCURRENCY", "LB_STRATEGY", "REDIS_URL", "MAX_RESULTS"]),
            CACHE_BACKEND: "redis", METRICS_PORT: "0", LOG_LEVEL: "info",
          },
        };
      }
    }
    if (host.roles.includes("nginx")) {
      s.nginx = {
        ...common,
        image: "nginx:alpine",
        container_name: `${host.name}-nginx`,
        environment: {
          API_SERVERS: apis.map((a) => `server ${a.private_ip}:4000;`).join(" "),
          GZIP: env.GZIP,
          NGINX_ENVSUBST_FILTER: "^(API_SERVERS|GZIP)$",
        },
        volumes: [`${OPT}/loadtest/nginx/gateway.conf.template:/etc/nginx/templates/default.conf.template:ro`],
      };
      s["nginx-exporter"] = {
        ...common,
        image: "nginx/nginx-prometheus-exporter:latest",
        container_name: `${host.name}-nginx-exporter`,
        command: ["--nginx.scrape-uri=http://127.0.0.1/nginx_status"],
      };
    }
    if (host.roles.includes("redis")) {
      s.redis = {
        ...common,
        image: "redis:7-alpine",
        container_name: `${host.name}-redis`,
        // reachable from the VPC only (security group); no persistence: every deploy starts cold
        command: ["redis-server", "--bind", "0.0.0.0", "--protected-mode", "no", "--save", "", "--appendonly", "no",
          "--maxmemory", env.REDIS_MAXMEMORY, "--maxmemory-policy", "allkeys-lru"],
      };
    }
    if (host.roles.includes("monitoring")) {
      s.prometheus = {
        ...common,
        image: "prom/prometheus:latest",
        container_name: `${host.name}-prometheus`,
        command: ["--config.file=/etc/prometheus/prometheus.yml", `--storage.tsdb.retention.time=${env.PROMETHEUS_RETENTION}`,
          "--web.enable-remote-write-receiver"],
        volumes: [`${OPT}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`, `${OPT}/targets:/etc/prometheus/targets:ro`,
          "prom-data:/prometheus"],
      };
      s.grafana = {
        ...common,
        image: "grafana/grafana:latest",
        container_name: `${host.name}-grafana`,
        environment: {
          PROMETHEUS_URL: "http://127.0.0.1:9090",
          GF_SECURITY_ADMIN_PASSWORD: "${GRAFANA_ADMIN_PASSWORD:?set in /opt/railway/.env}",
          GF_AUTH_ANONYMOUS_ENABLED: "false",
          GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: "/var/lib/grafana/dashboards/scaling.json",
          GF_ANALYTICS_REPORTING_ENABLED: "false",
          GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
        },
        volumes: [`${OPT}/loadtest/grafana/provisioning:/etc/grafana/provisioning:ro`,
          `${OPT}/loadtest/grafana/dashboards:/var/lib/grafana/dashboards:ro`, "grafana-data:/var/lib/grafana"],
      };
    }
    // exporters on every host
    s["node-exporter"] = {
      ...common,
      image: "prom/node-exporter:latest",
      container_name: `${host.name}-node-exporter`,
      command: ["--path.rootfs=/host"],
      pid: "host",
      volumes: ["/:/host:ro,rslave"],
    };
    s.cadvisor = {
      ...common,
      image: "gcr.io/cadvisor/cadvisor:latest",
      container_name: `${host.name}-cadvisor`,
      privileged: true,
      command: ["--port=8080", "--docker_only=true", "--housekeeping_interval=5s", "--store_container_labels=false"],
      devices: ["/dev/kmsg"],
      volumes: ["/:/rootfs:ro", "/var/run:/var/run:ro", "/sys:/sys:ro", "/var/lib/docker/:/var/lib/docker:ro", "/dev/disk/:/dev/disk:ro"],
    };
    const compose: Record<string, unknown> = { name: "railway", services: s };
    if (host.roles.includes("monitoring")) compose.volumes = { "prom-data": {}, "grafana-data": {} };
    files[`${host.name}/compose.yml`] = JSON.stringify(compose, null, 2) + "\n";
  }

  // Prometheus file_sd targets, labelled with the host name (the monitoring host re-reads them on change).
  const target = (addr: string, labels: Record<string, string>) => ({ targets: [addr], labels });
  const targets: Record<string, unknown[]> = {
    engine: workers.map((w) => target(`${w.host.private_ip}:${w.adminPort}`, { host: w.host.name, worker_slot: w.id })),
    api: apis.map((h) => target(`${h.private_ip}:9464`, { host: h.name })),
    nginx: [target(`${nginx.private_ip}:9113`, { host: nginx.name })],
    node: inv.hosts.map((h) => target(`${h.private_ip}:9100`, { host: h.name })),
    cadvisor: inv.hosts.map((h) => target(`${h.private_ip}:8080`, { host: h.name })),
  };
  for (const [job, t] of Object.entries(targets)) files[`${monitoring.name}/targets/${job}.json`] = JSON.stringify(t, null, 2) + "\n";

  // Deploy order: engines, Redis and monitoring first; the API refuses to start until an engine
  // answers (its timetable hash is part of the cache key); nginx last.
  const phase = (h: Host) => (h.roles.includes("nginx") ? 3 : h.roles.includes("api") ? 2 : 1);
  const plan = {
    image_tag: tag,
    hosts: inv.hosts.map((h) => ({ name: h.name, public_ip: h.public_ip, private_ip: h.private_ip, roles: h.roles, phase: phase(h) })),
    workers: workers.map((w) => ({ id: w.id, host: w.host.name, url: `http://${w.host.private_ip}:${w.port}`, admin: `http://${w.host.private_ip}:${w.adminPort}`, cpuset: w.cpuset })),
    api: apis.map((h) => ({ host: h.name, url: `http://${h.private_ip}:4000` })),
    gateway: { host: nginx.name, public_url: `http://${nginx.public_ip}`, private_url: `http://${nginx.private_ip}` },
    monitoring: { host: monitoring.name, public_ip: monitoring.public_ip, prometheus_private: `http://${monitoring.private_ip}:9090` },
    prewarm: env.PREWARM === "true",
    warmer_host: apis[0].name,
  };
  return { files, plan };
}

function main() {
  const [variant, ...overrides] = process.argv.slice(2);
  if (!variant) {
    console.error("usage: node deploy/render.ts <variant> [KEY=VALUE ...]");
    process.exit(2);
  }
  const invPath = join(here, "inventory.json");
  if (!existsSync(invPath)) throw new Error("deploy/inventory.json is missing: run node deploy/inventory.ts after terraform apply");
  const inv = JSON.parse(readFileSync(invPath, "utf8")) as Inventory;
  const tagFile = join(here, ".out", "image-tag");
  const env = resolveVariant(variant, [
    ...(existsSync(tagFile) ? [`IMAGE_TAG=${readFileSync(tagFile, "utf8").trim()}`] : []),
    ...overrides,
  ]);
  const { files, plan } = render(inv, env);

  const out = join(here, ".out", variant);
  rmSync(out, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), body);
  }
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", resolve(here, ".."), "describe", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch { /* not a git checkout */ }
  writeFileSync(join(out, "plan.json"), JSON.stringify({ variant, git_commit: commit, instance_type: inv.instance_type, region: inv.region, ...plan }, null, 2) + "\n");
  writeFileSync(join(out, "variant.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  console.log(`rendered ${variant}: ${plan.workers.length} workers on ${new Set(plan.workers.map((w) => w.host)).size} hosts, ` +
    `${plan.api.length} API host(s) -> deploy/.out/${variant}/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
