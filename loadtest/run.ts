// Runs one experiment of the AWS scaling study (loadtest/experiments.ts) end to end:
// for every variant and repeat: deploy (deploy/deploy.sh, which flushes Redis so each repeat starts
// cold) -> smoke (must pass) -> setup actions -> measured k6 run with timed fault actions -> restore
// -> Prometheus range-query snapshots and container logs of the run's window.
//
//   node loadtest/run.ts --list
//   node loadtest/run.ts E1                                   every variant, 3 repeats
//   node loadtest/run.ts E4 CAPACITY=420 --variants p2c-uniform,round_robin-uniform --repeats 1
//   node loadtest/run.ts E17 CAPACITY=420 LB_STRATEGY=p2c NODE_CLUSTER=2   chosen config for every variant
//   node loadtest/run.ts E1 --dry-run                          print the commands only
//
// KEY=VALUE: an experiment param (see --list), a k6 knob (DURATION, SEED, ...) or a deploy key
// (deploy/variants/defaults.env); k6 and deploy keys override every variant's own value.
// Flags: --variants a,b  --repeats n  --force (redo repeats already done)  --dry-run
//        --suffix s (results as <variant>-<s>: a rerun with other overrides beside the original).
// Env: SSH_KEY as for deploy/deploy.sh.
//
// Results: loadtest/results/<EXP>/<variant>/r<n>/
//   summary.json  k6 end-of-test summary      meta.json   what ran, when, exit codes
//   plan.json, variant.env  the deployment     k6.log, deploy.log
//   smoke/        the smoke run's summary      prom/<name>.json  Prometheus query_range results
//   logs/<host>.log  docker compose logs of every host for the run's window
// plus loadtest/results/<EXP>/experiment.json and loadtest/results/manifest.jsonl (one line per repeat).
// A repeat whose meta.json says "ok" is skipped on rerun, so an interrupted experiment resumes.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN as DEPLOY_KEYS, parseEnv } from "../deploy/render.ts";
import { EXPERIMENTS, K6_KEYS, findExperiment, resolveParams, type Action, type Experiment, type Variant } from "./experiments.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const deployDir = join(root, "deploy");
const resultsRoot = join(here, "results");

interface Plan {
  variant: string;
  git_commit: string;
  instance_type: string;
  region: string;
  image_tag: string;
  hosts: { name: string; public_ip: string; private_ip: string; roles: string[] }[];
  workers: { id: string; host: string; url: string; admin: string }[];
  monitoring: { host: string; public_ip: string };
}

// ---------- command line ----------

interface Options {
  experiment: Experiment;
  params: Record<string, number>;
  deploy: Record<string, string>;
  k6: Record<string, string>;
  variants: string[] | null;
  repeats: number | null;
  force: boolean;
  dryRun: boolean;
  suffix: string | null;
}

export function parseArgs(argv: string[]): Options | "list" {
  if (argv.includes("--list")) return "list";
  const pairs: Record<string, string> = {};
  let id: string | null = null;
  let variants: string[] | null = null;
  let repeats: number | null = null;
  let force = false, dryRun = false;
  let suffix: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variants") variants = argv[++i].split(",").filter(Boolean);
    else if (a === "--repeats") repeats = Number.parseInt(argv[++i], 10);
    else if (a === "--force") force = true;
    else if (a === "--suffix") suffix = argv[++i];
    else if (a === "--dry-run") dryRun = true;
    else if (/^[A-Z][A-Z0-9_]*=/.test(a)) pairs[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (!a.startsWith("-") && !id) id = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!id) throw new Error("usage: node loadtest/run.ts <EXP> [KEY=VALUE ...] [--variants a,b] [--repeats n] [--force] [--dry-run]");
  if (repeats !== null && !(repeats >= 1)) throw new Error("--repeats must be >= 1");
  if (suffix !== null && !/^[a-z0-9_.-]+$/.test(suffix)) throw new Error("--suffix must match [a-z0-9_.-]+");
  const experiment = findExperiment(id);
  if (experiment.unsupported) throw new Error(`${experiment.id} cannot run yet: ${experiment.unsupported}`);
  const paramKeys = new Set(Object.keys(experiment.params ?? {}));
  const deploy: Record<string, string> = {}, k6: Record<string, string> = {}, given: Record<string, string> = {};
  for (const [k, v] of Object.entries(pairs)) {
    if (paramKeys.has(k)) given[k] = v;
    else if (K6_KEYS.includes(k)) k6[k] = v;
    else if (DEPLOY_KEYS.has(k)) deploy[k] = v;
    else throw new Error(`${k} is not a param of ${experiment.id} (${[...paramKeys].join(", ") || "none"}), a k6 knob or a deploy key`);
  }
  return { experiment, params: resolveParams(experiment, given), deploy, k6, variants, repeats, force, dryRun, suffix };
}

