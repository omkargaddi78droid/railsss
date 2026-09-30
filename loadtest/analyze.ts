// Analysis of the experiment results written by loadtest/run.ts (Step 7 of docs/scaling-plan.md).
//
//   node loadtest/analyze.ts [--results loadtest/results] [--out docs/load-test] [E1 E8 …]
//
// Reads results/<EXP>/<variant>/r<n>/{meta.json, summary.json, prom/*.json} and writes, into --out:
//   results.md          per experiment: question, tables, figures (regenerated on every run)
//   summary-table.csv   one row per experiment × variant
//   *.svg               charts (no dependencies; they follow the light/dark colour scheme of the viewer)
// The methods are the ones in docs/analysis-llm-prompt.md section 4, so this script and the external
// analysis agree. Missing experiments, repeats or series are skipped with a note; nothing here throws on them.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENTS } from "./experiments.ts";

export const SLO = { p99Ms: 500, errorRate: 0.001 };
const WARMUP_S = 30;
const STEP_S = 5;

// ---------------------------------------------------------------- statistics

export function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const mean = (xs: number[]) => { const s = xs.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN; };
const minOf = (xs: number[]) => { const s = xs.filter(Number.isFinite); return s.length ? Math.min(...s) : NaN; };
const maxOf = (xs: number[]) => { const s = xs.filter(Number.isFinite); return s.length ? Math.max(...s) : NaN; };

export interface Spread { median: number; min: number; max: number; cv: number; n: number }
export function spread(xs: number[]): Spread {
  const s = xs.filter(Number.isFinite);
  const m = mean(s);
  const sd = s.length > 1 ? Math.sqrt(s.reduce((a, x) => a + (x - m) ** 2, 0) / (s.length - 1)) : 0;
  return { median: median(s), min: minOf(s), max: maxOf(s), cv: m ? sd / m : NaN, n: s.length };
}

// ---------------------------------------------------------------- Prometheus snapshots

export interface Series { labels: Record<string, string>; points: Map<number, number> }

// A prom/<name>.json file as saved by run.ts: {query, start, end, step, response: <Prometheus API answer>}.
export function parseMatrix(file: unknown): Series[] {
  const result = (file as { response?: { data?: { result?: unknown } } })?.response?.data?.result;
  if (!Array.isArray(result)) return [];
  return result.map((r: { metric?: Record<string, string>; values?: [number, string][] }) => ({
    labels: r.metric ?? {},
    points: new Map((r.values ?? []).map(([t, v]) => [Number(t), Number(v)])),
  }));
}

