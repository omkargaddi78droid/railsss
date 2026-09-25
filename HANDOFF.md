# Session handoff: railway routing project

Read this first in a new session.

> **START HERE (ninth session onward):** Step 6 tooling is **DONE** (session 8: `loadtest/run.ts` +
> `loadtest/experiments.ts`, see "Step 6" below) but neither `deploy/` nor `run.ts` has run on AWS (no
> credentials/terraform here). Next, in order:
> 1. The AWS runs (the user runs them): `deploy.sh smoke` + `k6.sh smoke` first (first real test of `deploy/`),
>    then `node loadtest/run.ts E1`; CAPACITY for the later experiments comes from E1 w16.
> 2. Step 7 `loadtest/analyze.ts` (user wants it **and** the LLM prompt; T1 docs are DONE), T2 frontend changes.
> Current state: the main app stack is running (`docker compose ps`; the cache-warmer container has exited 0,
> which is normal); the rehearsal stack is stopped. Step 5 is committed (`b9d5020`, pushed to `origin`,
> github.com/omkargaddi78droid/railsss); Step 6 is committed and pushed (`0b33dfa`); T1 (session 8) is committed and pushed too.

The original application plan is at
`/home/omkar_gaddi/.claude/plans/pasted-content-id-27a5-you-are-nested-popcorn.md` (the original spec was pasted in the first session).
Repo root: `/home/omkar_gaddi/Desktop/final_rail`, a git repo on branch `main` (no remote yet). `.env` is gitignored; `data/processed/` is gitignored because it is generated. Raw data: `backend/train_data/*.json` (1725 files).

## Status summary

| Phase | Status |
|---|---|
| 1. Data inspection + quality report | DONE |
| 2. Preprocessing pipeline (Node TS) | DONE, 9 tests pass |
| 3–4. C++ routing engine + tests + bench | DONE, 25 test cases pass, oracle-verified |
| 5. Node/Express API | DONE, 10 tests pass, typecheck clean |
| 6. MongoDB integration | DONE, verified in compose (seed 2894 stations / 1725 trains, API reads stations from mongodb) |
| 7. Next.js frontend | Built OK, served in compose; **still not visually checked** (Chrome extension not connected) |
| 8. Docker / compose / .env | DONE: stack builds, all services healthy, PUBLIC_PORT=8080 in local .env |
| 9. Final benchmarks (API end-to-end, autocannon) | DONE: `api/bench/load.ts` (`npm run bench`); fixed engine keep-alive thread starvation (ENGINE_CONCURRENCY semaphore, ENGINE_THREADS=8) and Nagle (TCP_NODELAY) |
| 10. README.md | DONE |
| 11. Frontend v2: route map, redesign, richer filters (third session) | DONE, visually checked with headless Firefox; **user is trying the new filters and may ask to drop some** |

The Docker stack may still be running from the last session (`docker compose ps`), with the frontend on http://localhost:8080 (`PUBLIC_PORT=8080` in the local `.env`). Stop it with `docker compose down` (add `-v` to also drop the Mongo volume). There are no bare local processes running.

## How to run locally (verified)

```bash
cd scripts && node preprocess.ts          # -> data/processed/{timetable,stations,trains}.json, data/reports/quality-report.{json,md}
cd scripts && node geocode.ts             # -> frontend/public/station-coords.json (committed), data/reports/geocode-report.md
cd routing-engine && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j12
./build/engine_tests                      # doctest; ORACLE_ITERS=1500 ORACLE_SEED=n for soak runs
./build/bench ../data/processed/timetable.json 1000 2026-09-25 [k_node] [max_labels]
TIMETABLE_PATH=data/processed/timetable.json ./routing-engine/build/routing_engine     # from repo root, port 7070
cd api && npm test && npx tsc --noEmit && ENGINE_URL=http://127.0.0.1:7070 node src/server.ts   # port 4000
cd frontend && npx next build && API_INTERNAL_URL=http://127.0.0.1:4000 npx next start -p 3000
```
Node 24 runs `.ts` files directly (type stripping), so there is no build step for scripts or the API.

## Layout (what exists)

- `scripts/`
  - `preprocess.ts`: CLI, `--raw --out --reports --policy strict|correct|skip`, env equivalents.
  - `lib/normalize.ts`: pure rules.
  - `test/normalize.test.ts`
  - `geocode.ts` + `lib/geocode.ts` + `test/geocode.test.ts`: station coordinates for the map (datameet CC0 join, code aliases, outlier guard, interpolation along routes).
- `data/external/datameet-stations.json`: vendored datameet/railways station GeoJSON (CC0).
- `routing-engine/`: C++20, CMake. Header-only libs are vendored in `third_party/` (json.hpp, httplib.h, doctest.h), so builds work offline.
  - `src/timetable.{h,cpp}`: loader, departure index, per-train station index.
  - `src/civil_time.h`
  - `src/router.{h,cpp}`: the algorithm.
  - `src/journey_json.{h,cpp}`: `compact_json` (string-append writer) and `config_to_json`.
  - `src/server.cpp`: `POST /route` (compact output), `GET /health`, `GET /metrics`, env config.
  - `bench/bench.cpp`
  - `tests/`: `test_time`, `test_router` (synthetic scenarios), `test_oracle` (brute-force differential), `test_dataset` (real-data invariants), `synthetic.h`.
  - `Dockerfile`
- `api/`: Express 5 + zod 4 + pino + mongodb driver.
  - `src/app.ts`: routes, validation, error handler, request-id logging.
  - `src/bootstrap.ts`: service wiring shared by `apiProcess.ts` and `warmer.ts` (session 6).
  - `src/warmer.ts`: one-shot cache-warmer entry point (session 6).
  - `src/server.ts`
  - `src/config.ts`: env vars.
  - `src/services/`:
    - `stationService.ts`: prefix search on code and names.
    - `engineClient.ts`
    - `routeCache.ts`: Redis-only cache (brotli-compressed values) + in-flight coalescing. `prewarm.ts`: warm-up plan, used by `src/warmer.ts`.
    - `journeyRenderer.ts`: renders compact engine journeys into the public route shape (session 6).
    - `filters.ts`: registry.
    - `routeService.ts`
  - `src/db/mongo.ts`
  - `src/scripts/seed-mongo.ts`
  - `test/api.test.ts`
  - `bench/load.ts`: autocannon load test (`npm run bench`)
  - `Dockerfile`
- `frontend/`: Next 16 App Router, React 19, Tailwind 4, Leaflet 1.9 + react-leaflet 5, Inter via `@fontsource-variable/inter` (no build-time font download).
  - `app/page.tsx`: search, results, selection/hover state, sort, client pagination of 5 per page, URL state `?from&to&date&time` + filter/sort keys.
  - `app/api/[...path]/route.ts`: runtime proxy to `API_INTERNAL_URL`.
  - `components/`: `StationPicker`, `SearchForm`, `FilterPanel`, `JourneyCard` (leg bar, timeline, expandable stops, exclude train), `SummaryStrip`, `SortBar`, `MapPanel` (dynamic, ssr:false) → `RouteMap` (Leaflet).
  - `lib/`: `api`, `types`, `format`, `filters` (predicate registry, options, sorts, URL (de)serialization), `geo` (coords loader), `palette` (leg colours shared by card and map).
  - `public/station-coords.json`: generated by `scripts/geocode.ts`, committed.
  - `next.config.ts`: `output: standalone`.
  - `Dockerfile`