// The variants to run, with the command-line overrides applied.
export function expand(o: Options): Variant[] {
  const all = o.experiment.variants!(o.params);
  if (o.variants) {
    const unknown = o.variants.filter((v) => !all.some((x) => x.name === v));
    if (unknown.length) throw new Error(`unknown variants ${unknown.join(", ")}; ${o.experiment.id} has ${all.map((v) => v.name).join(", ")}`);
  }
  return all
    .filter((v) => !o.variants || o.variants.includes(v.name))
    .map((v) => ({ ...v, name: o.suffix ? `${v.name}-${o.suffix}` : v.name, deploy: { ...v.deploy, ...o.deploy }, k6: { ...v.k6, ...o.k6 } }));
}

const str = (r: Record<string, string | number> | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, String(v)]));

// ---------- processes ----------

let dryRun = false;
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

// Run a command, output to `logFile` (and not the console). Resolves with the exit code.
function run(cmd: string, args: string[], env: Record<string, string>, logFile: string): Promise<number> {
  if (dryRun) {
    const e = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`    $ ${e ? e + " " : ""}${cmd} ${args.join(" ")}`);
    return Promise.resolve(0);
  }
  return new Promise((ok) => {
    const out = createWriteStream(logFile, { flags: "a" });
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.pipe(out, { end: false });
    p.stderr.pipe(out, { end: false });
    p.on("close", (code) => out.end(() => ok(code ?? 1)));
  });
}

