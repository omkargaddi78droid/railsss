// Offline checks of the experiment catalogue: every variant must render into a deployment of the
// default 10-host inventory and use only knobs that k6.sh forwards, so a typo fails here and not
// after the AWS hosts are up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyApiHosts, render, resolveVariant, type Inventory } from "../../deploy/render.ts";
import { EXPERIMENTS, K6_KEYS } from "../experiments.ts";
import { expand, parseArgs, snapshotQueries } from "../run.ts";

const root = join(import.meta.dirname, "..", "..");

function inventory(): Inventory {
  const hosts = Array.from({ length: 10 }, (_, i) => ({
    name: `node${String(i + 1).padStart(2, "0")}`, public_ip: `203.0.113.${i + 1}`, private_ip: `10.40.1.${i + 1}`,
    roles: (i < 8 ? ["worker"] : i === 8 ? ["api", "nginx"] : ["redis", "monitoring"]) as Inventory["hosts"][number]["roles"],
  }));
  return { region: "test", instance_type: "m6i.large", registry: "r", repositories: { engine: "r/engine", api: "r/api" }, hosts };
}

const runnable = EXPERIMENTS.filter((e) => !e.unsupported);
const required = (e: (typeof EXPERIMENTS)[number]) =>
  Object.entries(e.params ?? {}).filter(([, v]) => v === null).map(([k]) => `${k}=400`);

test("k6.sh forwards exactly K6_KEYS", () => {
  const sh = readFileSync(join(root, "deploy", "k6.sh"), "utf8");
  const list = /for v in ([^;]+); do/.exec(sh.replace(/\\\n\s*/g, " "))![1].trim().split(/\s+/);
  assert.deepEqual([...list].sort(), [...K6_KEYS].sort());
});

for (const e of runnable) {
  test(`${e.id} variants render on the default inventory`, () => {
    const o = parseArgs([e.id, ...required(e)]);
    assert.notEqual(o, "list");
    if (o === "list") return;
    const variants = expand(o);
    assert.ok(variants.length > 0);
    assert.equal(new Set(variants.map((v) => v.name)).size, variants.length, "variant names are unique");
    for (const v of variants) {
      assert.match(v.name, /^[a-z0-9_.-]+$/, "variant names are safe as directory names and TESTIDs");
      assert.ok(existsSync(join(root, "loadtest", "k6", "scenarios", `${v.scenario}.js`)), `${v.name}: scenario ${v.scenario}`);
      for (const k of Object.keys(v.k6 ?? {})) assert.ok(K6_KEYS.includes(k), `${v.name}: k6 key ${k}`);
      for (const [k, val] of Object.entries(v.k6 ?? {})) assert.ok(String(val) !== "NaN", `${v.name}: ${k} is NaN`);
      const env = resolveVariant(e.base ?? "baseline", [
        "IMAGE_TAG=test", ...Object.entries(v.deploy ?? {}).map(([k, val]) => `${k}=${val}`),
      ], join(root, "deploy", "variants"));
      const { plan } = render(inventory(), env); // throws on impossible layouts
      assert.ok(plan.workers.length > 0);
      const regActions = [...(v.setup ?? []), ...(v.during ?? []).map((d) => d.action)].filter((a) => a.kind === "registry-set");
      if (regActions.length) assert.ok(env.ENGINE_REGISTRY_KEY, `${v.name}: registry-set needs ENGINE_REGISTRY_KEY`);
    }
  });
}

test("E1 covers 1..16 workers; E8 gw2 takes one worker host away", () => {
  const w = (e: string, name: string) => {
    const o = parseArgs([e]);
    if (o === "list") throw new Error();
    const v = expand(o).find((x) => x.name === name)!;
    const env = resolveVariant("baseline", ["IMAGE_TAG=t", ...Object.entries(v.deploy ?? {}).map(([k, val]) => `${k}=${val}`)],
      join(root, "deploy", "variants"));
    return render(inventory(), env).plan;
  };
  assert.equal(w("E1", "w1").workers.length, 1);
  assert.equal(w("E1", "w16").workers.length, 16);
  const gw2 = w("E8", "gw2-cluster2");
  assert.equal(gw2.workers.length, 14);
  assert.deepEqual(gw2.api.map((a) => a.host), ["node08", "node09"]);
  assert.equal(gw2.hosts.find((h) => h.name === "node08")!.phase, 2);
});

test("applyApiHosts leaves the inventory alone when unset and rejects impossible counts", () => {
  const inv = inventory();
  assert.equal(applyApiHosts(inv, {}), inv);
  assert.equal(applyApiHosts(inv, { API_HOSTS: "1" }).hosts.filter((h) => h.roles.includes("api")).length, 1);
  assert.throws(() => applyApiHosts(inv, { API_HOSTS: "0" }), /already has 1/);
  assert.throws(() => applyApiHosts(inv, { API_HOSTS: "9" }), /no worker host/);
});

test("command line: params, k6 knobs and deploy keys are told apart", () => {
  const o = parseArgs(["e4", "CAPACITY=300", "DURATION=1m", "NODE_CLUSTER=2", "--variants", "p2c-uniform", "--repeats", "1"]);
  if (o === "list") throw new Error();
  assert.equal(o.params.CAPACITY, 300);
  assert.deepEqual(o.k6, { DURATION: "1m" });
  assert.deepEqual(o.deploy, { NODE_CLUSTER: "2" });
  const [v] = expand(o);
  assert.equal(v.name, "p2c-uniform");
  assert.equal(v.k6!.RATE, 210);
  assert.equal(v.k6!.DURATION, "1m");
  assert.equal(v.deploy!.LB_STRATEGY, "p2c");
  const s = parseArgs(["E1", "--variants", "w16", "--suffix", "best", "NODE_CLUSTER=2"]);
  if (s === "list") throw new Error();
  assert.deepEqual(expand(s).map((x) => x.name), ["w16-best"]);
  assert.throws(() => parseArgs(["E1", "--suffix", "Bad/x"]), /--suffix/);
  assert.throws(() => parseArgs(["E4"]), /needs CAPACITY/);
  assert.throws(() => parseArgs(["E1", "WORKRES=4"]), /not a param/);
  assert.throws(() => parseArgs(["E5"]), /cannot run yet/);
  assert.throws(() => expand(parseArgs(["E1", "--variants", "w3"]) as Exclude<ReturnType<typeof parseArgs>, "list">), /unknown variants/);
});

test("k6 snapshot series are filtered by the run's TESTID", () => {
  const q = snapshotQueries("e1-w4-r1");
  for (const [name, expr] of Object.entries(q)) if (name.startsWith("k6_")) assert.match(expr, /testid="e1-w4-r1"/);
});