// Sum of the series that pass `keep`, per timestamp. NaN samples are ignored.
export function sumSeries(list: Series[], keep: (labels: Record<string, string>) => boolean = () => true): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of list) {
    if (!keep(s.labels)) continue;
    for (const [t, v] of s.points) if (Number.isFinite(v)) out.set(t, (out.get(t) ?? 0) + v);
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

// Increase of a cumulative counter over its samples. A drop means the process restarted: count from 0 again.
export function counterDelta(points: Map<number, number>, from = -Infinity, to = Infinity): number {
  let total = 0;
  let prev: number | null = null;
  for (const [t, v] of [...points].sort((a, b) => a[0] - b[0])) {
    if (t < from || t > to || !Number.isFinite(v)) continue;
    if (prev !== null) total += v >= prev ? v - prev : v;
    prev = v;
  }
  return total;
}

const meanIn = (m: Map<number, number>, from: number, to: number) => mean([...m].filter(([t]) => t >= from && t <= to).map(([, v]) => v));

// ---------------------------------------------------------------- capacity (breakpoint runs)

export interface Step { t: number; rps: number; p99Ms: number; err: number }
export interface Capacity { rps: number; broke: boolean; brokeAt: number | null; reason: string }

// Max RPS within the SLO: the highest achieved RPS before the SLO is broken for two consecutive steps.
// `steps` must already exclude the warm-up. When the SLO is never broken, `broke` is false and the value
// is a lower bound (or the rate at which k6 itself aborted the run).
export function capacityOf(steps: Step[]): Capacity {
  const bad = (s: Step) => (Number.isFinite(s.p99Ms) && s.p99Ms >= SLO.p99Ms) || s.err > SLO.errorRate;
  let end = steps.length;
  let reason = "";
  for (let i = 0; i + 1 < steps.length; i++) {
    if (bad(steps[i]) && bad(steps[i + 1])) {
      end = i;
      reason = steps[i].err > SLO.errorRate ? "errors" : "p99";
      break;
    }
  }
  const ok = steps.slice(0, end).filter((s) => !bad(s));
  return { rps: ok.length ? Math.max(...ok.map((s) => s.rps)) : NaN, broke: end < steps.length, brokeAt: end < steps.length ? steps[end].t : null, reason };
}

// ---------------------------------------------------------------- Universal Scalability Law

export interface Usl { lambda: number; sigma: number; kappa: number; r2: number; peakN: number }
const uslShape = (n: number, sigma: number, kappa: number) => n / (1 + sigma * (n - 1) + kappa * n * (n - 1));
export const uslAt = (u: Usl, n: number) => u.lambda * uslShape(n, u.sigma, u.kappa);

// X(N) = λN / (1 + σ(N−1) + κN(N−1)): grid over σ, κ ≥ 0 with the least-squares λ in closed form.
export function fitUsl(points: [number, number][]): Usl | null {
  const pts = points.filter(([n, x]) => n > 0 && Number.isFinite(x));
  if (pts.length < 3) return null;
  let best: Usl | null = null;
  let bestSse = Infinity;
  const tryFit = (sigma: number, kappa: number) => {
    let sxf = 0, sff = 0;
    for (const [n, x] of pts) { const f = uslShape(n, sigma, kappa); sxf += x * f; sff += f * f; }
    const lambda = sxf / sff;
    let sse = 0;
    for (const [n, x] of pts) sse += (x - lambda * uslShape(n, sigma, kappa)) ** 2;
    if (sse < bestSse) { bestSse = sse; best = { lambda, sigma, kappa, r2: 0, peakN: 0 }; }
  };
  for (let s = 0; s <= 1.0001; s += 0.005) for (let k = 0; k <= 0.0501; k += 0.0005) tryFit(s, k);
  const coarse = best as Usl | null;
  if (!coarse) return null;
  for (let s = Math.max(0, coarse.sigma - 0.005); s <= coarse.sigma + 0.005; s += 0.0002) {
    for (let k = Math.max(0, coarse.kappa - 0.0005); k <= coarse.kappa + 0.0005; k += 0.00002) tryFit(s, k);
  }
  const fit = best as unknown as Usl;
  const my = mean(pts.map(([, x]) => x));
  const sst = pts.reduce((a, [, x]) => a + (x - my) ** 2, 0);
  fit.r2 = sst ? 1 - bestSse / sst : 1;
  fit.peakN = fit.kappa > 0 ? Math.sqrt((1 - fit.sigma) / fit.kappa) : Infinity;
  return fit;
}

// ---------------------------------------------------------------- M/M/c

// Erlang C: probability that an arrival waits, for c servers and offered load a = λ/μ (needs a < c).
export function erlangC(c: number, a: number): number {
  if (a >= c) return 1;
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const rho = a / c;
  return b / (1 - rho * (1 - b));
}
// Mean response time (same unit as the service time) of an M/M/c queue.
export function mmcResponse(c: number, lambda: number, serviceTime: number): number {
  const a = lambda * serviceTime;
  if (a >= c) return Infinity;
  return serviceTime + (erlangC(c, a) * serviceTime) / (c - a);
}

// ---------------------------------------------------------------- loading results

type Json = Record<string, any>;
interface Run { exp: string; variant: string; rep: number; dir: string; meta: Json; summary: Json | null }

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const readJson = (p: string): Json | null => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const seriesCache = new Map<string, Series[]>();
function series(run: Run, name: string): Series[] {
  const p = join(run.dir, "prom", `${name}.json`);
  if (!seriesCache.has(p)) seriesCache.set(p, parseMatrix(readJson(p)));
  return seriesCache.get(p)!;
}
const t0 = (run: Run) => Date.parse(run.meta.started_at) / 1000;
const t1 = (run: Run) => Date.parse(run.meta.ended_at) / 1000;

function loadRuns(results: string, only: string[]): { runs: Run[]; skipped: string[] } {
  const runs: Run[] = [];
  const skipped: string[] = [];
  if (!isDir(results)) return { runs, skipped };
  for (const exp of readdirSync(results).filter((d) => /^E\d+$/.test(d) && isDir(join(results, d)))) {
    if (only.length && !only.includes(exp)) continue;
    for (const variant of readdirSync(join(results, exp)).filter((d) => isDir(join(results, exp, d)))) {
      for (const r of readdirSync(join(results, exp, variant)).filter((d) => /^r\d+$/.test(d))) {
        const dir = join(results, exp, variant, r);
        const meta = readJson(join(dir, "meta.json"));
        const summary = readJson(join(dir, "summary.json"));
        const id = `${exp}/${variant}/${r}`;
        if (!meta) { skipped.push(`${id}: no meta.json`); continue; }
        if (meta.status !== "ok") { skipped.push(`${id}: status ${meta.status}`); continue; }
        if (!summary?.metrics) { skipped.push(`${id}: no summary.json`); continue; }
        runs.push({ exp, variant, rep: Number(r.slice(1)), dir, meta, summary });
      }
    }
  }
  return { runs, skipped };
}

// ---------------------------------------------------------------- per-run measures

interface Measures {
  rps: number; p50: number; p90: number; p99: number; p999: number; max: number; meanMs: number; err: number;
  cacheHit: number; complete: number; overloadShare: number; goodput: number; engineMeanMs: number; engineP99: number;
  bytesPerReq: number; apiCpu: number; engineCpu: number; nginxCpu: number;
  capacity: Capacity | null; steps: Step[];
  engineCalls: number; cache: Record<string, number>; pool: Record<string, number>;
}

function stepsOf(run: Run): Step[] {
  const k6 = series(run, "k6_rps");
  const all = sumSeries(k6);
  const okRps = sumSeries(k6, (l) => /^2/.test(l.status ?? ""));
  const p99 = sumSeries(series(run, "api_latency_p99"));
  const from = t0(run) + WARMUP_S;
  return [...all].filter(([t]) => t >= from).map(([t, rps]) => ({
    t, rps, p99Ms: p99.has(t) ? p99.get(t)! * 1000 : NaN, err: rps > 0 ? 1 - (okRps.get(t) ?? 0) / rps : 0,
  }));
}

function cpu(run: Run, re: RegExp, from: number, to: number): number {
  return meanIn(sumSeries(series(run, "container_cpu"), (l) => re.test(l.name ?? "")), from, to);
}

function deltasBy(run: Run, name: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of series(run, name)) {
    const key = s.labels[label] ?? "all";
    out[key] = (out[key] ?? 0) + counterDelta(s.points, t0(run), t1(run));
  }
  return out;
}