function sshArgs(ip: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${join(deployDir, ".known_hosts")}`, "-o", "ControlMaster=auto", "-o", "ControlPersist=120",
    "-o", "ControlPath=/tmp/railway-ssh-%C", ...(process.env.SSH_KEY ? ["-i", process.env.SSH_KEY] : []), `ubuntu@${ip}`];
}

// Run a shell script on a host; resolves with stdout, rejects on a non-zero exit.
function ssh(ip: string, script: string, input = ""): Promise<string> {
  if (dryRun) {
    console.log(`    $ ssh ${ip} '${script.replace(/\s+/g, " ").slice(0, 160)}'`);
    return Promise.resolve("");
  }
  return new Promise((ok, fail) => {
    const p = spawn("ssh", [...sshArgs(ip), script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`ssh ${ip}: exit ${code}: ${err.trim().slice(-500)}`))));
    p.stdin.end(input);
  });
}

// ---------- fault actions ----------

const workerContainer = (w: Plan["workers"][number]) => `${w.host}-engine-${w.id.slice(-1)}`;
const ipOf = (plan: Plan, host: string) => plan.hosts.find((h) => h.name === host)!.public_ip;
const redisHost = (plan: Plan) => plan.hosts.find((h) => h.roles.includes("redis"))!;

function byHost<T extends { host: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) m.set(x.host, [...(m.get(x.host) ?? []), x]);
  return m;
}

// SIGKILL without the restart policy bringing it back; start-* restores the policy.
const killScript = (names: string[]) =>
  `for c in ${names.join(" ")}; do docker update --restart=no $c >/dev/null && docker kill $c >/dev/null; done`;
const startScript = (names: string[]) =>
  `for c in ${names.join(" ")}; do if [ "$(docker inspect -f '{{.State.Running}}' $c)" != true ]; then ` +
  `docker update --restart=unless-stopped $c >/dev/null && docker start $c >/dev/null; fi; done`;

async function act(a: Action, plan: Plan, env: Record<string, string>): Promise<void> {
  const redis = redisHost(plan);
  switch (a.kind) {
    case "kill-workers": {
      const victims = plan.workers.slice(-a.count);
      await Promise.all([...byHost(victims)].map(([h, ws]) => ssh(ipOf(plan, h), killScript(ws.map(workerContainer)))));
      return;
    }
    case "start-workers":
      // start every stopped engine, then wait until each admin /health answers (the cold start)
      await Promise.all([...byHost(plan.workers)].map(([h, ws]) => ssh(ipOf(plan, h),
        startScript(ws.map(workerContainer)) + "; " + ws.map((w) =>
          `for i in $(seq 240); do curl -fsS -m 1 ${w.admin.replace(/\/\/[^:]+:/, "//127.0.0.1:")}/health >/dev/null 2>&1 && break; sleep 0.5; done`,
        ).join("; "))));
      return;
    case "kill-redis":
      await ssh(redis.public_ip, killScript([`${redis.name}-redis`]));
      return;
    case "start-redis":
      await ssh(redis.public_ip, startScript([`${redis.name}-redis`]) +
        `; for i in $(seq 60); do docker exec ${redis.name}-redis redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done`);
      return;
    case "registry-set": {
      const key = env.ENGINE_REGISTRY_KEY;
      if (!key) throw new Error("registry-set needs ENGINE_REGISTRY_KEY in the variant");
      const urls = (a.count === "all" ? plan.workers : plan.workers.slice(0, a.count)).map((w) => w.url);
      const cli = `docker exec -i ${redis.name}-redis redis-cli`;
      await ssh(redis.public_ip, `${cli} DEL ${key} >/dev/null && ${cli} SADD ${key} ${urls.join(" ")} >/dev/null`);
      return;
    }
  }
}

const describe = (a: Action) => ("count" in a ? `${a.kind} ${a.count}` : a.kind);

// ---------- Prometheus snapshots ----------

// Series saved for every run (5 s step). k6_* come from k6's remote write, filtered by the run's TESTID.
export function snapshotQueries(testid: string): Record<string, string> {
  const t = `testid="${testid}"`;
  const r = (m: string, by: string, filter = "") => `sum by (${by}) (rate(${m}${filter}[30s]))`;
  const q: Record<string, string> = {
    k6_rps: r("k6_http_reqs_total", "name, status", `{${t}}`),
    k6_failed_rate: `max(k6_http_req_failed_rate{${t}})`,
    k6_overloaded_rps: `sum(rate(k6_route_overloaded_total{${t}}[30s]))`,
    k6_vus: `max(k6_vus{${t}})`,
    api_rps: r("api_http_request_duration_seconds_count", "route, status"),
    api_latency_p50: `histogram_quantile(0.5, sum by (le) (rate(api_http_request_duration_seconds_bucket{route=~".*routes.*"}[30s])))`,
    api_latency_p99: `histogram_quantile(0.99, sum by (le) (rate(api_http_request_duration_seconds_bucket{route=~".*routes.*"}[30s])))`,
    api_pool_in_flight: "sum(api_pool_in_flight)",
    api_worker_outstanding: "sum by (worker) (api_worker_outstanding)",
    api_worker_healthy: "min by (worker) (api_worker_healthy)",
    api_worker_errors_rps: r("api_worker_errors_total", "worker"),
    api_cache_events: "sum by (outcome) (api_cache_events_total)",
    api_pool_events: "sum by (event) (api_pool_events_total)",
    engine_requests: "sum by (worker, outcome) (engine_requests_total)",
    engine_rps: r("engine_requests_total", "worker"),
    engine_in_flight: "sum by (worker) (engine_in_flight)",
    engine_route_p50: `histogram_quantile(0.5, sum by (le) (rate(engine_route_seconds_bucket[30s])))`,
    engine_route_p99: `histogram_quantile(0.99, sum by (le) (rate(engine_route_seconds_bucket[30s])))`,
    engine_route_p99_by_worker: `histogram_quantile(0.99, sum by (worker, le) (rate(engine_route_seconds_bucket[30s])))`,
    engine_labels_popped_rps: r("engine_labels_popped_total", "worker"),
    engine_budget_hits_rps: "sum(rate(engine_budget_hits_total[30s]))",
    engine_response_bytes_rps: "sum(rate(engine_response_bytes_total[30s]))",
    container_cpu: r("container_cpu_usage_seconds_total", "name", `{name!=""}`),
    container_memory: `sum by (name) (container_memory_working_set_bytes{name!=""})`,
    host_cpu_busy: `1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[30s]))`,
    host_net_rx_bytes: r("node_network_receive_bytes_total", "host", `{device!~"lo|docker.*|veth.*|br-.*"}`),
    host_net_tx_bytes: r("node_network_transmit_bytes_total", "host", `{device!~"lo|docker.*|veth.*|br-.*"}`),
    nginx_connections_active: "sum(nginx_connections_active)",
    nginx_rps: "sum(rate(nginx_http_requests_total[30s]))",
  };
  for (const p of ["p50", "p90", "p99", "max"]) q[`k6_latency_${p}`] = `max(k6_http_req_duration_${p}{${t}})`;
  return q;
}

async function snapshot(plan: Plan, testid: string, start: number, end: number, dir: string): Promise<number> {
  const queries = snapshotQueries(testid);
  const input = Object.entries(queries).map(([n, q]) => `${n}\t${q}`).join("\n") + "\n";
  const script = `while IFS=$'\\t' read -r n q; do printf '%s\\t' "$n"; ` +
    `curl -sG -m 30 http://127.0.0.1:9090/api/v1/query_range --data-urlencode "query=$q" ` +
    `-d start=${start.toFixed(0)} -d end=${end.toFixed(0)} -d step=5 | tr -d '\\n'; echo; done`;
  const out = await ssh(plan.monitoring.public_ip, script, input);
  mkdirSync(join(dir, "prom"), { recursive: true });
  let n = 0;
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const body = line.slice(tab + 1);
    writeFileSync(join(dir, "prom", `${line.slice(0, tab)}.json`), JSON.stringify({ query: queries[line.slice(0, tab)], start, end, step: 5,
      response: body ? JSON.parse(body) : null }) + "\n");
    n++;
  }
  return n;
}