- `.dockerignore`: node_modules, .next, build, data/processed, data/reports, .env.
- `docker-compose.yml`, `.env.example` (and a local, gitignored `.env`), `.gitignore`, `README.md`.

## Key data findings (from inspection)

- 1725 records; unique train numbers and route IDs; 2894 stations after cleaning; 30,796 stops; day_of_journey 1–4.
- **Overnight rule:** `day_of_journey` = day of the DEPARTURE. If arr_hhmm > dep_hhmm at a stop, the arrival is on doj−1. At the terminus, doj applies to the arrival. This gives 0 violations. A naive "+1 day on clock wrap" approach is wrong: 1,072 mismatches, because some listed hops exceed 24 h.
- `type` has trailing spaces (trimmed).
- Train `"National"` has a non-numeric number (kept).
- 5 placeholder codes (`Point(4)`, `Point(5)`, `""`) named "X CODE Train Reversal": the code is recovered from the name.
- 13 station-name variants: canonical = most frequent. MGR and BPR have conflicting names (flagged).
- 4 loop trains visit the same station twice.
- 12881/12887 share a timetable but run on different days, so they are kept distinct.
- 08450 has a 12 h dwell (warning).
- 21 trains have empty `classes_available`.
- An extra `platform` key is always null (ignored).

## Algorithm (final, as implemented; README must explain this)

1. **Per-weekday precomputed patterns.** Train instances by start-day offset relative to the query date, plus connections pre-sorted by departure descending. There is no per-query sort; setup takes about 0.2 ms.
2. **Backward Connection-Scan profile** from the destination over [query time, query time + horizon]. It gives a lexicographic bound (arrival, remaining transfers) for every (instance, stop) and a step function per station. It relaxes the loop, cap and dominance rules, so it is admissible and consistent.
3. **Best-first (A\*) K-best enumeration.** Labels are Root, Onboard(inst, stop) and AtStation.
   - Priority key: (arrival lower bound, −first departure, transfers lower bound, wait, label id). Keys are monotone, so completed journeys pop in exact rank order.
   - The label parent chain is per leg, so loop checks cost at most about 11 steps, using `Timetable::train_calls_at` binary search plus a 64-bit bloom.
4. **Rules:**
   - Minimum transfer is 30 min (configurable, ≥1).
   - The first departure must be in [query time, 23:59 of the query date].
   - No station is touched twice, including ridden-through stations.
   - Each train number is used at most once per journey.
   - `max_transfers` defaults to 10.
   - Arrival must be ≤ query time + `horizon_minutes` (default 5760).
   - Signature = `train:FROM>TO|…` with no date, so the same itinerary on a later day is a duplicate (per spec).
5. **Dominance (exact; only removes a journey when a strictly better valid journey exists):**
   - **Stay-on**, applied in-search as a ceiling: when alighting from a train that itself reaches the destination without touching the chain, the arrival must be earlier than that train's arrival. A generalized version (the train reaches the alighting station of a later leg) is checked on completion.
   - **Board-earlier**, checked on completion only: the journey boards a train instance that was already boardable at an earlier presence point, and the alternative J′ is loop-free, departs no earlier, and has fewer transfers. It is done on completion because doing it in-search was proven unsound (JHN→DUMK case).
   - A "prefix dominance" rule was tried and removed: it is incompatible with the filters and gave no speedup.
6. **`k_node` cap:** default 0 (off, exact). **`max_labels` budget:** default 500k (raised from 200k when K went to 50), deterministic. When the budget is hit, `search_complete=false`. The returned journeys are still the exact top-n, but there may be fewer than K.
7. **Verification:**
   - Brute-force oracle equality on about 22,700 random queries (3 seeds × 1500 iterations) plus the default 250 iterations in the test suite.
   - Real-data invariants over 200 queries plus BD→NDLS.

## Benchmarks

All numbers are in README.md, in the "Benchmarks" section. In short:
- Engine alone: p50 7.3 ms, p99 about 100 ms.
- API direct, uncached, 1 connection: p50 26 ms.
- Through the frontend proxy, uncached, 10 connections: about 68 req/s, p50 138 ms.
- Cached: `api_ms` 0.15.

Rerun with `cd api && npm run bench -- --mode cold|cached --connections N --url http://localhost:8080`. The host cannot reach container IPs, so to hit the API directly, run the bench from a container:
`docker run --rm --network railway-routing_frontend -v $PWD:/w:ro node:24-alpine sh -c 'cd /w/api && node bench/load.ts --url http://api:4000 ...'`

## API contract (implemented)

- `GET /health` and `/api/health`: `{status: healthy|unhealthy, checks{engine,stations,mongo}, engine{...config}}`, returning 200 or 503.
- `GET /api/stations?q=&limit=`: prefix search, ranked exact code > code prefix > name prefix, then by train_count. Returns `label` = `"NAME (CODE)"`.
- `GET /api/stations/:code`
- `POST /api/routes`
  - Request: `{source, destination, date YYYY-MM-DD, time HH:MM, limit ≤MAX_RESULTS (default 50), page, filters{max_duration_minutes ≤3000, max_transfers, direct_only}}`. Schema is strict. The engine is always asked for the top MAX_RESULTS (50); results are cached, and filters and pages slice them.
  - Response: `{query, routes[rank,id,source,destination,departure_datetime,arrival_datetime,duration_minutes,total_elapsed_duration_minutes,initial_wait_minutes,train_travel_minutes,waiting_minutes,transfer_count,segment_count,is_direct,distance_km,train_numbers,segments[...stops],transfers[]], message?, filters_applied, pagination{page,limit,returned,total_available,total_unfiltered,total_pages,max_results}, meta{cached,search_complete,engine_ms,api_ms}}`.
  - Status codes:
    - 400 VALIDATION_ERROR / UNKNOWN_STATION / INVALID_JSON
    - 200 with `routes:[]` and message "No valid journey found for the specified date and time." when there is no route
    - 503 ENGINE_UNAVAILABLE
- Cache key: `src|dst|date|time|engineConfigJSON`.

## Engine env vars

`TIMETABLE_PATH, ENGINE_HOST, ENGINE_PORT(7070), ADMIN_PORT(7071, 0 = off), SHUTDOWN_GRACE_MS(3000), ENGINE_THREADS(8), MIN_TRANSFER_MINUTES(30), MAX_TRANSFERS_INTERNAL(10), TOP_K(50), K_NODE(0), SEARCH_HORIZON_MINUTES(5760), MAX_LABELS(500000), PRUNE_STAY_ON(1), PRUNE_BOARD_EARLIER(1)`

## API env vars

