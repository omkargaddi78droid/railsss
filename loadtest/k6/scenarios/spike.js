// Spike: steady BASE_RATE, a sudden jump to SPIKE_RATE for SPIKE_FOR, then back to BASE_RATE long
// enough to measure recovery (latency and queue back to the pre-spike level).
//   BASE_RATE (10), SPIKE_RATE (100), SPIKE_FOR (30s), HOLD (1m)
import { common, env, iteration, thresholds } from "../lib/run.js";

const base = Number(env("BASE_RATE", 10));
const spike = Number(env("SPIKE_RATE", 100));
const hold = env("HOLD", "1m");
export const options = {
  ...common,
  scenarios: {
    spike: {
      executor: "ramping-arrival-rate",
      startRate: base,
      timeUnit: "1s",
      preAllocatedVUs: spike,
      maxVUs: spike * 10,
      stages: [
        { target: base, duration: hold },
        { target: spike, duration: "5s" },
        { target: spike, duration: env("SPIKE_FOR", "30s") },
        { target: base, duration: "5s" },
        { target: base, duration: hold },
      ],
    },
  },
  thresholds: thresholds(),
};

export default iteration;