function measure(run: Run): Measures {
  const m = run.summary!.metrics as Json;
  const d = m.http_req_duration ?? {};
  const reqs = m.http_reqs?.count ?? 0;
  const err = m.http_req_failed?.value ?? NaN;
  const steps = stepsOf(run);
  const capacity = run.meta.scenario === "breakpoint" ? capacityOf(steps) : null;
  // CPU: for a breakpoint run, the 30 s before the knee; otherwise the whole run after the warm-up.
  const knee = capacity ? (capacity.brokeAt ?? steps.find((s) => s.rps === capacity.rps)?.t ?? t1(run)) : t1(run);
  const from = capacity ? knee - 30 : t0(run) + WARMUP_S;
  return {
    rps: m.http_reqs?.rate ?? NaN, p50: d.med, p90: d["p(90)"], p99: d["p(99)"], p999: d["p(99.9)"], max: d.max, meanMs: d.avg, err,
    cacheHit: m.route_cache_hit?.value ?? NaN, complete: m.route_search_complete?.value ?? NaN,
    overloadShare: reqs ? (m.route_overloaded?.count ?? 0) / reqs : NaN,
    goodput: (m.http_reqs?.rate ?? NaN) * (1 - (Number.isFinite(err) ? err : 0)),
    engineMeanMs: m.route_engine_ms?.avg ?? NaN, engineP99: m.route_engine_ms?.["p(99)"] ?? NaN,
    bytesPerReq: reqs ? (m.data_received?.count ?? NaN) / reqs : NaN,
    apiCpu: cpu(run, /-api(-|$)/, from, knee), engineCpu: cpu(run, /-engine/, from, knee), nginxCpu: cpu(run, /-nginx$/, from, knee),
    capacity, steps,
    engineCalls: Object.values(deltasBy(run, "engine_requests", "worker")).reduce((a, b) => a + b, 0),
    cache: deltasBy(run, "api_cache_events", "outcome"), pool: deltasBy(run, "api_pool_events", "event"),
  };
}

// ---------------------------------------------------------------- SVG charts

const PALETTE = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"] },
  dark: { surface: "#1a1a19", ink: "#ffffff", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] },
  critical: "#d03b3b",
};
const MAX_SERIES = PALETTE.light.series.length;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const vars = (p: typeof PALETTE.light) =>
  `--surface:${p.surface};--ink:${p.ink};--ink2:${p.ink2};--muted:${p.muted};--grid:${p.grid};--axis:${p.axis};` +
  p.series.map((c, i) => `--s${i + 1}:${c}`).join(";");
const STYLE = `<style>:root{${vars(PALETTE.light)};--crit:${PALETTE.critical}}` +
  `@media (prefers-color-scheme:dark){:root{${vars(PALETTE.dark)}}}` +
  `text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px;fill:var(--ink2)}` +
  `.title{font-size:15px;font-weight:600;fill:var(--ink)}.sub{fill:var(--muted)}.tick{fill:var(--muted);font-variant-numeric:tabular-nums}` +
  `.val{fill:var(--ink);font-variant-numeric:tabular-nums}</style>`;

export function niceTicks(max: number, count = 5): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}
const fmt = (v: number, digits = 1) => !Number.isFinite(v) ? "–" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : Number(v.toFixed(digits)).toString();

interface Line { name: string; points: [number, number][]; band?: [number, number, number][]; dots?: boolean; whiskers?: [number, number, number][]; reference?: boolean }
interface LineChart {
  title: string; subtitle?: string; xLabel: string; yLabel: string; lines: Line[];
  slo?: number; vlines?: { x: number; label: string }[]; yMax?: number; xMax?: number; xMin?: number;
}

export function lineChart(c: LineChart): string {
  const W = 760, H = 420, L = 64, R = 24, T = c.lines.length > 1 ? 86 : 62, B = 50;
  const xs = c.lines.flatMap((l) => l.points.map((p) => p[0]));
  const ys = c.lines.flatMap((l) => [...l.points.map((p) => p[1]), ...(l.band ?? []).map((b) => b[2]), ...(l.whiskers ?? []).map((w) => w[2])]).filter(Number.isFinite);
  const xMin = c.xMin ?? Math.min(0, minOf(xs));
  const xTicks = niceTicks((c.xMax ?? maxOf(xs)) - xMin).map((t) => t + xMin);
  const dataMax = Math.max(maxOf(ys) || 1, c.slo ? c.slo * 1.1 : 0);
  const yTicks = niceTicks(c.yMax ? Math.min(c.yMax, dataMax) : dataMax);
  const xHi = xTicks[xTicks.length - 1], yHi = yTicks[yTicks.length - 1];
  const px = (x: number) => L + ((x - xMin) / (xHi - xMin || 1)) * (W - L - R);
  const py = (y: number) => H - B - (Math.min(y, yHi) / yHi) * (H - T - B);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(c.title)}">`,
    STYLE, `<rect width="${W}" height="${H}" fill="var(--surface)"/>`, `<text class="title" x="${L}" y="26">${esc(c.title)}</text>`];
  if (c.subtitle) out.push(`<text class="sub" x="${L}" y="44">${esc(c.subtitle)}</text>`);
  for (const t of yTicks) {
    out.push(`<line x1="${L}" x2="${W - R}" y1="${py(t)}" y2="${py(t)}" stroke="var(${t === 0 ? "--axis" : "--grid"})"/>`,
      `<text class="tick" x="${L - 8}" y="${py(t) + 4}" text-anchor="end">${fmt(t)}</text>`);
  }
  for (const t of xTicks) out.push(`<text class="tick" x="${px(t)}" y="${H - B + 18}" text-anchor="middle">${fmt(t)}</text>`);
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle">${esc(c.xLabel)}</text>`,
    `<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${esc(c.yLabel)}</text>`);
  if (c.slo && c.slo <= yHi) {
    out.push(`<line x1="${L}" x2="${W - R}" y1="${py(c.slo)}" y2="${py(c.slo)}" stroke="var(--crit)" stroke-width="1.5"/>`,
      `<text x="${W - R}" y="${py(c.slo) - 6}" text-anchor="end">SLO ${fmt(c.slo)} ms</text>`);
  }
  for (const v of c.vlines ?? []) {
    out.push(`<line x1="${px(v.x)}" x2="${px(v.x)}" y1="${T}" y2="${H - B}" stroke="var(--muted)"/>`,
      `<text x="${px(v.x) + 5}" y="${T + 12}">${esc(v.label)}</text>`);
  }
  let colour = 0;
  const legend: { name: string; stroke: string }[] = [];
  for (const l of c.lines) {
    const stroke = l.reference ? "var(--muted)" : `var(--s${(colour++ % MAX_SERIES) + 1})`;
    legend.push({ name: l.name, stroke });
    const pts = l.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (l.band?.length) {
      const up = l.band.map((b) => `${px(b[0]).toFixed(1)},${py(b[2]).toFixed(1)}`);
      const down = [...l.band].reverse().map((b) => `${px(b[0]).toFixed(1)},${py(b[1]).toFixed(1)}`);
      out.push(`<polygon points="${[...up, ...down].join(" ")}" fill="${stroke}" opacity="0.1"/>`);
    }
    for (const w of l.whiskers ?? []) out.push(`<line x1="${px(w[0])}" x2="${px(w[0])}" y1="${py(w[1])}" y2="${py(w[2])}" stroke="var(--ink2)" stroke-width="1.5"/>`);
    if (!l.dots && pts.length > 1) {
      out.push(`<path d="M${pts.map((p) => `${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)}`).join("L")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>${esc(l.name)}</title></path>`);
    }
    for (const p of l.dots ? pts : pts.slice(-1)) {
      out.push(`<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="4" fill="${stroke}" stroke="var(--surface)" stroke-width="2"><title>${esc(`${l.name}: ${fmt(p[1])} at ${fmt(p[0])}`)}</title></circle>`);
    }
  }
  if (legend.length > 1) {
    let x = L;
    for (const g of legend) {
      out.push(`<line x1="${x}" x2="${x + 16}" y1="62" y2="62" stroke="${g.stroke}" stroke-width="3" stroke-linecap="round"/>`, `<text x="${x + 22}" y="66">${esc(g.name)}</text>`);
      x += 34 + g.name.length * 6.6;
    }
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}

