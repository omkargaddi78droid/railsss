// Open-model constant load: RATE iterations/s for DURATION, whatever the latency.
// One step of a capacity sweep; run.sh calls it at increasing RATE.
//   RATE (20), DURATION (2m), PRE_VUS (RATE), MAX_VUS (RATE * 10)
import { common, env, iteration, thresholds } from "../lib/run.js";

const rate = Number(env("RATE", 20));
export const options = {
  ...common,
  scenarios: {
    load: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: env("DURATION", "2m"),
      preAllocatedVUs: Number(env("PRE_VUS", rate)),
      maxVUs: Number(env("MAX_VUS", rate * 10)),
    },
  },
  thresholds: thresholds(),
};

export default iteration;