`API_PORT(4000), API_HOST, ENGINE_URL, MAX_RESULTS(50), ENGINE_TIMEOUT_MS, ENGINE_CONCURRENCY(4), MONGODB_URI, MONGODB_DB(railway), STATIONS_FILE, CACHE_ENABLED, CACHE_BACKEND(redis|none), REDIS_URL, CACHE_TTL_SECONDS, TIMETABLE_PATH; cache-warmer only: WARMER_WAIT_MS(120000), PREWARM_LOCK_MS(600000), PREWARM_PAIRS(50), PREWARM_TIMES(hourly), PREWARM_DAYS(1), PREWARM_TZ(Asia/Kolkata), PREWARM_CONCURRENCY(2), PREWARM_TTL_SECONDS, PREWARM_FILE, CORS_ORIGIN, LOG_LEVEL`. The frontend uses `API_INTERNAL_URL`.

## Remaining TODO

1. **User feedback on the new filters.** The user asked for "a couple" of complex filters to try and will say which to remove. Each filter is one entry in `frontend/lib/filters.ts` `PREDICATES` + a `Section` in `FilterPanel.tsx` + URL keys in `filtersToParams/fromParams`. Current set: transfer stations (only/must/avoid), train types, departure/arrival windows, min connection, max single wait, excluded trains, plus the original three.
2. Visual check still not done in real Chrome (extension never connected). Headless Firefox screenshots were used instead (puppeteer-core + `/usr/bin/firefox`, dark mode via pref `layout.css.prefers-color-scheme.content-override`). Not yet exercised: station autocomplete keyboard nav, back button, no-route message.
3. Optional:
   - Add a root Makefile or `package.json` with convenience targets.
   - Add a git remote and push (ask the user for the remote URL).
   - CI, e.g. a GitHub Actions workflow that runs the scripts, engine and API tests.