interface Bar { label: string; value: number; min?: number; max?: number }
// Horizontal bars, one measure, one colour: the label on the left names each bar.
export function barChart(c: { title: string; subtitle?: string; xLabel: string; bars: Bar[]; slo?: number; digits?: number }): string {
  const bars = c.bars.filter((b) => Number.isFinite(b.value));
  const L = 40 + Math.max(...bars.map((b) => b.label.length), 4) * 6.8, R = 70, T = 62, ROW = 30, B = 46, W = 760;
  const H = T + bars.length * ROW + B;
  const ticks = niceTicks(Math.max(maxOf(bars.map((b) => b.max ?? b.value)) || 1, c.slo ? c.slo * 1.1 : 0));
  const hi = ticks[ticks.length - 1];
  const px = (v: number) => L + (Math.min(v, hi) / hi) * (W - L - R);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(c.title)}">`,
    STYLE, `<rect width="${W}" height="${H}" fill="var(--surface)"/>`, `<text class="title" x="16" y="26">${esc(c.title)}</text>`];
  if (c.subtitle) out.push(`<text class="sub" x="16" y="44">${esc(c.subtitle)}</text>`);
  for (const t of ticks) {
    out.push(`<line x1="${px(t)}" x2="${px(t)}" y1="${T - 6}" y2="${H - B}" stroke="var(${t === 0 ? "--axis" : "--grid"})"/>`,
      `<text class="tick" x="${px(t)}" y="${H - B + 18}" text-anchor="middle">${fmt(t)}</text>`);
  }
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">${esc(c.xLabel)}</text>`);
  bars.forEach((b, i) => {
    const y = T + i * ROW + 4, h = 16, w = Math.max(px(b.value) - L, 1), r = Math.min(4, w);
    out.push(`<text x="${L - 10}" y="${y + 12}" text-anchor="end">${esc(b.label)}</text>`,
      `<path d="M${L} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - r}z" fill="var(--s1)"><title>${esc(`${b.label}: ${fmt(b.value, c.digits)}`)}</title></path>`);
    let tip = px(b.value);
    if (Number.isFinite(b.min) && Number.isFinite(b.max) && b.max! > b.min!) {
      out.push(`<line x1="${px(b.min!)}" x2="${px(b.max!)}" y1="${y + h / 2}" y2="${y + h / 2}" stroke="var(--ink)" stroke-width="1.5"/>`);
      tip = Math.max(tip, px(b.max!));
    }
    out.push(`<text class="val" x="${tip + 8}" y="${y + 12}">${fmt(b.value, c.digits)}</text>`);
  });
  if (c.slo && c.slo <= hi) {
    out.push(`<line x1="${px(c.slo)}" x2="${px(c.slo)}" y1="${T - 6}" y2="${H - B}" stroke="var(--crit)" stroke-width="1.5"/>`,
      `<text x="${px(c.slo) + 5}" y="${T - 10}">SLO ${fmt(c.slo)} ms</text>`);
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- report building

interface VariantResult { name: string; runs: Run[]; ms: Measures[] }
interface Ctx { out: string; md: string[]; csv: string[][] }

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
const pct = (v: number, d = 1) => Number.isFinite(v) ? `${(v * 100).toFixed(d)} %` : "–";
const sp = (xs: number[], d = 0) => { const s = spread(xs); return s.n ? (s.n > 1 ? `${fmt(s.median, d)} (${fmt(s.min, d)}–${fmt(s.max, d)})` : fmt(s.median, d)) : "–"; };
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""];
const med = (v: VariantResult, f: (m: Measures) => number) => median(v.ms.map(f));
const config = (v: VariantResult) => {
  const m = v.runs[0].meta;
  const kv = (o: Json | undefined) => Object.entries(o ?? {}).map(([k, x]) => `${k}=${x}`);
  return [...kv(m.deploy_overrides), ...kv(m.k6_env)].join(" ") || "defaults";
};
function figure(ctx: Ctx, file: string, svg: string, caption: string) {
  writeFileSync(join(ctx.out, file), svg);
  ctx.md.push(`![${caption}](${file})`, "");
}

