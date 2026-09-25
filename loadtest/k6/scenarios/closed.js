// Closed model (E16): VUS users each sending the next request only after the previous answer.
// Throughput adapts to latency, which hides queueing (coordinated omission); compare with load.js
// at the same achieved rate.
//   VUS (10), DURATION (2m)
import { common, env, iteration, thresholds } from "../lib/run.js";

export const options = {
  ...common,
  scenarios: { closed: { executor: "constant-vus", vus: Number(env("VUS", 10)), duration: env("DURATION", "2m") } },
  thresholds: thresholds(),
};

export default iteration;
