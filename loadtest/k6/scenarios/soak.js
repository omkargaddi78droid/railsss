// Soak: moderate constant load for a long time, to catch drift (memory, cache size, latency).
//   RATE (20), DURATION (60m)
import { common, env, iteration, thresholds } from "../lib/run.js";

const rate = Number(env("RATE", 20));
export const options = {
  ...common,
  scenarios: {
    soak: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: env("DURATION", "60m"),
      preAllocatedVUs: rate,
      maxVUs: rate * 10,
    },
  },
  thresholds: thresholds(),
};

export default iteration;
