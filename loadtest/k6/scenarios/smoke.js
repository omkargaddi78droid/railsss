// Smoke: a few sequential requests that must all succeed. Run before every measurement.
//   ITERATIONS (20)
import { common, env, iteration } from "../lib/run.js";

export const options = {
  ...common,
  scenarios: { smoke: { executor: "shared-iterations", vus: 1, iterations: Number(env("ITERATIONS", 20)), maxDuration: "2m" } },
  thresholds: { http_req_failed: ["rate==0"], checks: ["rate==1"] },
};

export default iteration;