// Median p99 against achieved RPS over the repeats of one variant (the ramp up to its peak rate).
function latencyCurve(v: VariantResult, binWidth: number): { points: [number, number][]; band: [number, number, number][] } {
  const bins = new Map<number, number[]>();
  for (const m of v.ms) {
    const peak = m.steps.reduce((best, s, i) => (s.rps > m.steps[best]?.rps ? i : best), 0);
    const mine = new Map<number, number[]>();
    for (const s of m.steps.slice(0, peak + 1)) {
      if (!Number.isFinite(s.p99Ms) || !(s.rps > 0)) continue;
      const b = Math.floor(s.rps / binWidth);
      mine.set(b, [...(mine.get(b) ?? []), s.p99Ms]);
    }
    for (const [b, ys] of mine) bins.set(b, [...(bins.get(b) ?? []), mean(ys)]);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  return {
    points: keys.map((b) => [(b + 0.5) * binWidth, median(bins.get(b)!)]),
    band: keys.map((b) => [(b + 0.5) * binWidth, minOf(bins.get(b)!), maxOf(bins.get(b)!)]),
  };
}

function breakpointSection(ctx: Ctx, exp: string, vs: VariantResult[]) {
  const cap = (v: VariantResult) => v.ms.map((m) => m.capacity?.rps ?? NaN);
  ctx.md.push(...table(
    ["Variant", "Config", "Repeats", "Max RPS within SLO, median (min–max)", "Spread (CV)", "SLO broken by", "API CPU", "Engine CPU (sum)", "nginx CPU", "Truncated searches"],
    vs.map((v) => {
      const s = spread(cap(v));
      const reasons = [...new Set(v.ms.map((m, i) => m.capacity?.broke ? m.capacity.reason : v.runs[i].meta.k6_exit === 99 ? "k6 abort" : "never (lower bound)"))];
      const lowerBound = v.ms.every((m, i) => !m.capacity?.broke && v.runs[i].meta.k6_exit !== 99);
      return [v.name, `\`${config(v)}\``, String(v.ms.length), (lowerBound ? "≥ " : "") + sp(cap(v)), pct(s.cv) + (s.cv > 0.1 ? " ⚠" : ""), reasons.join(", "),
        fmt(med(v, (m) => m.apiCpu), 2), fmt(med(v, (m) => m.engineCpu), 2), fmt(med(v, (m) => m.nginxCpu), 2), pct(1 - med(v, (m) => m.complete))];
    })));
  ctx.md.push("CPU is in cores, averaged over the 30 s before the knee. \"k6 abort\" means k6 stopped the ramp on its own " +
    "client-side threshold before two server-side steps broke the SLO; the value is the highest rate reached within the SLO.", "");
  figure(ctx, `${exp}-capacity.svg`, barChart({
    title: `${exp}: maximum RPS within the SLO`, subtitle: "Median of the repeats; the line spans min–max", xLabel: "requests per second",
    bars: vs.map((v) => { const s = spread(cap(v)); return { label: v.name, value: s.median, min: s.min, max: s.max }; }),
  }), `${exp} capacity by variant`);
  const top = maxOf(vs.flatMap((v) => v.ms.flatMap((m) => m.steps.map((s) => s.rps))));
  const shown = vs.slice(0, MAX_SERIES);
  figure(ctx, `${exp}-latency-vs-load.svg`, lineChart({
    title: `${exp}: p99 latency against load`, subtitle: "API p99 over 30 s windows during the ramp; band = min–max over repeats",
    xLabel: "achieved requests per second", yLabel: "p99 latency (ms)", slo: SLO.p99Ms, yMax: SLO.p99Ms * 2,
    lines: shown.map((v) => ({ name: v.name, ...latencyCurve(v, Math.max(top / 30, 1)) })),
  }), `${exp} p99 latency against load`);
  if (vs.length > shown.length) ctx.md.push(`The latency chart shows the first ${MAX_SERIES} variants; the table has all of them.`, "");
}

function loadSection(ctx: Ctx, exp: string, vs: VariantResult[]) {
  ctx.md.push(...table(
    ["Variant", "Config", "Repeats", "RPS", "p50 ms", "p99 ms", "p99.9 ms", "max ms", "Errors", "429 share", "Cache hits", "Engine calls", "API CPU", "Engine CPU"],
    vs.map((v) => [v.name, `\`${config(v)}\``, String(v.ms.length), sp(v.ms.map((m) => m.rps)), sp(v.ms.map((m) => m.p50)), sp(v.ms.map((m) => m.p99)),
      sp(v.ms.map((m) => m.p999)), sp(v.ms.map((m) => m.max)), pct(med(v, (m) => m.err), 2), pct(med(v, (m) => m.overloadShare), 2),
      pct(med(v, (m) => m.cacheHit)), fmt(med(v, (m) => m.engineCalls), 0), fmt(med(v, (m) => m.apiCpu), 2), fmt(med(v, (m) => m.engineCpu), 2)])));
  const events = [...new Set(vs.flatMap((v) => v.ms.flatMap((m) => [...Object.keys(m.pool).map((k) => `pool:${k}`), ...Object.keys(m.cache).map((k) => `cache:${k}`)])))].sort();
  if (events.length) {
    ctx.md.push("Pool and cache events during the run (median count over repeats):", "",
      ...table(["Variant", ...events], vs.map((v) => [v.name, ...events.map((e) => {
        const [kind, key] = e.split(":");
        return fmt(med(v, (m) => (kind === "pool" ? m.pool : m.cache)[key] ?? 0), 0);
      })])));
  }
  const bar = (f: (m: Measures) => number) => vs.map((v) => { const s = spread(v.ms.map(f)); return { label: v.name, value: s.median, min: s.min, max: s.max }; });
  figure(ctx, `${exp}-p99.svg`, barChart({ title: `${exp}: client p99 latency`, subtitle: "Whole run, median of the repeats; the line spans min–max",
    xLabel: "p99 latency (ms)", bars: bar((m) => m.p99), slo: SLO.p99Ms }), `${exp} p99 by variant`);
  if (exp === "E12") {
    figure(ctx, `${exp}-goodput.svg`, barChart({ title: "E12: goodput under overload", subtitle: "Successful requests per second, median of the repeats",
      xLabel: "successful requests per second", bars: bar((m) => m.goodput) }), "E12 goodput by variant");
  }
  if (exp === "E10") {
    figure(ctx, `${exp}-cache-hit.svg`, barChart({ title: "E10: share of searches answered from Redis", subtitle: "route_cache_hit, median of the repeats",
      xLabel: "cache hit rate (%)", bars: bar((m) => m.cacheHit * 100) }), "E10 cache hit rate by variant");
  }
  if (exp === "E4" || exp === "E16") {
    figure(ctx, `${exp}-max.svg`, barChart({ title: `${exp}: worst client latency`, subtitle: "Maximum over the run, median of the repeats",
      xLabel: "max latency (ms)", bars: bar((m) => m.max) }), `${exp} max latency by variant`);
  }
}

// Fault and spike runs: what happened around the action times, from the first good repeat.
function timelineSection(ctx: Ctx, exp: string, vs: VariantResult[]) {
  const rows: string[][] = [];
  for (const v of vs) {
    const run = v.runs[0];
    const start = t0(run);
    const k6 = series(run, "k6_rps");
    const okRps = sumSeries(k6, (l) => /^2/.test(l.status ?? ""));
    const badRps = sumSeries(k6, (l) => !/^2/.test(l.status ?? ""));
    const p99 = [...sumSeries(series(run, "api_latency_p99"))].map(([t, x]) => [t - start, x * 1000] as [number, number]);
    const healthy = sumSeries(series(run, "api_worker_healthy"));
    const events = ((run.meta.events ?? []) as Json[]).map((e) => ({
      x: typeof e.at === "number" ? e.at : Date.parse(e.at) / 1000 - start,
      label: typeof e.action === "string" ? e.action : `${e.action?.kind ?? "action"}${e.action?.count ? ` ${e.action.count}` : ""}`,
    })).filter((e) => Number.isFinite(e.x));
    const rel = (m: Map<number, number>) => [...m].map(([t, x]) => [t - start, x] as [number, number]);
    const xMax = t1(run) - start;
    figure(ctx, `${exp}-${v.name}-rps.svg`, lineChart({ title: `${exp} ${v.name}: requests over time`, subtitle: "Client requests per second, 30 s windows (repeat 1)",
      xLabel: "seconds after start", yLabel: "requests per second", xMax, vlines: events,
      lines: [{ name: "successful", points: rel(okRps) }, { name: "failed or 429", points: rel(badRps) }] }), `${exp} ${v.name} requests over time`);
    figure(ctx, `${exp}-${v.name}-p99.svg`, lineChart({ title: `${exp} ${v.name}: p99 latency over time`, subtitle: "API p99 over 30 s windows (repeat 1)",
      xLabel: "seconds after start", yLabel: "p99 latency (ms)", xMax, vlines: events, slo: SLO.p99Ms, yMax: SLO.p99Ms * 4,
      lines: [{ name: "p99", points: p99 }] }), `${exp} ${v.name} p99 over time`);
    if (run.meta.scenario === "soak") {
      const mem = (re: RegExp) => rel(sumSeries(series(run, "container_memory"), (l) => re.test(l.name ?? ""))).map(([t, b]) => [t / 60, b / 1e6] as [number, number]);
      figure(ctx, `${exp}-${v.name}-memory.svg`, lineChart({ title: `${exp} ${v.name}: memory over the soak`, subtitle: "Working set, summed per tier",
        xLabel: "minutes after start", yLabel: "memory (MB)", lines: [{ name: "API", points: mem(/-api(-|$)/) }, { name: "engines", points: mem(/-engine/) }, { name: "Redis", points: mem(/-redis$/) }] }),
        `${exp} ${v.name} memory`);
    }
    // Detection: the first step after the first action where fewer workers are healthy than just before it.
    const first = events[0]?.x;
    let detect = NaN, recover = NaN;
    if (first !== undefined) {
      const before = [...healthy].filter(([t]) => t - start < first).pop()?.[1];
      const drop = [...healthy].find(([t, x]) => t - start >= first && before !== undefined && x < before);
      if (drop) detect = drop[0] - start - first;
      // Recovery: p99 back under the SLO for 30 s after it was broken.
      const after = p99.filter(([t]) => t >= first);
      const broke = after.findIndex(([, x]) => x >= SLO.p99Ms);
      if (broke < 0) recover = 0;
      else for (let i = broke; i + 6 <= after.length; i++) if (after.slice(i, i + 6).every(([, x]) => !(x >= SLO.p99Ms))) { recover = after[i][0] - first; break; }
    }
    const failed = [...badRps].reduce((a, [, x]) => a + x * STEP_S, 0);
    rows.push([v.name, events.map((e) => `${e.label} @ ${fmt(e.x, 0)} s`).join(", ") || "–", fmt(detect, 0), fmt(failed, 0), fmt(recover, 0),
      fmt(maxOf(p99.map((p) => p[1])), 0), pct(med(v, (m) => m.err), 2)]);
  }
  ctx.md.push(...table(["Variant", "Actions (repeat 1)", "Detection (s)", "Failed requests", "p99 back under SLO after (s)", "Worst windowed p99 (ms)", "Errors (median)"], rows),
    "Detection is the time from the first action until the pool reports fewer healthy workers. Failed requests integrate the non-2xx rate. " +
    "All series are sampled every 5 s over 30 s windows, so times are accurate to about ±5 s.", "");
}

function e1Section(ctx: Ctx, vs: VariantResult[]) {
  const pts = vs.map((v) => [v.runs[0].meta.workers as number, spread(v.ms.map((m) => m.capacity?.rps ?? NaN))] as [number, Spread])
    .filter(([n, s]) => n > 0 && Number.isFinite(s.median)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 3) return;
  const all = fitUsl(pts.map(([n, s]) => [n, s.median]));
  const upTo8 = fitUsl(pts.filter(([n]) => n <= 8).map(([n, s]) => [n, s.median]));
  const row = (name: string, u: Usl | null) => u ? [name, fmt(u.lambda), u.sigma.toFixed(4), u.kappa.toFixed(5), u.r2.toFixed(4), Number.isFinite(u.peakN) ? fmt(u.peakN) : "none (κ = 0)"] : [name, "–", "–", "–", "–", "too few points"];
  ctx.md.push("USL fit, X(N) = λN / (1 + σ(N − 1) + κN(N − 1)):", "",
    ...table(["Points", "λ (RPS per worker)", "σ (contention)", "κ (coherency)", "R²", "Peak N*"], [row("all", all), row("N ≤ 8 (one worker per physical core)", upTo8)]));
  const x1 = pts.find(([n]) => n === 1)?.[1].median ?? all?.lambda ?? NaN;
  ctx.md.push(...table(["Workers", "Capacity (RPS)", "Per worker", "Efficiency vs 1 worker", "Gain over previous step, per added worker"],
    pts.map(([n, s], i) => [String(n), fmt(s.median), fmt(s.median / n), pct(s.median / (n * x1)),
      i ? fmt((s.median - pts[i - 1][1].median) / (n - pts[i - 1][0])) : "–"])));
  const maxN = pts[pts.length - 1][0];
  const curve = (u: Usl) => Array.from({ length: maxN * 4 + 1 }, (_, i) => [i / 4, i ? uslAt(u, i / 4) : 0] as [number, number]);
  const lines: Line[] = [{ name: "measured (median, min–max)", dots: true, points: pts.map(([n, s]) => [n, s.median]), whiskers: pts.map(([n, s]) => [n, s.min, s.max]) }];
  if (all) lines.push({ name: "USL fit", points: curve(all) });
  lines.push({ name: "linear from 1 worker", reference: true, points: [[0, 0], [maxN, x1 * maxN]] });
  figure(ctx, "E1-usl.svg", lineChart({ title: "E1: capacity against worker count", subtitle: "Maximum RPS within the SLO; from 9 workers on, hyperthread siblings are used",
    xLabel: "workers", yLabel: "requests per second", lines }), "E1 capacity against workers with the USL fit");
  figure(ctx, "E1-efficiency.svg", lineChart({ title: "E1: efficiency per worker", subtitle: "Capacity / (workers × capacity of one worker)",
    xLabel: "workers", yLabel: "efficiency (%)", lines: [{ name: "efficiency", dots: true, points: pts.map(([n, s]) => [n, (100 * s.median) / (n * x1)]) }] }), "E1 efficiency per worker");
}

function e18Section(ctx: Ctx, vs: VariantResult[]) {
  const rows = vs.map((v) => {
    const per = v.runs.map((run, i) => {
      const from = t0(run) + WARMUP_S, to = t1(run);
      const lambda = meanIn(sumSeries(series(run, "engine_rps")), from, to);
      const s = v.ms[i].engineMeanMs / 1000;
      const c = run.meta.workers as number;
      return { lambda, l: meanIn(sumSeries(series(run, "engine_in_flight")), from, to), lw: lambda * s, rho: (lambda * s) / c,
        measured: v.ms[i].meanMs, predicted: mmcResponse(c, lambda, s) * 1000, s: s * 1000 };
    });
    const m = (f: (p: (typeof per)[number]) => number) => median(per.map(f));
    return { name: v.name, lambda: m((p) => p.lambda), l: m((p) => p.l), lw: m((p) => p.lw), rho: m((p) => p.rho), measured: m((p) => p.measured), predicted: m((p) => p.predicted), s: m((p) => p.s) };
  }).sort((a, b) => a.rho - b.rho);
  ctx.md.push(...table(["Variant", "Engine λ (RPS)", "Mean engine time S (ms)", "L measured (in flight)", "λ × S", "Utilisation ρ = λS / workers", "Mean client latency (ms)", "M/M/c prediction (ms)"],
    rows.map((r) => [r.name, fmt(r.lambda), fmt(r.s), fmt(r.l, 2), fmt(r.lw, 2), pct(r.rho), fmt(r.measured), fmt(r.predicted)])),
    "The M/M/c prediction uses c = the number of workers and the measured mean engine time; it covers the engine tier only, so the client latency also contains the API and nginx.", "");
  figure(ctx, "E18-littles-law.svg", lineChart({ title: "E18: Little's law on the engine tier", subtitle: "Measured searches in flight against arrival rate × mean engine time",
    xLabel: "λ × S (expected in flight)", yLabel: "measured in flight", lines: [{ name: "measured", dots: true, points: rows.map((r) => [r.lw, r.l]) },
      { name: "L = λS", reference: true, points: [[0, 0], [maxOf(rows.map((r) => r.lw)), maxOf(rows.map((r) => r.lw))]] }] }), "E18 Little's law");
  figure(ctx, "E18-mmc.svg", lineChart({ title: "E18: latency against utilisation", subtitle: "Mean client latency and the M/M/c prediction for the engine tier",
    xLabel: "utilisation (%)", yLabel: "mean latency (ms)", lines: [{ name: "measured", points: rows.map((r) => [r.rho * 100, r.measured]), dots: true },
      { name: "M/M/c", points: rows.filter((r) => Number.isFinite(r.predicted)).map((r) => [r.rho * 100, r.predicted]) }] }), "E18 latency against utilisation");
}

function analyze(results: string, out: string, only: string[]) {
  const { runs, skipped } = loadRuns(results, only);
  // Charts of an earlier run must not survive a run without that experiment.
  if (isDir(out)) for (const f of readdirSync(out)) if (/^E\d+.*\.svg$/.test(f)) rmSync(join(out, f));
  mkdirSync(out, { recursive: true });
  const ctx: Ctx = { out, md: [], csv: [["experiment", "variant", "scenario", "repeats_ok", "capacity_rps_median", "capacity_rps_min", "capacity_rps_max", "capacity_cv",
    "rps", "p50_ms", "p99_ms", "p999_ms", "max_ms", "error_rate", "cache_hit_rate", "search_complete_rate", "api_cpu", "engine_cpu", "nginx_cpu"]] };
  ctx.md.push("# Load-test results (generated)", "",
    `Generated by \`node loadtest/analyze.ts\` from \`${relative(resolve(out), resolve(results)) || "."}\`. Do not edit: it is rewritten on every run. ` +
    "The explanations belong in [the report](../load-test-report.md).", "",
    `SLO: p99 < ${SLO.p99Ms} ms and errors < ${SLO.errorRate * 100} % (429 counts as an error). ` +
    `Capacity of a breakpoint run = the highest achieved RPS before the SLO is broken for two consecutive ${STEP_S} s steps, ` +
    `using the API's windowed p99 and the client's status codes, after ${WARMUP_S} s of warm-up. Rates are 30 s windows, so the achieved RPS lags the ramp by a few seconds.`, "");
  ctx.md.push("## Validity", "", `${runs.length} repeats used.`, "");
  if (skipped.length) ctx.md.push("Excluded:", "", ...skipped.map((s) => `- ${s}`), "");
  const warm = runs.filter((r) => r.meta.k6_env?.WORKLOAD !== "zipf" && r.exp !== "E10" && r.exp !== "E11" && (r.summary!.metrics.route_cache_hit?.value ?? 0) > 0.02);
  if (warm.length) ctx.md.push("Cache hits above 2 % on a uniform workload (the run was not cold):", "", ...warm.map((r) => `- ${r.exp}/${r.variant}/r${r.rep}`), "");

  for (const e of EXPERIMENTS.filter((x) => !only.length || only.includes(x.id))) {
    ctx.md.push(`## ${e.id} ${e.title}`, "", e.question, "");
    if (e.unsupported) { ctx.md.push(`Not run: ${e.unsupported}.`, ""); continue; }
    const mine = runs.filter((r) => r.exp === e.id);
    if (!mine.length) { ctx.md.push("Not run yet.", ""); continue; }
    const order = (readJson(join(results, e.id, "experiment.json"))?.variants ?? []).map((v: Json) => v.name as string);
    const names = [...new Set(mine.map((r) => r.variant))].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return ia >= 0 && ib >= 0 ? ia - ib : ia >= 0 ? -1 : ib >= 0 ? 1 : natural(a, b);
    });
    const vs: VariantResult[] = names.map((name) => {
      const rs = mine.filter((r) => r.variant === name).sort((a, b) => a.rep - b.rep);
      return { name, runs: rs, ms: rs.map(measure) };
    });
    for (const scenario of [...new Set(vs.map((v) => v.runs[0].meta.scenario as string))]) {
      const group = vs.filter((v) => v.runs[0].meta.scenario === scenario);
      if (scenario === "breakpoint") breakpointSection(ctx, e.id, group);
      else if (scenario === "spike" || scenario === "soak" || group.some((v) => (v.runs[0].meta.events ?? []).length)) {
        loadSection(ctx, `${e.id}${scenario === "load" ? "" : `-${scenario}`}`, group);
        timelineSection(ctx, e.id, group);
      } else loadSection(ctx, e.id, group);
    }
    if (e.id === "E1") e1Section(ctx, vs);
    if (e.id === "E18") e18Section(ctx, vs);
    for (const v of vs) {
      const c = spread(v.ms.map((m) => m.capacity?.rps ?? NaN));
      const n = (x: number, d = 2) => Number.isFinite(x) ? x.toFixed(d) : "";
      ctx.csv.push([e.id, v.name, v.runs[0].meta.scenario, String(v.ms.length), n(c.median, 1), n(c.min, 1), n(c.max, 1), n(c.cv, 3), n(med(v, (m) => m.rps), 1),
        n(med(v, (m) => m.p50), 1), n(med(v, (m) => m.p99), 1), n(med(v, (m) => m.p999), 1), n(med(v, (m) => m.max), 1), n(med(v, (m) => m.err), 5),
        n(med(v, (m) => m.cacheHit), 4), n(med(v, (m) => m.complete), 4), n(med(v, (m) => m.apiCpu)), n(med(v, (m) => m.engineCpu)), n(med(v, (m) => m.nginxCpu))]);
    }
  }
  writeFileSync(join(out, "results.md"), ctx.md.join("\n"));
  writeFileSync(join(out, "summary-table.csv"), ctx.csv.map((r) => r.join(",")).join("\n") + "\n");
  console.log(`${join(out, "results.md")}: ${runs.length} repeats of ${new Set(runs.map((r) => r.exp)).size} experiments` + (skipped.length ? `, ${skipped.length} excluded` : ""));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? resolve(args.splice(i, 2)[1]) : def; };
  if (args.includes("--help")) {
    console.log("node loadtest/analyze.ts [--results loadtest/results] [--out docs/load-test] [E1 E8 …]");
    process.exit(0);
  }
  const results = opt("--results", join(here, "results"));
  const out = opt("--out", resolve(here, "..", "docs", "load-test"));
  analyze(results, out, args.map((a) => a.toUpperCase()));
}
