// Packs every experiment result into one zip for the analysis step (docs/experiment-runbook.md,
// docs/analysis-llm-prompt.md describe the layout).
//
//   node loadtest/pack.ts [out.zip]          default: study-results-<date>.zip in the repo root
//
// Zip layout (top folder study-results/):
//   manifest.json                 study environment, SLO, and one entry per repeat (its meta.json + path)
//   attempts.jsonl                every attempt run.ts made, failed ones included (results/manifest.jsonl)
//   environment/                  inventory.json (hosts and roles), git.txt, defaults.env, experiments.ts
//   experiments/<EXP>/            experiment.json, <variant>/r<n>/... exactly as run.ts wrote them
//   screenshots/                  loadtest/results/screenshots/ (Grafana images you saved), if present
//   notes.md                      loadtest/results/notes.md (your own observations), if present
// Ad-hoc runs (results/aws/, results/local/) are left out.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const results = join(here, "results");
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const git = (...args: string[]) => {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
};

const experiments = isDir(results) ? readdirSync(results).filter((d) => /^E\d+$/.test(d) && isDir(join(results, d))).sort(
  (a, b) => Number(a.slice(1)) - Number(b.slice(1))) : [];
if (!experiments.length) {
  console.error("no experiment results in loadtest/results/E*/ yet (run node loadtest/run.ts <EXP> first)");
  process.exit(1);
}

const runs: Record<string, unknown>[] = [];
for (const e of experiments) {
  for (const v of readdirSync(join(results, e)).filter((d) => isDir(join(results, e, d))).sort()) {
    for (const r of readdirSync(join(results, e, v)).filter((d) => /^r\d+$/.test(d)).sort()) {
      const meta = join(results, e, v, r, "meta.json");
      if (!existsSync(meta)) continue;
      runs.push({ path: `experiments/${e}/${v}/${r}`, ...JSON.parse(readFileSync(meta, "utf8")) });
    }
  }
}

const invPath = join(root, "deploy", "inventory.json");
const inv = existsSync(invPath) ? JSON.parse(readFileSync(invPath, "utf8")) : null;
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
const out = resolve(process.argv[2] ?? join(root, `study-results-${stamp}.zip`));

const stage = mkdtempSync(join(tmpdir(), "study-pack-"));
const top = join(stage, "study-results");
try {
  mkdirSync(join(top, "environment"), { recursive: true });
  writeFileSync(join(top, "manifest.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    git_commit: git("describe", "--always", "--dirty"),
    environment: inv && {
      region: inv.region, instance_type: inv.instance_type, hosts: inv.hosts.length,
      roles: Object.fromEntries(inv.hosts.map((h: { name: string; roles: string[] }) => [h.name, h.roles])),
    },
    slo: { p99_ms: 500, error_rate_max: 0.001 },
    experiments: Object.fromEntries(experiments.map((e) => {
      const mine = runs.filter((r) => r.experiment === e);
      return [e, { ok: mine.filter((r) => r.status === "ok").length, not_ok: mine.filter((r) => r.status !== "ok").length }];
    })),
    runs,
  }, null, 2) + "\n");
  if (existsSync(join(results, "manifest.jsonl"))) cpSync(join(results, "manifest.jsonl"), join(top, "attempts.jsonl"));
  if (inv) cpSync(invPath, join(top, "environment", "inventory.json"));
  writeFileSync(join(top, "environment", "git.txt"), git("log", "-1", "--format=%H%n%ad%n%s") + "\n" + git("status", "--short") + "\n");
  cpSync(join(root, "deploy", "variants", "defaults.env"), join(top, "environment", "defaults.env"));
  cpSync(join(here, "experiments.ts"), join(top, "environment", "experiments.ts"));
  for (const e of experiments) cpSync(join(results, e), join(top, "experiments", e), { recursive: true });
  if (isDir(join(results, "screenshots"))) cpSync(join(results, "screenshots"), join(top, "screenshots"), { recursive: true });
  if (existsSync(join(results, "notes.md"))) cpSync(join(results, "notes.md"), join(top, "notes.md"));
  rmSync(out, { force: true });
  execFileSync("zip", ["-q", "-r", "-9", out, "study-results"], { cwd: stage });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
const ok = runs.filter((r) => r.status === "ok").length;
console.log(`${out}: ${experiments.length} experiments, ${runs.length} repeats (${ok} ok), ${(statSync(out).size / 1e6).toFixed(1)} MB`);