async function collectLogs(plan: Plan, start: number, end: number, dir: string): Promise<void> {
  mkdirSync(join(dir, "logs"), { recursive: true });
  const iso = (s: number) => new Date(s * 1000).toISOString();
  await Promise.all(plan.hosts.map(async (h) => {
    try {
      const out = await ssh(h.public_ip, `cd /opt/railway && docker compose logs --no-color --timestamps --since ${iso(start)} --until ${iso(end)} | tail -n 20000`);
      writeFileSync(join(dir, "logs", `${h.name}.log`), out);
    } catch (e) {
      writeFileSync(join(dir, "logs", `${h.name}.log`), `could not fetch logs: ${(e as Error).message}\n`);
    }
  }));
}

// ---------- one repeat ----------

type Status = "ok" | "deploy-failed" | "smoke-failed" | "setup-failed" | "k6-failed";

async function runRepeat(o: Options, v: Variant, repeat: number, pulled: { done: boolean }): Promise<Status> {
  const e = o.experiment;
  const dir = join(resultsRoot, e.id, v.name, `r${repeat}`);
  const testid = `${e.id}-${v.name}-r${repeat}`.toLowerCase();
  if (!dryRun) mkdirSync(dir, { recursive: true });
  const deployArgs = Object.entries(str(v.deploy)).map(([k, val]) => `${k}=${val}`);
  const meta: Record<string, unknown> = {
    experiment: e.id, title: e.title, variant: v.name, repeat, testid, base: e.base ?? "baseline",
    deploy_overrides: str(v.deploy), scenario: v.scenario, k6_env: str(v.k6), params: o.params,
    setup: v.setup ?? [], during: v.during ?? [],
  };
  const finish = (status: Status, extra: Record<string, unknown> = {}) => {
    Object.assign(meta, extra, { status, finished_at: new Date().toISOString() });
    if (!dryRun) {
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
      appendFileSync(join(resultsRoot, "manifest.jsonl"), JSON.stringify({ ...meta, dir: join(e.id, v.name, `r${repeat}`) }) + "\n");
    }
    return status;
  };

  // 1. deploy (also flushes Redis, runs the cache-warmer when PREWARM=true, checks health)
  log(`${testid}: deploy ${meta.base} ${deployArgs.join(" ")}`);
  meta.deploy_started_at = new Date().toISOString();
  const dcode = await run(join(deployDir, "deploy.sh"), [String(meta.base), ...deployArgs], pulled.done && !v.deploy?.IMAGE_TAG ? { SKIP_PULL: "1" } : {},
    join(dir, "deploy.log"));
  if (dcode !== 0) return finish("deploy-failed", { deploy_exit: dcode });
  pulled.done = true;
  const plan: Plan = dryRun ? fakePlan() : JSON.parse(readFileSync(join(deployDir, ".out", "current", "plan.json"), "utf8"));
  const venv = dryRun ? { ...str(v.deploy) } : parseEnv(readFileSync(join(deployDir, ".out", "current", "variant.env"), "utf8"), "variant.env");
  Object.assign(meta, { git_commit: plan.git_commit, image_tag: plan.image_tag, instance_type: plan.instance_type, region: plan.region,
    workers: plan.workers.length });

  // 2. smoke: a fresh seed, so its queries do not warm the measured ones
  const smokeSeed = String(100000 + Math.floor(Math.random() * 900000));
  const scode = await run(join(deployDir, "k6.sh"), ["smoke"],
    { TESTID: `${testid}-smoke`, SEED: smokeSeed, RESULT_DIR: join(dir, "smoke") }, join(dir, "k6-smoke.log"));
  if (scode !== 0) return finish("smoke-failed", { smoke_exit: scode });

  const restore = async () => {
    const acts: Action[] = [];
    const all = [...(v.setup ?? []), ...(v.during ?? []).map((d) => d.action)];
    if (all.some((a) => a.kind.endsWith("workers"))) acts.push({ kind: "start-workers" });
    if (all.some((a) => a.kind.endsWith("redis"))) acts.push({ kind: "start-redis" });
    // the API keeps the last non-empty registry set, so leave it listing every worker
    if (all.some((a) => a.kind === "registry-set")) acts.push({ kind: "registry-set", count: "all" });
    for (const a of acts) {
      try { await act(a, plan, venv); } catch (err) { log(`${testid}: restore ${describe(a)} failed: ${(err as Error).message}`); }
    }
  };

  // 3. setup actions
  try {
    for (const a of v.setup ?? []) {
      log(`${testid}: setup ${describe(a)}`);
      await act(a, plan, venv);
    }
  } catch (err) {
    log(`${testid}: setup failed: ${(err as Error).message}`);
    await restore();
    return finish("setup-failed", { setup_error: (err as Error).message });
  }

  // 4. the measured run, with timed actions on the side
  const start = Date.now() / 1000;
  meta.started_at = new Date().toISOString();
  log(`${testid}: ${v.scenario} ${Object.entries(str(v.k6)).map(([k, val]) => `${k}=${val}`).join(" ")}`);
  let running = true;
  const events: { at: number; action: string; ok: boolean; took_s: number; error?: string }[] = [];
  const timeline = (async () => {
    for (const d of [...(v.during ?? [])].sort((a, b) => a.at - b.at)) {
      const wait = start + d.at - Date.now() / 1000;
      if (wait > 0 && !dryRun) await new Promise((r) => setTimeout(r, wait * 1000));
      if (!running && !dryRun) return; // the run ended early (breakpoint abort)
      const t0 = Date.now() / 1000;
      log(`${testid}: t+${(t0 - start).toFixed(0)}s ${describe(d.action)}`);
      try {
        await act(d.action, plan, venv);
        events.push({ at: t0 - start, action: describe(d.action), ok: true, took_s: Date.now() / 1000 - t0 });
      } catch (err) {
        events.push({ at: t0 - start, action: describe(d.action), ok: false, took_s: Date.now() / 1000 - t0, error: (err as Error).message });
      }
    }
  })();
  const kcode = await run(join(deployDir, "k6.sh"), [v.scenario], { ...str(v.k6), TESTID: testid, RESULT_DIR: dir }, join(dir, "k6.log"));
  running = false;
  await timeline;
  const end = Date.now() / 1000;
  meta.ended_at = new Date().toISOString();
  await restore();

  // 5. evidence
  if (!dryRun) {
    try { meta.prom_series = await snapshot(plan, testid, start - 15, end + 15, dir); } catch (err) { meta.prom_error = (err as Error).message; }
    await collectLogs(plan, start - 15, end + 15, dir);
  } else {
    console.log(`    snapshot ${Object.keys(snapshotQueries(testid)).length} Prometheus series + logs of ${plan.hosts.length} hosts`);
  }
  // k6 exits 99 when a threshold fails: an expected outcome (breakpoint, overload), not a broken run
  const ok = kcode === 0 || (kcode === 99 && (dryRun || existsSync(join(dir, "summary.json"))));
  log(`${testid}: k6 exit ${kcode}${kcode === 99 ? " (thresholds crossed)" : ""}`);
  return finish(ok ? "ok" : "k6-failed", { k6_exit: kcode, thresholds_passed: kcode === 0, events, duration_s: end - start });
}

