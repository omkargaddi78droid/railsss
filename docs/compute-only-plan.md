# Compute-only C++ workers + service separation (then the remaining study steps)

> **Status: DONE (session 6, 2026-09-26).** Results and deviations are in HANDOFF.md, "Compute-only change".

## Context
The user wants the C++ workers to do **only route computation**, with every other concern in its own
service/layer. Today the engine also:
- builds the full public response (`routing-engine/src/journey_json.cpp` `result_to_json`: names, every stop,
  formatted datetimes, distances), about 390 KB of JSON per search;
- logs one info line per request (`server.cpp` after `/route`).

That big JSON is also why the Node API was the first bottleneck in the local rehearsal (~58 rps). Node spent
about 35–40 ms per request parsing the 390 KB, slicing it and re-serializing it. Cache prewarm was added last
session inside the API process, and the user wants it moved out.

User decisions (from the questions in this session):
- Expansion ("rendering") becomes a **library inside the API**.
- Prewarm becomes its **own cache-warmer service**.
- The engine keeps **`/route` + `/health` + `/metrics`** and nothing else. Per-request log lines are dropped.

Resulting split:

| Service | Responsibility |
|---|---|
| nginx | Gateway |
| API (Node) | Validation, station search, dispatch/LB, Redis cache, rendering, filters, pagination, metrics |
| cache-warmer (Node, one-shot) | Prewarm Redis |
| Redis | Cache and worker registry |
| engine workers (C++) | Compute only |
| Mongo | Station master |
| Prometheus / Grafana | Observability |

## A. Engine: compact output, compute only (`routing-engine/`)

1. **Response format.** Replace `result_to_json` with a compact writer, `src/journey_json.cpp` → `compact_json`.
   It is written with plain string appends, with no nlohmann tree for the output.
   ```json
   {"status":"ok","search_complete":true,"worker":"w1","timetable":"<fnv64 hex>",
    "search_minute":<abs min>,
    "stats":{"total_ms":..,"profile_ms":..,"search_ms":..,"labels_popped":..,"truncated":false},
    "journeys":[{"signature":"..","dep":<abs min>,"arr":<abs min>,"transfers":n,
                 "train_minutes":..,"waiting_minutes":..,"legs":[[train_idx,board_stop,alight_stop,start_day],..]}]}
   ```
   Estimated size: about 5 KB instead of about 390 KB.
2. **Timetable identity.** Compute FNV-1a 64 over the timetable file bytes at load time, in `timetable.cpp`.
   Expose it in `/health` and in every `/route` response. This fixes last session's "no timetable version in
   the cache key" gap.
3. **Logging.** Drop the per-request info `log_line` in `/route`. Keep the startup and error logs.
4. **Keep** `/health` (plus the `timetable` field), `/metrics` and request validation. Validation stays because
   the engine needs station indices.
5. **Tests and bench.** `engine_tests` and `bench` do not use the JSON output, so they are unaffected.
   Add a small doctest that the compact output parses and has the same leg tuples as the `Journey` structs.
6. **Migration only (removed at the end of A–B).** Keep the old `result_to_json` behind
   `{"format":"full"}` so the parity fixture can be captured. Then delete it.

## B. API: renderer library, cache compact results (`api/src/`)

1. **New `services/journeyRenderer.ts`.**
   - Loads `timetable.json` (`TIMETABLE_PATH`) once and computes the same FNV hash.
   - Rebuilds trains, stops and placeholder names exactly as in `timetable.cpp` `load_timetable_json`.
   - Ports `civil_time.h` `format_datetime` / `format_date` (UTC `Date` math on absolute minutes).
   - `render(compact, n)` produces the existing `EngineRoute` shape, identical to today's `result_to_json`
     output. Distances must use float32 arithmetic (`Math.fround`), as the engine stores `float`.
   - Refuses to start or render if the engine's `timetable` hash differs from its own.
2. **`engineClient.ts` / `enginePool.ts`.** `EngineResult` becomes the compact type. The pool, semaphore,
   strategies, retry, hedge and 429 logic are unchanged.
3. **`routeService.ts`.**
   - The cache stores the compact result: tiny, still brotli-compressed through the existing
     `routeCache.ts` codec.
   - Filters (`filters.ts` uses only `duration_minutes` and `transfer_count`) run on the compact journeys.
   - Pagination slices, then **only the returned page is rendered**. `limit=10` renders 10; the frontend asks
     for 50 and gets 50.
   - The cache key hash = engine config + timetable hash.
   - `warm()` stays and is used by the warmer.
4. **API `Dockerfile`.** Copy `data/processed/timetable.json` from the existing `data` stage and set `TIMETABLE_PATH`.
5. **Parity fixture.** While `format=full` still exists, capture about 25 queries, both compact and full, into
   `api/test/fixtures/render-parity.json.gz`. The queries cover overnight and multi-day legs, placeholder stops,
   loop trains, and no-route cases, taken from `loadtest/data/queries.json` `verify` + `heavy`.
   - The test asserts `render(compact)` deep-equals `full`.
   - If `data/processed/timetable.json` is missing, the test is skipped with a note.
   - A one-off script compares all 200 verify queries plus 500 uniform queries before `format=full` is deleted.
