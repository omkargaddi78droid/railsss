// Breakpoint: ramp the arrival rate until the SLO breaks, then abort. The rate at abort time
// (k6's iterations rate in the last window) approximates the maximum RPS within the SLO.
//   START_RATE (5), MAX_RATE (200), DURATION (10m, the ramp length), MAX_VUS (MAX_RATE * 5)
import { common, env, iteration, thresholds } from "../lib/run.js";

const maxRate = Number(env("MAX_RATE", 200));
export const options = {
  ...common,
  scenarios: {
    breakpoint: {
      executor: "ramping-arrival-rate",
      startRate: Number(env("START_RATE", 5)),
      timeUnit: "1s",
      preAllocatedVUs: Math.min(maxRate, 100),
      maxVUs: Number(env("MAX_VUS", maxRate * 5)),
      stages: [{ target: maxRate, duration: env("DURATION", "10m") }],
    },
  },
  thresholds: thresholds(true),
};

export default iteration;