function fakePlan(): Plan {
  const hosts = Array.from({ length: 10 }, (_, i) => ({ name: `node${String(i + 1).padStart(2, "0")}`, public_ip: `203.0.113.${i + 1}`,
    private_ip: `10.40.1.${i + 1}`, roles: i < 8 ? ["worker"] : i === 8 ? ["api", "nginx"] : ["redis", "monitoring"] }));
  const workers = ["a", "b"].flatMap((s, j) => hosts.slice(0, 8).map((h) => ({ id: `${h.name}${s}`, host: h.name,
    url: `http://${h.private_ip}:${7070 + j * 10}`, admin: `http://${h.private_ip}:${7071 + j * 10}` })));
  return { variant: "dry-run", git_commit: "dry-run", instance_type: "m6i.large", region: "dry-run", image_tag: "dry-run", hosts, workers,
    monitoring: { host: "node10", public_ip: "203.0.113.10" } };
}

// ---------- main ----------

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "list") {
    for (const e of EXPERIMENTS) {
      const params = Object.entries(e.params ?? {}).map(([k, v]) => (v === null ? `${k}=<required>` : `${k}=${v}`)).join(" ");
      console.log(`${e.id.padEnd(4)} ${e.title}${e.unsupported ? `  [not runnable: ${e.unsupported}]` : ""}\n     ${e.question}` +
        (params ? `\n     params: ${params}` : ""));
    }
    return;
  }
  const o = parsed;
  dryRun = o.dryRun;
  const variants = expand(o);
  const e = o.experiment;
  const planned = variants.map((v) => ({ v, repeats: o.repeats ?? v.repeats ?? e.repeats ?? 3 }));
  log(`${e.id} ${e.title}: ${planned.map((p) => `${p.v.name}×${p.repeats}`).join(", ")}${dryRun ? " (dry run)" : ""}`);
  if (!dryRun) {
    mkdirSync(join(resultsRoot, e.id), { recursive: true });
    writeFileSync(join(resultsRoot, e.id, "experiment.json"), JSON.stringify({
      id: e.id, title: e.title, question: e.question, base: e.base ?? "baseline", params: o.params,
      overrides: { deploy: o.deploy, k6: o.k6 }, variants,
    }, null, 2) + "\n");
  }
  const pulled = { done: false };
  const failed: string[] = [];
  for (const { v, repeats } of planned) {
    for (let r = 1; r <= repeats; r++) {
      const metaFile = join(resultsRoot, e.id, v.name, `r${r}`, "meta.json");
      if (!o.force && existsSync(metaFile) && JSON.parse(readFileSync(metaFile, "utf8")).status === "ok") {
        log(`${e.id}/${v.name}/r${r}: already done (--force redoes it)`);
        continue;
      }
      const status = await runRepeat(o, v, r, pulled);
      if (status === "deploy-failed") {
        log(`${e.id}/${v.name}/r${r}: deploy failed, see ${join("loadtest/results", e.id, v.name, `r${r}`, "deploy.log")}; stopping`);
        process.exit(1);
      }
      if (status !== "ok") {
        failed.push(`${v.name}/r${r} (${status})`);
        if (status === "smoke-failed") break; // the variant is broken; the next one may not be
      }
    }
  }
  log(failed.length ? `done with failures: ${failed.join(", ")}` : `done: loadtest/results/${e.id}/`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(2);
  });
}