6. **Public API contract unchanged.** Frontend and k6 `meta.*` are untouched. `meta.engine_ms` still comes from
   `stats.total_ms`.

## C. Cache-warmer service

1. New entry point `api/src/warmer.ts`, built from the same image with command `node src/warmer.ts`.
   - Config comes from `loadConfig()` (`ENGINE_URLS`, `REDIS_URL`, `PREWARM_*`).
   - It builds `EnginePool`, `RedisStore`, `RouteCache` and `StationService` (Mongo or file), then
     `RouteService.warm()`.
   - It reuses `services/prewarm.ts` (`planPrewarm`, `runPrewarm`) and the Redis `tryLock`/`unlock` with a token.
   - It waits for engine health (config + timetable hash, for the key), runs, logs stats, and exits 0.
     It exits nonzero if Redis or the engine never becomes reachable.
2. Remove `startPrewarm` and its lock/retry code from `apiProcess.ts`. The API no longer prewarms.
3. Share key building between the API and the warmer with a small helper, e.g. `engineIdentity(health) → configHash`.
   This lets both processes compute identical keys.
4. **`docker-compose.yml`.** Add a `cache-warmer` service:
   - API image, `restart: "no"`, `depends_on` engine + redis healthy.
   - It runs on each `docker compose up`. Verify that a completed one-shot container restarts on `up`; if not,
     document `docker compose up cache-warmer`.
   - Drop `PREWARM` from the api service.
5. **`loadtest/local/compose.yml`.** Add the warmer under profile `warm`, so it is off by default and
   measurements start cold. Drop `PREWARM*` from the api service.

## D. Docs and study material
- Update the following:
  - README: architecture diagram (warmer, compact engine), API internals, configuration table, known limitations
    (the stale-cache note is resolved by the timetable hash).
  - `.env.example`
  - HANDOFF: code map, decisions, results.
  - `docs/scaling-plan.md`: E9 changes meaning, from pass-through/lean to "compact engine + render page only";
    E10 becomes no cache / Redis / Redis + warmer.
  - Memory note.
- `loadtest/grafana/dashboards/scaling.json`: no change is needed (the metric names are the same).

## Verification
- `cd routing-engine && cmake --build build -j12 && ./build/engine_tests` (oracle + new compact test).
- `cd api && npm test && npx tsc --noEmit`: existing 30 tests, plus renderer parity, warmer and cache-key-with-hash tests.
- Parity script over 200 verify + 500 uniform queries: full vs rendered must be identical, before `format=full` is deleted.
- Rebuild the rehearsal stack:
  - `node loadtest/verify-results.ts --url http://localhost:8090 --against loadtest/data/verify-baseline.json` must be identical.
  - Run `loadtest/local/k6.sh smoke`.
  - Rerun the breakpoint (`START_RATE=10 MAX_RATE=150 DURATION=3m`) and compare against the 58 rps baseline.
    Record `engine_response_bytes` per request (expected about 5 KB).
- Main stack:
  - `docker compose up -d`: cache-warmer logs its stats and exits 0.
  - A frontend-proxy search at the current hour returns `cached: true`.
  - The UI renders journeys, stops and the map as before (headless screenshot, as in session 3).

## What remains after this (from HANDOFF), in order
1. **Step 5, `deploy/`:**
   - Terraform: VPC, placement group, 10 × m6i/m7i.large, SGs, ECR.
   - Inventory, role compose files (worker, gateway, data, monitoring, exporters, plus the warmer on the gateway).
   - `deploy.sh <variant>` and Prometheus `file_sd`.
2. **Step 6:** `loadtest/run.sh <exp> <variant>`, then the AWS runs: E1 first, then E2–E18.
3. **Step 7:** `loadtest/analyze.ts` (USL fit, knee, SVG charts; load the dataviz skill first), then
   `docs/load-test-report.md`, linked from README.
4. **Older TODOs:**
   - User feedback on the frontend filters.
   - Real-Chrome visual check (keyboard nav, back button, no-route message).
   - Optional Makefile / CI / git remote.
   - **Nothing has been committed since the initial commit.** Ask the user to commit once this change is verified.
   - Both engine performance items (the streaming writer, and API pass-through) are superseded by part A.

## Added TODOs (user request, end of session 5; not started)

Do these after the compute-only plan above, or earlier if the user asks. The user's wording is quoted where it matters.

### T1. Two study documents (write these after the Step 6 tooling exists, so the commands are real)
1. **`docs/experiment-runbook.md`**: a complete set of instructions from start to finish of the experiments, run by
   the user themselves:
   - Prerequisites (AWS accounts, Terraform, SSH keys, the k6 instance in the other account).
   - Provisioning, deploying each variant, smoke, running every experiment E1–E18 with exact commands, repeats, and teardown.
   - For each experiment, **what output and results to look out for and what to gather**:
     - k6 summary JSON;
     - Prometheus range-query snapshots (CPU per instance, per-worker RPS, cache events, pool events);
     - Grafana screenshots;
     - logs;
     - the exact variant env and inventory.
   - A fixed folder layout for results. The user will **gather all results into one zip file**, so define the
     zip structure and a `manifest` (experiment, variant, repeat, timestamps, instance types, git commit).
