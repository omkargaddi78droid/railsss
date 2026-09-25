# Session handoff: railway routing project

Read this first in a new session. The approved plan is at
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

The Docker stack may still be running from the last session (`docker compose ps`), with the frontend on http://localhost:8080 (`PUBLIC_PORT=8080` in the local `.env`). Stop it with `docker compose down` (add `-v` to also drop the Mongo volume). There are no bare local processes running.

## How to run locally (verified)

```bash
cd scripts && node preprocess.ts          # -> data/processed/{timetable,stations,trains}.json, data/reports/quality-report.{json,md}
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
- `routing-engine/`: C++20, CMake. Header-only libs are vendored in `third_party/` (json.hpp, httplib.h, doctest.h), so builds work offline.
  - `src/timetable.{h,cpp}`: loader, departure index, per-train station index.
  - `src/civil_time.h`
  - `src/router.{h,cpp}`: the algorithm.
  - `src/journey_json.{h,cpp}`
  - `src/server.cpp`: `POST /route`, `GET /health`, env config.
  - `bench/bench.cpp`
  - `tests/`: `test_time`, `test_router` (synthetic scenarios), `test_oracle` (brute-force differential), `test_dataset` (real-data invariants), `synthetic.h`.
  - `Dockerfile`
- `api/`: Express 5 + zod 4 + pino + mongodb driver.
  - `src/app.ts`: routes, validation, error handler, request-id logging.
  - `src/server.ts`
  - `src/config.ts`: env vars.
  - `src/services/`:
    - `stationService.ts`: prefix search on code and names.
    - `engineClient.ts`
    - `routeCache.ts`: LRU + TTL + in-flight coalescing.
    - `filters.ts`: registry.
    - `routeService.ts`
  - `src/db/mongo.ts`
  - `src/scripts/seed-mongo.ts`
  - `test/api.test.ts`
  - `bench/load.ts`: autocannon load test (`npm run bench`)
  - `Dockerfile`
- `frontend/`: Next 16 App Router, React 19, Tailwind 4.
  - `app/page.tsx`: search, results, filters, client pagination of 5 per page, URL state `?from&to&date&time`.
  - `app/api/[...path]/route.ts`: runtime proxy to `API_INTERNAL_URL`.
  - `components/`: `StationPicker`, `SearchForm`, `FilterPanel`, `JourneyCard` (timeline, expandable stops).
  - `lib/`: `api`, `types`, `format`, `filters`.
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
6. **`k_node` cap:** default 0 (off, exact). **`max_labels` budget:** default 200k, deterministic. When the budget is hit, `search_complete=false`. The returned journeys are still the exact top-n, but there may be fewer than 20.
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
  - Request: `{source, destination, date YYYY-MM-DD, time HH:MM, limit ≤20 (default 20), page, filters{max_duration_minutes ≤3000, max_transfers, direct_only}}`. Schema is strict. The engine is always asked for the top 20; results are cached, and filters and pages slice them.
  - Response: `{query, routes[rank,id,source,destination,departure_datetime,arrival_datetime,duration_minutes,total_elapsed_duration_minutes,initial_wait_minutes,train_travel_minutes,waiting_minutes,transfer_count,segment_count,is_direct,distance_km,train_numbers,segments[...stops],transfers[]], message?, filters_applied, pagination{page,limit,returned,total_available,total_unfiltered,total_pages,max_results}, meta{cached,search_complete,engine_ms,api_ms}}`.
  - Status codes:
    - 400 VALIDATION_ERROR / UNKNOWN_STATION / INVALID_JSON
    - 200 with `routes:[]` and message "No valid journey found for the specified date and time." when there is no route
    - 503 ENGINE_UNAVAILABLE
- Cache key: `src|dst|date|time|engineConfigJSON`.

## Engine env vars

`TIMETABLE_PATH, ENGINE_HOST, ENGINE_PORT(7070), ENGINE_THREADS(8), MIN_TRANSFER_MINUTES(30), MAX_TRANSFERS_INTERNAL(10), TOP_K(20), K_NODE(0), SEARCH_HORIZON_MINUTES(5760), MAX_LABELS(200000), PRUNE_STAY_ON(1), PRUNE_BOARD_EARLIER(1)`

## API env vars

`API_PORT(4000), API_HOST, ENGINE_URL, ENGINE_TIMEOUT_MS, ENGINE_CONCURRENCY(4), MONGODB_URI, MONGODB_DB(railway), STATIONS_FILE, CACHE_ENABLED, CACHE_MAX_ENTRIES, CACHE_TTL_SECONDS, CORS_ORIGIN, LOG_LEVEL`. The frontend uses `API_INTERNAL_URL`.

## Remaining TODO

1. **Visual UI check.** This was never done, because the Chrome extension was not connected in either session. Open http://localhost:8080 and check:
   - station autocomplete (keyboard navigation)
   - the swap button
   - the BD→NDLS 2026-09-25 10:00 results timeline
   - the +1 day badges
   - expandable stops
   - filters (direct only, max transfers, the duration slider)
   - pagination (5 per page)
   - URL state and the back button
   - dark mode
   - the no-route and validation error messages

   Fix whatever looks off, then rerun `cd frontend && npx next build`.
2. Optional:
   - Add a root Makefile or `package.json` with convenience targets.
   - Add a git remote and push (ask the user for the remote URL).
   - CI, e.g. a GitHub Actions workflow that runs the scripts, engine and API tests.
3. Optional performance work (listed as future work in the README):
   - Replace nlohmann serialization in the engine (about 6 ms per request) with a streaming writer.
   - Pass the engine's bytes through the API without re-serializing (about 7 ms).

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

## Gotchas learned

- Node 24 type stripping only supports erasable TS syntax: no enums and no parameter properties. Imports must use the `.ts` extension.
- Next.js modified `frontend/tsconfig.json` automatically (`jsx: react-jsx`, `.next/dev/types`). That is fine.
- The API uses TypeScript 7 (`tsc --noEmit` works). The frontend uses TypeScript 5.9 for Next compatibility.
- Scratch tools used for debugging (`one.cpp`, `cmp.cpp`, `dist.cpp`, `dbg.cpp`) were in the session scratchpad and are not needed.
- The engine image build takes about 75 s, because it runs the full `engine_tests` suite, including the oracle.
- The Mongo password is embedded in the connection URI in compose, so it must be URL-safe (hex).
