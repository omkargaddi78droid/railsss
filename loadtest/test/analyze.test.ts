import assert from "node:assert/strict";
import { test } from "node:test";
import { barChart, capacityOf, counterDelta, erlangC, fitUsl, lineChart, median, mmcResponse, niceTicks, parseMatrix, spread, sumSeries, uslAt } from "../analyze.ts";
import type { Step } from "../analyze.ts";

const ramp = (p99: (rps: number) => number, err: (rps: number) => number = () => 0): Step[] =>
  Array.from({ length: 40 }, (_, i) => ({ t: i * 5, rps: 10 * (i + 1), p99Ms: p99(10 * (i + 1)), err: err(10 * (i + 1)) }));

test("median and spread", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
  const s = spread([90, 100, 110, NaN]);
  assert.deepEqual([s.median, s.min, s.max, s.n], [100, 90, 110, 3]);
  assert.ok(Math.abs(s.cv - 0.1) < 1e-9);
});

test("parseMatrix reads a saved Prometheus answer and sumSeries ignores NaN", () => {
  const file = { response: { data: { result: [
    { metric: { status: "200" }, values: [[10, "1.5"], [15, "NaN"], [20, "3"]] },
    { metric: { status: "429" }, values: [[10, "0.5"], [20, "1"]] },
  ] } } };
  const list = parseMatrix(file);
  assert.equal(list.length, 2);
  assert.deepEqual([...sumSeries(list)], [[10, 2], [20, 4]]);
  assert.deepEqual([...sumSeries(list, (l) => l.status === "200")], [[10, 1.5], [20, 3]]);
  assert.deepEqual(parseMatrix(null), []);
  assert.deepEqual(parseMatrix({ response: { status: "error" } }), []);
});

test("counterDelta treats a drop as a restart", () => {
  assert.equal(counterDelta(new Map([[0, 100], [5, 130], [10, 150]])), 50);
  assert.equal(counterDelta(new Map([[0, 100], [5, 130], [10, 20], [15, 45]])), 30 + 20 + 25);
  assert.equal(counterDelta(new Map([[0, 100], [5, 130], [10, 150]]), 5, 10), 20);
  assert.equal(counterDelta(new Map()), 0);
});

test("capacity is the highest rate before two consecutive steps break the SLO", () => {
  const c = capacityOf(ramp((rps) => (rps > 250 ? 800 : 100)));
  assert.deepEqual([c.rps, c.broke, c.reason], [250, true, "p99"]);
});

test("a single bad step does not end the run, and is not counted as capacity", () => {
  const c = capacityOf(ramp((rps) => (rps === 100 || rps > 300 ? 900 : 100)));
  assert.equal(c.rps, 300);
});

test("errors break the SLO too, and NaN latency does not", () => {
  const c = capacityOf(ramp(() => NaN, (rps) => (rps > 200 ? 0.05 : 0)));
  assert.deepEqual([c.rps, c.broke, c.reason], [200, true, "errors"]);
});

test("a run that never breaks the SLO gives a lower bound", () => {
  const c = capacityOf(ramp(() => 100));
  assert.deepEqual([c.rps, c.broke, c.brokeAt], [400, false, null]);
  assert.ok(Number.isNaN(capacityOf([]).rps));
});

test("the USL fit recovers known parameters", () => {
  const truth = { lambda: 40, sigma: 0.06, kappa: 0.002, r2: 1, peakN: 0 };
  const fit = fitUsl([1, 2, 4, 8, 12, 16].map((n) => [n, uslAt(truth, n)]))!;
  assert.ok(Math.abs(fit.lambda - 40) < 0.5, `lambda ${fit.lambda}`);
  assert.ok(Math.abs(fit.sigma - 0.06) < 0.005, `sigma ${fit.sigma}`);
  assert.ok(Math.abs(fit.kappa - 0.002) < 0.0003, `kappa ${fit.kappa}`);
  assert.ok(fit.r2 > 0.9999);
  assert.ok(Math.abs(fit.peakN - Math.sqrt(0.94 / 0.002)) < 2);
  assert.equal(fitUsl([[1, 10], [2, 20]]), null);
});

test("linear scaling fits with no contention and no peak", () => {
  const fit = fitUsl([1, 2, 4, 8].map((n) => [n, 30 * n]))!;
  assert.ok(fit.sigma < 0.001 && fit.kappa < 0.00005);
  assert.ok(fit.peakN > 100);
});

test("Erlang C reference values", () => {
  assert.ok(Math.abs(erlangC(1, 0.5) - 0.5) < 1e-12); // M/M/1: P(wait) = ρ
  assert.ok(Math.abs(erlangC(2, 1) - 1 / 3) < 1e-12);
  assert.equal(erlangC(2, 2), 1);
  assert.ok(Math.abs(mmcResponse(1, 5, 0.1) - 0.2) < 1e-12); // M/M/1: S / (1 − ρ)
  assert.equal(mmcResponse(2, 30, 0.1), Infinity);
});

test("ticks are round and cover the maximum", () => {
  assert.deepEqual(niceTicks(430), [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.ok(niceTicks(0.93).at(-1)! >= 0.93);
});

test("charts are well-formed SVG and survive empty or NaN data", () => {
  const line = lineChart({ title: "a < b", xLabel: "x", yLabel: "y", slo: 500,
    lines: [{ name: "one", points: [[0, 1], [1, NaN], [2, 3]], band: [[0, 0, 2], [2, 2, 4]] }, { name: "two", points: [] }] });
  assert.match(line, /^<svg /);
  assert.match(line, /a &lt; b/);
  assert.ok(!line.includes("NaN"));
  const bar = barChart({ title: "t", xLabel: "x", bars: [{ label: "v1", value: 10, min: 8, max: 12 }, { label: "v2", value: NaN }] });
  assert.ok(bar.trimEnd().endsWith("</svg>"));
  assert.ok(!bar.includes("NaN"));
  assert.ok(!barChart({ title: "t", xLabel: "x", bars: [] }).includes("NaN"));
});