2. **`docs/analysis-llm-prompt.md`**: a prompt the user gives to **another LLM** together with that zip. The LLM must:
   - Produce a complete summary and analysis report files by analysing the results. Include:
     - per-experiment question, setup, result and explanation;
     - summary table;
     - max RPS within SLO, knee, USL fit;
     - recommendations;
     - threats to validity.
   - Provide **Python code that creates the graphs and visualizations**. The user runs the code themselves, so
     it must read the zip layout from T1.1, use pandas + matplotlib, write SVG/PNG files, and have no network access.
   - The prompt must describe the zip structure, the metric names, the SLO (p99 < 500 ms, errors < 0.1 %),
     and the expected output files.
   - Note: this replaces running `loadtest/analyze.ts` ourselves (Step 7) unless the user wants both. Ask when you get there.

### T2. Frontend changes
1. **Filters.** Remove these sections from the filter panel:
   - Transfer stations
   - Train type
   - Departure time
   - Arrival time
   - Journey duration (the max-duration filter)

   Keep the rest (max transfers, direct only, min connection, max single wait, excluded trains). Each filter is
   one entry in `frontend/lib/filters.ts` `PREDICATES`, a `Section` in `frontend/components/FilterPanel.tsx`, and
   URL keys in `filtersToParams`/`fromParams`. Remove all three pieces, and drop the options/sorts that only
   those filters used. The API still accepts `max_duration_minutes`, and the frontend simply stops sending it.
2. **Map route line.** The map is correct, but make the route line much better: round line caps and joins
   (Leaflet `lineCap: "round"`, `lineJoin: "round"`) "and many more". Suggested:
   - smoothing between stops;
   - a casing/halo under each leg line;
   - direction arrows or animated dash for the selected journey;
   - transfer-station markers distinct from intermediate stops;
   - hover emphasis.

   Files: `frontend/components/RouteMap.tsx`, `frontend/lib/palette.ts`.
3. **Layout.** "Reduce the filter column and keep the two columns: map and train results." Today there is a
   three-column layout at xl: filters, results, map. The target is two main columns (results + map), with filters
   made compact. For example, a slim collapsible filter bar or chips above the results, or the existing drawer
   at all widths. Check the choice with the user if unclear. Files: `frontend/app/page.tsx`, `FilterPanel.tsx`,
   `globals.css`.
4. Verify: `cd frontend && npx next build`, then headless screenshots at 1440 px light/dark and 390 px (as in
   session 3), then `docker compose build frontend`.

## Improvement review (end of session 5): user decisions

To do (not started):
- **TODO (before AWS runs): safe default for `MAX_QUEUE`.** Today `-1` = unlimited. In the rehearsal, the queue grew until the
  5 s engine timeout, causing 10–20 % errors at 60 rps. Default to a cap (e.g. 2 × workers × `ENGINE_CONCURRENCY`) so overload
  becomes fast 429s. E12 still compares the variants explicitly.
- **Next step (before E3 runs): loosen the httplib keep-alive/thread coupling in the engine.** Each kept-alive socket parks a pool
  thread, and the health checker + Prometheus hold one each. Options:
  - a short `set_keep_alive_timeout` / `set_keep_alive_max_count`;
  - serving `/metrics` and `/health` on a separate port with its own small listener.

  Goal: `ENGINE_THREADS` can equal the pool concurrency (E3 with 1 thread must not stall on idle sockets).
- **Next step (Step 5 Terraform): lock down AWS access.**
  - Grafana: admin IP only, password set, anonymous admin off.
  - Prometheus: remote-write port from the k6 IP only.
  - SSH: admin IP only.
  - nginx :80: k6 IP only.
- **TODO: graceful engine shutdown.** On SIGTERM: fail `/health`, stop accepting, finish in-flight searches, then exit
  (`srv.stop()` after draining). Needed so rolling redeploys and E13/E14 kill tests measure real failures, not deploy noise.

Decided, do not re-propose:
- **Load tests never go through Next.js.** k6 → nginx (the single entry point) → Node API → workers. No frontend is deployed
  for the study (the local rehearsal compose already has none). The main app's Next.js proxy stays as it is.
- No worker memory cap / `MALLOC_ARENA_MAX` work: memory is sufficient on m6i/m7i.large.
- No rate limiting on the API.
- No request-id propagation to the engine.
- No frontend tests or CI for the frontend. The focus is the backend study.
- Engine tail latency (p99 ~200 ms, 2.4 % budget hits) is accepted; no algorithm work now.
- BPR/MGR code reuse and missing station coordinates: ignored for now (frontend only).