3. (Done in session 6 by the compute-only change: the engine's nlohmann output and the API re-serialization are gone.)

## Done this session (2026-09-25, second session)

- Built the compose stack and verified it end to end:
  - All services are healthy.
  - The seed exits with code 0.
  - `/api/health` reports mongo connected and stations loaded from mongodb.
- Added `api/bench/load.ts`, an autocannon script with cold and cached modes. It aggregates the server-side `engine_ms` and `api_ms` from the responses.
- **Fix: keep-alive thread starvation.**
  - Cause: cpp-httplib holds one pool thread per keep-alive connection. With 4 threads and 10 API sockets, the extra requests stalled until the 5 s keep-alive expired, producing 503s.
  - Fix: a FIFO `Semaphore` in `api/src/services/engineClient.ts` (`ENGINE_CONCURRENCY`, default 4; the timeout also covers queueing), and the engine's `ENGINE_THREADS` default raised from 4 to 8.
  - Test added in `api/test/api.test.ts`.
- **Fix: Nagle.** Added `srv.set_tcp_nodelay(true)` in `routing-engine/src/server.cpp`, because httplib writes headers and body separately and hit the 40 ms delayed ACK. API p50 went from 34 to 21 ms.
- Wrote README.md.
- Added `.gitignore`, ran `git init`, and made the initial commit.

## Done this session (2026-09-25, third session)

- Station coordinates: the raw data has none. datameet/railways (CC0) matches 94.7 % of codes; with 7 hand-checked aliases (CSMT→CSTM, MMCT→BCT, …) and interpolation along routes, 98.8 % (2,859/2,894). 18 of 28,993 adjacent-stop pairs are still inconsistent (mostly the reused codes BPR/MGR).
- Map: Leaflet, selected journey through every stop with per-leg colours, faint alternatives, hover sync, fit-to-journey, "Show all", legend overlay, dark tiles.
- Redesign: hero band, Inter, indigo palette, summary tiles, sort dropdown, filter drawer below xl, List/Map switch below lg.
- New filters listed in TODO 1. All client-side over the fetched results (user's choice).
- **K raised from 20 to 50** (user request): engine `top_k` default and compose `TOP_K` 50, API `MAX_RESULTS` env (default 50), frontend `MAX_RESULTS` in `lib/api.ts`, page size 5 -> 10. `MAX_LABELS` default 200k -> 500k (budget hits at K=50: 4.4 % with 200k, 2.4 % with 500k; p99 ~200 ms). Oracle test and `test_dataset` now run at K=50; oracle soak seeds 1-2 × 1500 iterations pass. API tests still use their own maxResults=20 fixture.
- Verified: `npm test` in scripts (15 pass), `tsc --noEmit`, `next build`, `docker compose build frontend`, headless screenshots at 1440 px light/dark and 390 px.

## Scaling study (fourth and fifth sessions, 2026-09-25): IN PROGRESS

Plan: `docs/scaling-plan.md` (copy of `/home/omkar_gaddi/.claude/plans/continue-eager-lobster.md`). The goal is learning through
comparisons, not a production deploy. Budget:
- 10 AWS m6i/m7i.large instances (2 vCPU = 1 physical core with HT, 8 GB).
- 8 instances × 2 single-core C++ workers = 16 workers.
- 2 instances for nginx, Node, Redis, Mongo, Prometheus and Grafana.
- k6 runs from one instance in another AWS account.

Provisioning uses Terraform plus SSH/compose scripts. The report is `docs/load-test-report.md`.
The plan lists the experiment catalogue E1–E18.

Build order and status:
1. **DONE: engine as worker.**
   - `WORKER_ID` env appears in logs, `/health` and the `/route` body (`worker`).
   - `GET /metrics` serves Prometheus text from `routing-engine/src/metrics.h`, a lock-free histogram with no dependency.
   - Metrics: requests by outcome, in-flight, budget hits, labels popped, response bytes, route/handler histograms.
2. **DONE: Node dispatcher** (`api/src/services/enginePool.ts`, replaces the single `HttpRoutingEngine` in `apiProcess.ts`).
   - `ENGINE_URLS` list, with a per-worker FIFO semaphore (`ENGINE_CONCURRENCY`).
   - `LB_STRATEGY` round_robin|random|least_outstanding (ties rotate)|p2c|consistent_hash (100 vnodes on `source|destination`).
   - `RETRY_MAX`, `HEDGE_AFTER_MS` (the loser is aborted and not counted as a worker error), `MAX_QUEUE` → 429 `OVERLOADED` + `retry-after`.
   - Passive ejection after `FAIL_THRESHOLD` failures, and active `/health` every `HEALTH_INTERVAL_MS`.
   - `setWorkers()` supports dynamic membership, following the Redis set `ENGINE_REGISTRY_KEY`.
   - `engineClient.ts` now exports `postRoute()`. `EngineError.kind` gained `"overloaded"`.
3. **DONE: cache backends and metrics.**
   - `routeCache.ts` offered local LRU and/or a `RemoteStore` (`CACHE_BACKEND` none|memory|redis|tiered). **Superseded in session 5: Redis only, see below.**
   - `CACHE_COALESCE` switch, and `REDIS_LOCK_MS` cross-process stampede lock (poll the value while another process computes).
   - Fail-open on Redis errors, with a 50 ms command timeout and no offline queue.
   - `redisStore.ts` uses node-redis v5.
   - `metrics.ts` uses prom-client on `METRICS_PORT` (9464): HTTP histogram, pool/worker gauges, cache outcomes.
   - `server.ts` is now the entry point: `NODE_CLUSTER=n` forks `apiProcess.ts` n times, and the primary serves the summed metrics.
   - Gotcha: prom-client cluster workers need a `new AggregatorRegistry()` to install the listener.
   - Note: under the cluster, each process has its own pool, so per-worker concurrency is n × `ENGINE_CONCURRENCY`.
   - API tests: 25 pass (`test/enginePool.test.ts` and `test/routeCache.test.ts` are new). Verified locally with 3 real engines, Redis in docker, `NODE_CLUSTER=2`, tiered cache, and a worker joining through the registry.
4. **DONE: local rehearsal** (fifth session; see "Step 4" below).
5. **DONE (session 7), not yet run on AWS**: Terraform + deploy scripts + monitoring (`deploy/`).
6. **DONE (session 8), not yet run on AWS**: experiment runner `loadtest/run.ts` (see "Step 6" below). AWS runs TODO.
7. TODO: analysis script and report.

### User decisions (do not re-ask)
- Scope: learning-focused comparisons, many experiments. The final deployed version is not the goal.
- Report: Markdown in the repo (`docs/load-test-report.md`, charts in `docs/load-test/`). No HTML artifact.
- Allowed infra: k6, wrk2, nginx, Redis, Prometheus + Grafana.
- AWS: exactly **10 instances, m6i.large or m7i.large** (x86, 2 vCPU = 1 physical core with HT, 8 GB), never more.
  - Baseline roles: 8 worker instances × 2 engine processes (1 per vCPU, cpuset pinned) = 16 workers.
  - Instance 9 is the gateway (nginx + Node API).
  - Instance 10 is data + observability (Redis, Mongo, Prometheus, Grafana).
  - Roles must be reassignable through an inventory file, e.g. 7 worker instances + 2 gateways.
- k6 runs on a separate instance in **another AWS account**. It hits nginx :80 over the public IP and
  pushes metrics to Prometheus remote write, so the security group allows only that IP.
- Provisioning: **Terraform + shell scripts** (SSH + docker compose per role).
- Request handling stays in Node/Express. The C++ engine only does the routing work.

### Code map of the new pieces
- `routing-engine/src/metrics.h`: `rail::Histogram<N>` and `rail::EngineMetrics::render(worker_id)`.
- `routing-engine/src/server.cpp`: `/metrics`, `WORKER_ID`, in-flight guard, and `worker` in the `/route` response.
- `api/src/server.ts`: entry point. Cluster supervisor when `NODE_CLUSTER>1`, otherwise `import("./apiProcess.ts")`.
- `api/src/apiProcess.ts`: the former server.ts. It wires `EnginePool`, `RedisStore`, `RouteCache` tiers, the registry sync (1 s) and the metrics listener.
- `api/src/services/enginePool.ts`: `EnginePool` (implements `RoutingEngine`).
  - Methods: `route`, `health`, `checkHealth`, `setWorkers`, `snapshot`, `counters`, `urls`.
  - The transport is injectable (`call`, `healthCall`) for tests.
- `api/src/services/routeCache.ts`: `RouteCache(maxEntries, ttlSec, enabled, {local, remote, coalesce, lockMs})`.
  - Counters: `hits`, `misses`, `localHits`, `remoteHits`, `coalesced`, `lockWaits`, `remoteErrors`.
- `api/src/services/redisStore.ts`: `RedisStore` (get/set with PX, `lock` via SET NX PX, `members` for the registry). Keys `route:*`, `lock:route:*`.
- `api/src/metrics.ts`: `createMetrics(pool, cache)` returns `{registry, observe}`.
  - Series: `api_http_request_duration_seconds`, `api_pool_in_flight`, `api_pool_events_total{event}`,
    `api_worker_{outstanding,healthy,requests_total,errors_total}{worker}`, `api_cache_events_total{outcome}`, `api_cache_entries`.
- `api/src/app.ts`: optional `observe` dep. `EngineError` kind `overloaded` maps to 429 `OVERLOADED` + `retry-after: 1`.
- `.env.example` documents every new variable.
- `docker-compose.yml` is still unchanged: single engine, via `ENGINE_URL`.

### Step 4 (fifth session, 2026-09-25): local rehearsal, DONE

What was built:
- `routing-engine/bench/bench.cpp`: `BENCH_DUMP=file.csv` writes one row per random query (source, destination, time, ms, labels, truncated, routes).
  `loadtest/data/bench-queries.csv` + `bench-output.txt` come from 4000 queries (p50 8.5 ms, p99 196 ms, max 586 ms).
- `api`: `meta.worker` in the `/api/routes` response (the engine's `WORKER_ID`; null on a cache hit). `EngineResult.worker` added. 25 tests pass, tsc clean.
- `loadtest/gen-queries.ts` → `loadtest/data/queries.json` (committed; the k6 box needs nothing else):
  `codes` (uniform is generated on the fly per global iteration, xorshift32 + lowbias32 hash, so every request is distinct and reruns are identical),
  `names`, `popular` (2000 queries among the 150 busiest stations, ranked by train-count product), `heavy` (slowest 2 % of the bench: 80 queries, 154–586 ms), `verify` (200).
- `loadtest/k6/lib/queries.js` (workloads `uniform` [+`HEAVY_FRAC`], `zipf` [`ZIPF_S`], `heavy`, `session`), `lib/run.js` (request + custom metrics
  `route_engine_ms`, `route_api_ms`, `route_latency_ms{cached}`, `route_cache_hit`, `route_search_complete`, `route_with_routes`, `route_overloaded`,
  `route_worker_requests{worker}`; SLO thresholds; `TESTID` tag), `scenarios/{smoke,load,breakpoint,spike,soak,closed}.js` (knobs documented at the top of each).
  The query file is opened at `/loadtest/data/queries.json` (override with `QUERIES`), so k6 must run with `loadtest/` mounted at `/loadtest`.
- `loadtest/local/compose.yml`: w1–w4 (cpuset 2,3,4,5), api (6,7), redis, nginx (:8090, `loadtest/nginx/gateway.conf.template`: `API_SERVERS`, `GZIP`),
  nginx-exporter, prometheus (:9090, remote-write receiver, `loadtest/prometheus/prometheus.local.yml`), grafana (:3001, anonymous admin,
  dashboard `loadtest/grafana/dashboards/scaling.json` "Railway scaling", 21 panels, `testid` variable), node-exporter, cadvisor, and k6 (profile, E-cores 8–11).
  Variant knobs are env vars (`LB_STRATEGY=p2c CACHE_BACKEND=none ... docker compose -f loadtest/local/compose.yml up -d api`).
- `loadtest/local/k6.sh <scenario>`: runs k6 via compose with remote write, forwards the knob env vars, saves `loadtest/results/local/<TESTID>/summary.json` (`results/` is gitignored).
- `loadtest/verify-results.ts --url ... [--save|--against file]`: baseline saved in `loadtest/data/verify-baseline.json` (149/200 with routes, 17 incomplete).
  Identical for least_outstanding+memory and consistent_hash+redis+NODE_CLUSTER=2 (also when served from Redis).
- The dashboard was checked by running every panel query against Prometheus (all return data; the 429 series is empty until a 429 happens). Not looked at in a browser.

Rehearsal results (dev host i5-12450H; w1/w2 and w3/w4 are HT siblings, so engine times are ~1.5–2× the bench):
- All six scenarios pass smoke at small scale; all four workloads work (zipf hits 100 % after warm-up, session 57 %).
- Default config (least_outstanding, ENGINE_CONCURRENCY=2, NODE_CLUSTER=1, memory cache): 30 rps for 1 min passes (p99 412 ms, 0 errors);
  the breakpoint aborts at ~58 rps (p99 > 500 ms). **The bottleneck is the Node API, not the workers**: API ~0.9 CPU (one event loop) vs workers ~0.55–0.65 each.
  Median `api_ms − engine_ms` is ~35–40 ms: the API parses the ~390 KB engine JSON (average ok response 387 KB), slices it, and re-serializes it.
  This is the motivation for E8 (Node tier) and E9 (pass-through / lean response); expect the same wall on AWS long before 16 workers saturate.
- NODE_CLUSTER=2 on one physical core (6,7) was *worse* at 60 rps (collapse, 5 s timeouts) for both consistent_hash and least_outstanding: two processes on HT siblings plus GC.
  Do not read LB conclusions off the laptop.

Problems found and fixed during the rehearsal:
- **API OOM** (fixed for good by the Redis-only change below): with `CACHE_MAX_ENTRIES=10000` the local cache tier filled the 512 MB V8 heap within a minute of uniform load (each entry is ~390 KB of JSON as
  JS objects, ~1 MB+ of heap). The local compose now uses 200. **Open issue**: the main `docker-compose.yml` default of 1000 entries can also reach ~1 GB of heap;
  a byte-bounded cache (or caching the raw engine string) would fix it. Resolved: the user chose to drop the in-process cache entirely.
- Engine RSS settles near 420 MB after heavy queries (per-thread malloc arenas with 8 threads); worker `mem_limit` is 768m. `MALLOC_ARENA_MAX` could lower it.
- ENGINE_THREADS stays 8 (not 2 as first planned): httplib parks a thread on each kept-alive socket, and besides the pool's sockets the health checker and Prometheus hold one each.
- SELinux is enforcing on the host: bind-mounted services use `security_opt: label=disable` (no relabel of repo files). node-exporter's `rslave` mount fails on this host, so it was dropped.

Housekeeping (superseded, see "Cache change"): the main app stack was stopped during the rehearsal to free RAM.
The stale engine (7070) and API processes from session 4 were killed. The rehearsal stack (`railway-loadtest`) is left running; stop it with
`docker compose -f loadtest/local/compose.yml down` (add `-v` to drop the Prometheus volume).

### Cache change (session 5, user request): Redis only + startup prewarm, DONE
- **User decision (do not re-ask): no in-process result cache at all.** Results live only in Redis; the cache is
  prewarmed whenever the system starts. `CACHE_BACKEND` is now `redis` (default) | `none`; `memory`/`tiered` and
  `CACHE_MAX_ENTRIES` are gone. In-flight coalescing stays (it holds only the pending promise, never a result).
- `routeCache.ts`: `new RouteCache(remote | null, ttlSeconds, {coalesce, lockMs})`; `getOrCompute(key, compute, ttlSeconds?)`.
  Values are JSON brotli q4 compressed on the libuv pool (a 270 KB result → ~8 KB; decode 0.75 ms). `RemoteStore` get/set use Buffers;
  `RedisStore` reads them through `withTypeMapping` and gained `tryLock(name, token, ttl)`/`unlock` (2 s timeout, owner token so a retry after a
  timed-out SET recognises its own lock; first try hit the 50 ms timeout right after connect).
- `prewarm.ts`: `busiestPairs`, `planPrewarm` (PREWARM_PAIRS busiest pairs by train-count product × PREWARM_TIMES, "hourly" = 00:00..23:00 which matches the
  frontend default time; today rotated to start at the current hour in PREWARM_TZ; PREWARM_DAYS dates; PREWARM_FILE extras), `runPrewarm` (bounded concurrency, stats).
  `apiProcess.ts` starts it in the background after the engine config (part of the key) is known and Redis is ready; Redis lock `lock:prewarm:<configHash>`
  so one process in the deployment runs it; 5 retries on error. `RouteService.warm()` uses the same key and full top-N as a live search.
- Main `docker-compose.yml` has a `redis` service (no persistence, `REDIS_MAXMEMORY` 256mb, allkeys-lru); the API depends on it. Loadtest compose defaults to
  `CACHE_BACKEND=redis` with `PREWARM=false` (so measurements start cold); set `PREWARM=true` to study it.
- Verified: API tests 30 pass (new `test/prewarm.test.ts`, shared `test/fakeRemote.ts`), tsc clean; verify-results identical through Redis;
  loadtest stack: 20 pairs → 480 searches in 21 s (5.5 MB Redis), restart → 480 already cached in 5 s, NODE_CLUSTER=2 → only one process prewarms;
  main stack: 1200 searches in 52 s, Redis 11.6 MB, a search through the frontend proxy at the current hour is `cached: true` (api_ms ~20).
- Known gap: the cache key has no timetable version and Redis outlives restarts; flush Redis after a timetable change (noted in README).
- `docs/scaling-plan.md` E10 is now: no cache vs Redis vs Redis + prewarm.
- State: the main app stack is **running** again (`docker compose up -d`, with Redis); the rehearsal stack is stopped (`docker compose -f loadtest/local/compose.yml up -d` resumes it).

### Compute-only change (session 6, 2026-09-26): DONE (`docs/compute-only-plan.md`)
- **Engine** (`routing-engine/`): `/route` now returns only compact JSON from `compact_json` (plain string appends, no nlohmann
  tree): `{status, search_complete, worker, timetable, search_minute, stats{total_ms,profile_ms,search_ms,labels_popped,truncated},
  journeys[{signature, dep, arr, transfers, train_minutes, waiting_minutes, legs[[train_idx, board_stop, alight_stop, start_day]]}]}`.
  `result_to_json` and the temporary `{"format":"full"}` switch are deleted. The per-request info log line is gone (startup/error
  logs stay). `Timetable::hash` = FNV-1a 64 of the file bytes (`fnv1a64_hex`), in `/health`, the startup log and every response.
  New `tests/test_compact.cpp` (compact output mirrors the Journey structs; FNV reference values): 27 cases pass.
- **Timetable is now deterministic**: `scripts/preprocess.ts` no longer writes `generated_at` into `timetable.json` (the quality
  report keeps the timestamp). Needed because the engine and API images each build the file and compare hashes. Two runs give
  identical bytes; the images and the local file all hash to `0903dfff2928fa6e`.
- **API**: `services/journeyRenderer.ts` (`JourneyRenderer`: loads `TIMETABLE_PATH`, skips never-running trains like the engine,
  float32 distances via `Math.fround`, `check(hash)`, `render(journey, rank, searchMinute)`; `fnv1a64Hex`, `formatDatetime`,
  `formatDate`). `EngineResult` is now the compact type (`CompactJourney`, `CompactLeg` in `engineClient.ts`).
  `routeService.ts`: caches the compact result, filters on `{duration_minutes, transfer_count}` of compact journeys
  (`filters.ts` `FilterableRoute`), slices the page, renders only that page; `engineIdentity(health)` = config JSON + `|` + timetable
  hash is the cache-key identity. `bootstrap.ts` (`createServices`, `resolveEngineIdentity`) is shared by `apiProcess.ts` and
  `warmer.ts`. The API exits (fatal log) if the engine's timetable hash differs from its own; a mismatched result is refused at render.
  Dockerfile copies `timetable.json` and sets `TIMETABLE_PATH`.
- **Cache-warmer**: `api/src/warmer.ts` (`node src/warmer.ts`, same image). Waits `WARMER_WAIT_MS` (120 s) for Redis + engine, takes the
  Redis lock `prewarm:<identity>` (`PREWARM_LOCK_MS`), runs `planPrewarm`/`runPrewarm`, logs stats, exits 0 (1 if unreachable or every
  query failed). `PREWARM` env var and all prewarm code in `apiProcess.ts` are gone. Main compose: `cache-warmer` service
  (`restart: "no"`, healthcheck disabled because the image's check probes the API port); **a plain `docker compose up -d` does restart
  the exited container** (verified). Loadtest compose: `cache-warmer` under profile `warm`
  (`docker compose -f loadtest/local/compose.yml --profile warm up cache-warmer`).
- **Tests**: API 36 pass, tsc clean. New `test/journeyRenderer.test.ts` (FNV, datetimes, placeholders, mismatch refusal, only the page
  is rendered, timetable hash in the key, parity) + `test/fakeTimetable.ts`. Parity fixture `test/fixtures/render-parity.json.gz`
  (231 KB; 15 verify + 10 heavy queries, compact + former full routes); skipped if the local timetable is missing or has another hash.
  Before deleting `format=full`, a one-off script compared 780 queries (200 verify + 80 heavy + 500 uniform), 25,896 journeys:
  all deep-equal.
- **Results**:
  - Engine response: avg ~8.8 KB (compact) vs ~257 KB (full) over the 780 queries; `engine_response_bytes` / request in the
    breakpoint run: 8.77 KB.
  - Main stack warmer: 1200 searches in 21–23 s (was 52 s in-API), Redis 3.3 MB (was 11.6 MB); rerun finds all 1200 cached in 0.9 s.
    A cached 50-journey search through the frontend proxy: `api_ms` ~10 (was ~20).
  - Rehearsal: `verify-results` identical to the baseline, cold and from Redis. Smoke passes.
  - **Breakpoint (`START_RATE=10 MAX_RATE=150 DURATION=3m`, TESTID `breakpoint-compact`): aborts at ~108 rps (p99 517 ms), 0 errors
    in 7400 requests; was ~58 rps.** At abort: API 0.83 CPU, workers 0.60–0.66 each (HT-sibling pairs, so their cores are close to
    full), engine p99 327 ms, median `api_ms − engine_ms` ~19 ms (was 35–40). On the laptop the API and the workers now saturate
    together; on AWS (16 workers) the Node tier will still be the first wall, but about twice as high (E8).
- Not done: a headless UI screenshot (puppeteer-core is not installed any more). The public API contract is unchanged and the
  frontend proxy returns full journeys with stops, so the UI should be unaffected; check it in a browser when convenient.
- Plan deviation: the compact journey keeps `signature` (plan listed it) although the API could derive it; it is ~30 % of the bytes
  (measured over the 200 verify queries, avg 9.2 KB). Dropping it would cut responses to ~6.4 KB if E9 wants it.

### Pre-AWS items (session 7, 2026-09-26): DONE
- **`MAX_QUEUE` default is `auto`** (`config.ts`, `enginePool.ts`): queue up to one capacity (workers ×
  `ENGINE_CONCURRENCY`, recomputed per request so it follows membership); `-1` still = unlimited, a number = fixed.
  Rehearsal spike 20→200 rps: all 2208 failures were fast 429s, 0 engine timeouts, max latency 1.5 s.
- **Engine admin listener** (`server.cpp`): `/health` + `/metrics` also on `ADMIN_PORT` (7071, own 2-thread
  pool). Prometheus (`loadtest/prometheus/prometheus.local.yml`) scrapes 7071; Dockerfile exposes it. `/route`
  and `/health` stay on 7070 (the docker healthcheck curl uses it and closes its socket).
- **Pool health checks close their connection** (`enginePool.ts` `httpHealth`: `node:http` with `agent: false`)
  so they never park a routing thread; a non-200 (e.g. 503 draining) marks the worker unhealthy. They resolve
  host names with c-ares (`Resolver.resolve4`, 1 s timeout, last good address kept; `/etc/hosts` names fall
  back to `lookup`). **Why**: `getaddrinfo` for a stopped container's name takes ~5 s (`EAI_AGAIN`); with a
  lookup every 2 s those filled libuv's 4-thread pool (shared with brotli and every lookup), all 4 workers
  looked unhealthy, traffic fell back onto the dead worker, and a rolling stop gave 14 % errors. After the fix:
  0/1800 errors, p99 280 ms. On AWS the inventory should render IPs anyway.
- Result: `ENGINE_THREADS` can equal the pool concurrency. Rehearsal with `ENGINE_THREADS=2`,
  `ENGINE_CONCURRENCY=2`, 40 rps: 0 errors, p99 295 ms. The loadtest compose passes `ENGINE_THREADS` (default 8).
  Caveat: with `NODE_CLUSTER=n` each API process has its own sockets, so threads must be ≥ n × concurrency;
  a hedge loser / timed-out call frees the API slot while its engine thread still computes (brief queueing).
- **Graceful drain** (`server.cpp`): SIGTERM/SIGINT are blocked in all threads and taken by a `sigwait` thread
  (also fixes PID 1 in the container ignoring SIGTERM, so `docker stop` took 10 s + SIGKILL). `/health` → 503
  `{"status":"draining"}` for `SHUTDOWN_GRACE_MS` (keep > API `HEALTH_INTERVAL_MS`) while `/route` still
  serves, then `srv.stop()`; `listen()` returns after httplib's pool finishes in-flight and queued requests;
  logs `draining` / `stopped`; exit 0. Verified: a 490 ms search in flight at SIGTERM still gets 200; `docker
  stop` of a worker under 30 rps takes ~4 s with 0 errors.
- API tests 38 pass (new: `MAX_QUEUE auto`, health check closes its connection + treats 503 as down), tsc clean;
  engine image build ran the full engine test suite.

### Step 5 (session 7, 2026-09-26): `deploy/`, DONE (untested on AWS)
- `deploy/terraform/main`: VPC 10.40.0.0/16, one public subnet in one AZ, cluster placement group, 10 ×
  `instance_type` (validated: m6i.large|m7i.large, count ≤ 10), Ubuntu 24.04, gp3 30 GB, IMDSv2. SG: all
  traffic within the SG; admin /32 → 22, 3000; k6 /32 → 80, 9090. ECR repos `railway-scaling/{engine,api}`
  (`force_delete`), instance role with `AmazonEC2ContainerRegistryReadOnly`; `user_data.sh.tftpl` installs
  docker.io, docker-compose-v2, amazon-ecr-credential-helper (credHelpers → no AWS keys on hosts), sysctls,
  log rotation, then touches `/var/lib/railway-ready`. Region default `ap-south-1`, `aws_profile` variable.
  `terraform.tfvars.example`. `deploy/terraform/k6`: own VPC 10.50/16, one c6i.xlarge (outside the 10-host
  budget), Elastic IP (the main SG allows only it), docker + grafana/k6 pulled.
- `deploy/inventory.ts`: `terraform output -json` (or `--main-output/--k6-output` files) → `deploy/inventory.json`
  (gitignored); default roles node01–08 worker, node09 api+nginx, node10 redis+monitoring; keeps edited
  roles; resets `deploy/.known_hosts`.
- `deploy/render.ts <variant> [K=V…]`: `variants/defaults.env` ← `<variant>.env` ← CLI; unknown keys rejected.
  Layout knobs `WORKERS` (all|n), `WORKERS_PER_HOST` (2 = pinned cpuset 0/1; 1 = unpinned), `WORKER_PLACEMENT`
  (spread|pack), `ENGINE_PORT_BASE` (slot a 7070/7071, slot b 7080/7081), `PREWARM`, `GZIP`,
  `REDIS_MAXMEMORY`, `PROMETHEUS_RETENTION`, `IMAGE_TAG` (from `.out/image-tag`). Writes `.out/<variant>/`:
  per-host `compose.yml` (JSON; host networking; container names `<host>-<service>` so cAdvisor `name`
  is unique), `node10/targets/*.json` (file_sd with `host` label), `plan.json` (phases, worker/api URLs,
  gateway, git commit), `variant.env`.
- `deploy/deploy.sh <variant> [K=V…]`: render → per host (parallel within a phase): wait first boot, rsync to
  `/opt/railway` (+ `loadtest/grafana`, `loadtest/nginx`, `prometheus.yml`, `.env` with the Grafana password
  from `deploy/.grafana-password`), `compose pull`, `up -d --remove-orphans --wait`. Phases: 1 engines/Redis/
  monitoring, 2 api, 3 nginx host. Flushes Redis after phase 1 (`KEEP_CACHE=1` skips), runs the warmer if
  `PREWARM=true`, checks every worker admin `/health` and the gateway from inside the VPC, links `.out/current`.
- `deploy/images.sh [tag]`: ECR login, `docker build --platform linux/amd64`, push, tag = `git describe --dirty`.
- `deploy/k6.sh <scenario>`: rsync `loadtest/` to the k6 host, run grafana/k6 (host net) with BASE_URL = gateway
  public URL and remote write to node10:9090, fetch `summary.json` into `loadtest/results/aws/<TESTID>/` with
  `plan.json` + `variant.env`.
- Grafana on AWS: admin password, anonymous off. Prometheus has no admin API; reach it over an SSH tunnel.
  Dashboard: "Host CPU busy" is now per `host`.
- Verified offline: `terraform validate` + `fmt -check` for both (terraform 1.9.8 fetched into the scratchpad;
  not installed on this machine, nor the AWS CLI), user_data template rendered via `terraform console`;
  render for 16/12/2 workers, spread/pack/per-host=1, typo rejection; `docker compose config` on all 10 host
  files; **a single-host inventory (all roles on 127.0.0.1) rendered and run locally**: API via nginx returned
  50 routes from both engines, Prometheus scraped every file_sd target, Grafana dashboard provisioned,
  anonymous 401, cache-warmer 1200/1200. `deploy.sh`'s SSH/rsync path itself has not run yet.
- Not done: E14 registry join (nothing SADDs workers into `ENGINE_REGISTRY_KEY` yet), per-experiment variant
  files (Step 6), `loadtest/run.sh`.

### Step 6 (session 8, 2026-09-26): experiment runner, DONE (untested on AWS)
- `loadtest/experiments.ts`: the catalogue. Each experiment = id, title, question, `params` (number defaults;
  `null` = required, e.g. `CAPACITY` = max RPS within SLO of E1 w16), and `variants(p)` → `{name, deploy
  overrides, scenario, k6 env, setup actions, timed "during" actions, repeats}`. Actions: `kill-workers n`
  (SIGKILL the last n workers of the plan, after `docker update --restart=no`), `start-workers` (start stopped
  engines, wait for admin /health), `kill-redis`, `start-redis`, `registry-set n|all` (Redis set
  `ENGINE_REGISTRY_KEY`). E5 and E6 are marked `unsupported` (reasons in the file). E9 has no "before
  compute-only" images variant (the old engine has no admin port, so deploy's health checks would fail).
  E11 uses zipf s=3 cold for 30 s on NODE_CLUSTER=2. E14 kills the 8 b-slot workers, registers the 8 a-slots,
  and at 60 s starts the b-slots and registers all.
- `loadtest/run.ts <EXP> [params/k6/deploy KEY=VALUE] [--variants a,b] [--repeats n] [--force] [--dry-run]`,
  `--list`. Per repeat: `deploy.sh` (flush → cold; `SKIP_PULL` after the first deploy) → `k6.sh smoke` with a
  random seed (must pass) → setup → measured `k6.sh` (TESTID `<exp>-<variant>-r<n>`, fixed SEED so repeats
  send the same queries) with the timeline running beside it → restore (start workers/Redis, registry all) →
  33 Prometheus `query_range` series (5 s step, run window ± 15 s, fetched with one SSH to the monitoring host)
  and `docker compose logs` of every host. k6 exit 99 (thresholds crossed) counts as ok. Layout:
  `loadtest/results/<EXP>/<variant>/r<n>/{meta.json, summary.json, plan.json, variant.env, smoke/, prom/,
  logs/, deploy.log, k6.log}`, `results/<EXP>/experiment.json`, `results/manifest.jsonl`. Repeats with
  `meta.json` status ok are skipped on rerun (resume). A failed deploy stops the run; a failed smoke skips the
  variant's remaining repeats. There is no `run.sh` wrapper (Node, like `deploy/*.ts`).
- Also changed: `render.ts` `API_HOSTS=n` (E8; converts the last worker hosts to API hosts; exports `KNOWN`
  and `applyApiHosts`), `k6.sh` `RESULT_DIR`, k6 requests send `accept-encoding: gzip` (E9; nginx only
  compresses when `GZIP=on`).
- Verified offline: `node --test loadtest/test/*.test.ts` (21 pass: every variant of every runnable experiment
  renders on the default 10-host inventory, knob names match `k6.sh`, CLI parsing, API_HOSTS), strict `tsc`
  on the new files, `--dry-run` of all experiments, and all 33 snapshot queries plus the SSH-side shell loop
  against a throwaway Prometheus (all parse). The SSH paths themselves have not run.
- Breakpoint defaults are guesses (E1 `MAX_RATE` = 50 × workers + 50, others 500–900, 5 min ramp); adjust with
  params after the first AWS runs. Expect the Node tier (NODE_CLUSTER=1) to cap E1 above ~8 workers (see
  session 6); E8 measures that.

### Next steps, in order

**Step 5: `deploy/`** (reuse `loadtest/nginx/gateway.conf.template`, the Grafana provisioning + dashboard, and the local Prometheus config
turned into `file_sd`; the k6 instance only needs `loadtest/` and the `grafana/k6` image. Decide the E8/E9 question first if the API wall shows up on AWS.)
  - `terraform/`:
    - VPC, 1 public subnet, a cluster placement group, 10 × `var.instance_type`, and an Ubuntu AMI with docker installed via user_data.
    - SGs: all traffic inside the VPC. From the k6 IP: :80 and :9090 (remote write). From the admin IP: :22 and :3000 (Grafana).
    - ECR repos for the engine and api images.
    - Outputs: private and public IPs.
  - `deploy/inventory.yml` is generated from the Terraform output; roles per instance are editable.
  - `deploy/roles/{worker,gateway,data,monitoring,exporters}.compose.yml`.
  - `deploy/deploy.sh <variant>`: renders `ENGINE_URLS` and the nginx upstream from the inventory plus
    `deploy/variants/<name>.env`, then runs `docker compose up -d` on every host over SSH in parallel.
  - The worker image must bake in `timetable.json`.
  - Prometheus uses `file_sd` generated from the inventory.
- **Step 6: DONE (tooling)**, see above. AWS run order: E1 first as the baseline, then E2–E18.
- **Step 7: `loadtest/analyze.ts`**: medians and spread over repeats, max RPS within SLO, knee, USL fit, and
  SVG charts (load the dataviz skill first). Then write `docs/load-test-report.md` with the sections listed in
  the plan, link it from README, and update this file.

### Verification commands
- `cd routing-engine && cmake --build build -j12 && ./build/engine_tests` (all pass, ~648k assertions)
- `cd api && npm test && npx tsc --noEmit` (38 pass)
- The local multi-worker smoke used for step 3 (replicate it with a script file, not an inline `pkill`):
  3 engines on ports 7181–7183 with distinct `WORKER_ID`s, and Redis in docker (`redis:7-alpine`, host port 6399).
  Run `ENGINE_REGISTRY_KEY=engines REDIS_URL=redis://127.0.0.1:6399 CACHE_BACKEND=tiered NODE_CLUSTER=2 node src/server.ts`,
  then check `curl localhost:9464/metrics`.
- Local rehearsal: `docker compose -f loadtest/local/compose.yml up -d --build`, `loadtest/local/k6.sh smoke`,
  `node loadtest/verify-results.ts --url http://localhost:8090 --against loadtest/data/verify-baseline.json`.

Sessions 1–5 are committed (`771e17a` on branch `scaling-study`). Sessions 6 (compute-only) and 7 (pre-AWS
items) are not committed yet; ask the user before committing.

## Gotchas learned

- **CARTO basemaps now return an "API KEY REQUIRED" tile** (HTTP 200 PNG). Use Esri `Canvas/World_{Light,Dark}_Gray_{Base,Reference}` (keyless).
- Leaflet binds only one tooltip per layer; a second `<Tooltip>` replaces the first.
- Tailwind 4: custom classes in `globals.css` must be inside `@layer components`, otherwise unlayered CSS beats utilities like `xl:hidden`.
- `pkill -f next-server` inside a Bash call whose own command text contains "next-server" kills that shell (exit 144). Put the restart in a script file.

- Node 24 type stripping only supports erasable TS syntax: no enums and no parameter properties. Imports must use the `.ts` extension.
- Next.js modified `frontend/tsconfig.json` automatically (`jsx: react-jsx`, `.next/dev/types`). That is fine.
- The API uses TypeScript 7 (`tsc --noEmit` works). The frontend uses TypeScript 5.9 for Next compatibility.
- Scratch tools used for debugging (`one.cpp`, `cmp.cpp`, `dist.cpp`, `dbg.cpp`) were in the session scratchpad and are not needed.
- The engine image build takes about 75 s, because it runs the full `engine_tests` suite, including the oracle.
- The Mongo password is embedded in the connection URI in compose, so it must be URL-safe (hex).
- **k6 reruns with the same `SEED` are Redis cache hits** (the workload is deterministic per seed, TTL 1 h), so the
  engines sit idle. Use `SEED=$RANDOM` (or flush Redis) for any uncached measurement; check `route_cache_hit`.
- `getaddrinfo` of a stopped docker container's name blocks ~5 s (`EAI_AGAIN`) on a libuv thread; see "Pre-AWS items".
- Docker here is Docker Desktop (VM): `network_mode: host` ports are not reachable from the laptop and bind
  mounts from /tmp are denied. Test host-network stacks from a `--network host` container, with files under the repo.

## Added TODOs (user request, end of session 5)

**T1 DONE (session 8):** `docs/experiment-runbook.md` (prereqs incl. vCPU quota, provisioning, sanity check,
how run.ts works, result layout, E1–E18 in order with commands, time estimates (~24 h for everything × 3),
what to look at / gather per experiment with the real Grafana panel names, reading CAPACITY, screenshots
naming, teardown, packing, troubleshooting), `docs/analysis-llm-prompt.md` (system, zip layout, meta/summary/
prom formats with every series, per-experiment questions, methods: validity, repeats, capacity from windowed
`api_latency_p99`, knee, USL, fault timelines; deliverables: report, summary CSV, one pandas+numpy+matplotlib
script writing SVG+PNG, README), and `loadtest/pack.ts` (zip with `manifest.json` from every meta.json,
`attempts.jsonl`, `environment/`, `experiments/`, `screenshots/`, `notes.md`; tested on a fake result).
`run.ts` gained `--suffix s` (results as `<variant>-<s>`, so a rerun with other overrides is neither skipped
nor overwrites; used for E8/E17 capacity re-measurement). Open question left in the prompt: whether k6's
remote-write trend gauges are cumulative; the prompt tells the LLM to check and prefer `api_latency_p99`.
T2 is not started.

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
   - **User decision (session 8): keep both** — the LLM prompt and our own `loadtest/analyze.ts` (Step 7).

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

Status: `MAX_QUEUE` default, keep-alive/thread decoupling and graceful shutdown are DONE (session 7, see
"Pre-AWS items"); the AWS lock-down belongs to Step 5. Original notes:
- **DONE: safe default for `MAX_QUEUE`.** Today `-1` = unlimited. In the rehearsal, the queue grew until the
  5 s engine timeout, causing 10–20 % errors at 60 rps. Default to a cap (e.g. 2 × workers × `ENGINE_CONCURRENCY`) so overload
  becomes fast 429s. E12 still compares the variants explicitly.
- **DONE: loosen the httplib keep-alive/thread coupling in the engine.** Each kept-alive socket parks a pool
  thread, and the health checker + Prometheus hold one each. Options:
  - a short `set_keep_alive_timeout` / `set_keep_alive_max_count`;
  - serving `/metrics` and `/health` on a separate port with its own small listener.

  Goal: `ENGINE_THREADS` can equal the pool concurrency (E3 with 1 thread must not stall on idle sockets).
- **Next step (Step 5 Terraform): lock down AWS access.**
  - Grafana: admin IP only, password set, anonymous admin off.
  - Prometheus: remote-write port from the k6 IP only.
  - SSH: admin IP only.
  - nginx :80: k6 IP only.
- **DONE: graceful engine shutdown.** On SIGTERM: fail `/health`, stop accepting, finish in-flight searches, then exit
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
