# Railway Journey Routing

Given a source station, a destination, a date and an earliest start time, return the **20 unique valid
journeys that arrive earliest**, across any number of transfers (internal cap 10), with a 30-minute
minimum transfer, operating days and multi-day (overnight) schedules honored.

```
browser ──► Next.js frontend (:3000, published) ──► Node/Express API (:4000) ──► C++ routing engine (:7070)
                                                         │
                                                         └──► MongoDB (station master, trains, ingest reports)
```

- **routing-engine/**: C++20 long-running HTTP service. Loads the preprocessed timetable once and answers
  `POST /route` in single-digit to tens of milliseconds.
- **api/**: Express 5 + zod + pino. Validation, station search, route cache, filters, pagination.
- **frontend/**: Next.js 16 (App Router), React 19, Tailwind 4. Station autocomplete, results timeline,
  filters, pagination.
- **scripts/**: Node/TypeScript preprocessing pipeline: validation, cleaning, quality report, and the
  routing-optimized timetable.
- **MongoDB**: persistence for stations, trains and ingest reports. Hot routing never touches it.

Contents: [Quick start](#quick-start) · [Data](#data-findings-and-cleaning) ·
[Temporal model](#temporal-model) · [Problem](#problem-formulation) · [Algorithm](#routing-algorithm) ·
[Correctness](#correctness) · [Complexity](#complexity) · [API](#api) · [Frontend](#frontend) ·
[MongoDB](#mongodb-schema) · [Configuration](#configuration) · [Deployment](#deployment) ·
[Benchmarks](#benchmarks) · [Testing](#testing) · [Limitations](#known-limitations) ·
[Future work](#future-work)

---

## Quick start

### Docker (full stack)

```bash
cp .env.example .env            # set MONGO_ROOT_PASSWORD to a long random string
docker compose up -d --build    # builds the images, runs the engine test suite during the build, seeds MongoDB
docker compose ps               # mongo, engine, api and frontend should be "healthy"; seed "Exited (0)"
open http://localhost:${PUBLIC_PORT:-80}
```

Only the frontend is published. The API is reached through the frontend's same-origin proxy (`/api/*`),
and MongoDB, the engine and the API stay on internal networks.

### Local development (no Docker, except for an optional Mongo)

Requirements: Node ≥ 22.18 (24 recommended; it runs `.ts` files directly, so there is no build step),
g++ ≥ 13 or clang ≥ 17, CMake ≥ 3.20. All C++ dependencies are vendored in `routing-engine/third_party/`,
so builds work offline.

```bash
# 1. preprocess raw JSON -> data/processed/{timetable,stations,trains}.json + data/reports/quality-report.{json,md}
cd scripts && node preprocess.ts && cd ..

# 2. engine
cmake -S routing-engine -B routing-engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build routing-engine/build -j
routing-engine/build/engine_tests
TIMETABLE_PATH=data/processed/timetable.json routing-engine/build/routing_engine        # :7070

# 3. API (Mongo is optional; without MONGODB_URI the station master comes from stations.json)
cd api && npm ci && npm test
ENGINE_URL=http://127.0.0.1:7070 npm start                                               # :4000
#   optional: MONGODB_URI=mongodb://... npm run seed

# 4. frontend
cd frontend && npm ci && npx next build
API_INTERNAL_URL=http://127.0.0.1:4000 npx next start -p 3000
```

---

## Data findings and cleaning

Input: `backend/train_data/*.json` holds 1,725 files, each with one train record. The full generated report
is in `data/reports/quality-report.md`, and a machine-readable copy is in `quality-report.json` and in
MongoDB `ingest_reports`.

| Fact | Value |
|---|---|
| Records, unique train numbers, unique route ids | 1,725 each; no duplicate records |
| Stops | 30,796; per train min 2, median 17, max 35 |
| Stations | 2,897 raw codes, 2,894 after cleaning; 532 are served by only one train |
| `day_of_journey` | 1–4; the longest train spans 4,395 min (about 3 days) |
| Operating days | always 7 boolean keys; 522 trains run once a week, 720 daily |

Issues found, and what the pipeline does about them (default policy `correct`):

| Issue | Handling |
|---|---|
| `type` has trailing spaces (`"SUPERFAST "`); 30 raw values | Trimmed, leaving 19 types |
| Train number `"National"` is not 5 digits | Kept: train numbers are opaque strings |
| 5 placeholder codes (`Point(4)`, `Point(5)`, `""`) whose name is `"<NAME> <CODE> Train Reversal"` | The code is recovered from the name (e.g. `AMRITSAR ASR Train Reversal` becomes ASR). An unrecoverable placeholder would be kept as a non-boardable stop |
| Name variants for the same code (e.g. SWM "SAWAI MADHOPUR JN" ×68 / "SAWAI MADHOPUR" ×1) | Canonical name = most frequent. Every spelling is kept in `all_known_names` for search. MGR and BPR have conflicting names and are flagged |
| Same name used by different codes (DADAR = DDR/DR) | Codes are never merged; flagged |
| Sequence-number gaps (406 trains), order always ascending | Array order is authoritative |
| The same station twice in one train (4 loop trains) | Kept. The router boards and alights at different codes and never touches a station twice |
| 12881 and 12887 share a timetable but run on different days | Distinct trains, not duplicates |
| 12 h dwell (08450 at KON), zero-minute hops, empty `classes_available` (21 trains) | Warning only |
| Extra `platform` key, always `null` | Ignored |

Policies: `--policy strict` fails on any error, `correct` (the default) repairs what it can and rejects
only unrecoverable records, and `skip` drops any record that has an issue. With `correct`, 0 records are
rejected.

### Pipeline (`scripts/`)

`preprocess.ts` reads the raw files, then `lib/normalize.ts` (pure, unit-tested rules) runs these steps:

1. Validate the schema and the time formats.
2. Normalize (trim, recover codes, canonicalize names).
3. Compute absolute times using the rule below.
4. Check monotonicity.
5. Emit:
   - `timetable.json`: compact, routing-oriented. Stations, trains with day bitmasks, and stops as minutes
     relative to the train's start date.
   - `stations.json`: the station master with `train_count`.
   - `trains.json`: full normalized records for MongoDB.
   - The quality report.

---

## Temporal model

All times are naive IST minutes (India has no DST).

**Overnight rule, the key data finding.** `day_of_journey` (doj) is the day of the **departure** from a
stop. So:

```
dep_abs = (doj − 1)·1440 + dep_hhmm
arr_abs = (doj − 1)·1440 + arr_hhmm − (arr_hhmm > dep_hhmm ? 1440 : 0)    // arrived before midnight, left after
at the terminus (no departure), doj applies to the arrival
```

Example: KUR arrives 23:45 and departs 00:05 with doj = 2, so it arrives on day 1 and departs on day 2.
With this rule, all 30,796 stops are monotone (0 violations). The common "add a day whenever the clock
wraps" unrolling is **wrong** for this data, giving 1,072 mismatches, because some consecutive listed stops
are more than 24 h apart (the longest hop is 3,512 min).

**Operating days** refer to the train's **start date** (doj 1). A train instance exists on date D iff
`operating_days[weekday(D)]`. For a query on date Q, instances that started on Q−3 … Q+4 are considered.
This covers trains already en route on Q and journeys that continue for several days.

---

## Problem formulation

- A **train instance** is (train, start date) for each operating start date.
- A **leg** is (instance, board stop i, alight stop j) with i < j, where both stops are real stations and
  have different codes.
- A **journey** J = (L₁ … Lₙ) satisfies:
  - L₁ boards at the source and Lₙ alights at the destination.
  - Lₖ₊₁ boards at the station where Lₖ alighted.
  - `dep(Lₖ₊₁) ≥ arr(Lₖ) + 30`. The minimum transfer time is configurable and must be at least 1.
  - The first departure lies in `[Q + time, Q 23:59]`. Later legs may be on any day.
  - **No station is touched twice**, including stations ridden through without stopping. This rules out
    A→B→A and back-and-forth routes.
  - Each train number is used at most once.
  - n − 1 ≤ `MAX_TRANSFERS_INTERNAL` (10).
  - Arrival ≤ Q + time + horizon (4 days by default).
- **Ranking** is lexicographic by (arrival, −first departure, transfers, total transfer waiting,
  signature). Among journeys that arrive at the same time, the one that leaves later, then the one with
  fewer transfers, then the one with less waiting wins.
- **Uniqueness**: the signature is `train:FROM>TO|…` with no dates. The same itinerary on a later day is a
  duplicate, and only its earliest (best-ranked) occurrence is kept.
- **Dominance** (exact, see below): a journey is dropped when a strictly better journey exists that does
  not change trains needlessly.

Output: the top K = 20 journeys, or fewer if fewer exist.

---

## Routing algorithm

Why not the textbook algorithms:

- **Dijkstra, CSA and RAPTOR** compute one earliest arrival, or a Pareto set over (arrival, transfers).
  They cannot produce the 20 best distinct journeys.
- **Yen's K-shortest paths on a time-expanded graph** needs a graph with about 60k event nodes per day and
  K rounds of spur searches, each a full shortest-path run. That is too slow for interactive use, and the
  "no repeated station" rule does not map cleanly to Yen's node removals.

The engine combines an exact **backward profile** with **best-first K-best enumeration**:

### 1. Per-weekday precomputed patterns (at startup)

For each of the 7 weekdays, the engine precomputes:

- The train instances relevant to a query on that weekday, with start-day offsets relative to the query
  date.
- All their elementary connections (stop i → i+1), pre-sorted by departure time, descending.

Times are stored relative to 00:00 of the query date, so one structure serves every date with that
weekday. There is no per-query sorting, and query setup takes about 0.2 ms.

### 2. Backward Connection-Scan profile (per query, O(C))

One scan over the connections, from the destination, restricted to [query time, query time + horizon],
computes:

- `T[inst][stop]`: the exact earliest arrival at the destination for a passenger on board `inst` at `stop`.
  The value is lexicographic: (arrival, remaining transfers).
- A step function per station: the earliest arrival at the destination when standing at station s from
  time t, respecting the 30-min transfer rule.

The profile relaxes the loop, train-reuse and transfer-cap rules, so its values are **lower bounds** on
what any valid continuation can achieve.

### 3. Best-first (A\*) K-best enumeration

Labels are partial journeys: `Root`, `Onboard(inst, stop)` and `AtStation(station, time)`, stored in an
arena with parent pointers. The priority key is

```
(arrival lower bound from the profile, −first departure, transfer lower bound, waiting, label id)
```

- From the source, every instance departing in the first-departure window is boarded.
- **On board**, the passenger can ride to the next stop, or alight at the current one.
- **At a station** at time a, the passenger can board any instance departing at ≥ a + 30. The engine
  finds these with a binary search in the station's departure index.
- The parent chain is per leg, so checking "station already touched" walks at most about 11 legs. It
  uses a 64-bit bloom filter plus `train_calls_at` binary searches.
- A label whose bound is infinite, exceeds the horizon, or exceeds the transfer cap is never created.

When a completed journey is popped, it is final (see Correctness). It is dropped if its signature was
already emitted or if a dominance rule applies. The search stops after 20 accepted completions.

### 4. Dominance rules (exact)

These rules only remove a journey J when a **strictly better valid** journey J′ is guaranteed to exist.
J′ arrives no later, departs no earlier, has fewer transfers and is loop-free, so the top-20 never contains
pointless train changes:

- **Stay-on** (applied during the search): J alights from train X, but X itself reaches the destination
  without touching J's earlier stations. Then J must arrive strictly earlier than X, or it is dropped.
  A generalized version runs on completion: X reaches the alighting station of a later leg of J.
- **Board-earlier** (checked on completion only): J boards an instance that was already boardable at an
  earlier point where the passenger stood (the source or an earlier transfer station). J′ boards it there
  instead. Doing this check during the search was shown to be unsound; the regression test is the JHN→DUMK
  case. So it runs only on completed journeys, where J′ can be verified to be loop-free.

A "prefix dominance" rule was prototyped and removed: it conflicts with the user-side filters, and it
brought no speedup once the profile bound was in place.

### 5. Budgets

- `MAX_LABELS` (default 200,000) is a deterministic per-query work budget. Completed journeys are still
  popped in exact rank order, so hitting the budget never returns a wrong or misordered journey. It can
  only return **fewer than 20**, and it reports `search_complete: false`. This happens for about 1.5 % of
  random station pairs.
- `K_NODE` (default 0 = off) optionally caps labels per train event. It is a heuristic: when it is
  enabled, the result is no longer guaranteed to be the exact top-20.

---

## Correctness

| Claim | Argument |
|---|---|
| Bound is admissible | The profile solves a relaxation (no loop, train-reuse or transfer-cap rules) over the same connections and the same 30-min rule, so its value ≤ the arrival of any valid completion |
| Bound is consistent, and keys are monotone | Extending a label (ride, alight, transfer and board) can only restrict options, so the bound never decreases along a path. The tie-break components are fixed once the first leg is chosen (first departure) or only grow (transfers, waiting) |
| Completions are popped in exact rank order | A* with a consistent key: when a completed journey is popped, every unexplored label has key ≥ its key, so nothing better can appear later |
| Transfer rule | Boarding at a station requires `dep ≥ arr + min_transfer`. Staying on the same train is not a transfer |
| Operating days and overnight | Instances are only generated for operating start dates, and absolute times come from the doj rule above (validated as 0 monotonicity violations on the full dataset) |
| Uniqueness | Signatures are compared in rank order, and the first occurrence is kept |
| Dominance soundness | Each rule constructs J′ explicitly and checks it is valid and strictly better. Board-earlier is applied only on completion, where this check is exact |
| Budget | It truncates the output list and never reorders it |

These claims are verified by tests (see [Testing](#testing)), including exact equality against a
brute-force enumerator on about 22,700 random small networks.

---

## Complexity

With C ≈ 130k connections in a query's horizon, L = labels created, and d = departures per station:

- Startup: O(C log C) once per weekday pattern. Loading plus pattern building takes about 100–360 ms.
- Profile: O(C) per query.
- Search: O(L log L) for the heap, plus O(log d) per boarding lookup. The loop check per label is O(legs)
  ≤ 11. The exact bound keeps L small: about 3.5k labels at the median and 22k at p90, capped by `MAX_LABELS`.
- Memory: timetable plus patterns about 100 MB resident. Per query O(C + L), using thread-local arenas.

---

## API

Base: `/api` (through the frontend proxy, or directly on the API at `:4000`).

### `GET /health` (also `/api/health`)

Returns 200 when healthy and 503 otherwise:

```json
{ "status": "healthy",
  "checks": { "engine": "up", "stations": { "count": 2894, "source": "mongodb" }, "mongo": "connected" },
  "engine": { "load_ms": 364, "requests": 0, "config": { "min_transfer_minutes": 30, "top_k": 20, "...": "..." } } }
```

### `GET /api/stations?q=<prefix>&limit=10`

Prefix search on station code and on any known name. Ranking: exact code, then code prefix, then name
prefix, then by `train_count`.

```json
{ "query": "ndl", "stations": [ { "code": "NDLS", "name": "NEW DELHI", "label": "NEW DELHI (NDLS)", "train_count": 118 } ] }
```

`GET /api/stations/:code` returns a single station, or 404.

### `POST /api/routes`

```json
{ "source": "BD", "destination": "NDLS", "date": "2026-09-25", "time": "10:00",
  "limit": 5, "page": 1,
  "filters": { "max_duration_minutes": 2000, "max_transfers": 2, "direct_only": false } }
```

The schema is strict: unknown fields are rejected. `limit` is 1–20 (default 20). `max_duration_minutes`
is ≤ 3000.

Response:

```jsonc
{
  "query": { "source": "BD", "destination": "NDLS", "source_name": "BADNERA JN.", "destination_name": "NEW DELHI",
             "date": "2026-09-25", "time": "10:00", "search_datetime": "2026-09-25T10:00:00" },
  "routes": [{
    "rank": 1, "id": "01211:BD>AK|22894:AK>BSL|12534:BSL>BPL|12723:BPL>NDLS|",
    "source": { "code": "BD", "name": "BADNERA JN." }, "destination": { "code": "NDLS", "name": "NEW DELHI" },
    "departure_datetime": "2026-09-25T10:05:00", "arrival_datetime": "2026-09-26T08:00:00",
    "duration_minutes": 1315, "total_elapsed_duration_minutes": 1320, "initial_wait_minutes": 5,
    "train_travel_minutes": 1152, "waiting_minutes": 163,
    "transfer_count": 3, "segment_count": 4, "is_direct": false, "distance_km": 1318,
    "train_numbers": ["01211", "22894", "12534", "12723"],
    "segments": [{
      "train_number": "01211", "train_name": "BD-NK SPL", "train_type": "TRAIN ON DEMAND", "train_start_date": "2026-09-25",
      "from_station": { "code": "BD", "name": "BADNERA JN." }, "to_station": { "code": "AK", "name": "AKOLA JN." },
      "departure_datetime": "2026-09-25T10:05:00", "arrival_datetime": "2026-09-25T11:02:00",
      "duration_minutes": 57, "distance_km": 79, "stop_count": 3,
      "stops": [
        { "code": "BD",  "name": "BADNERA JN.",    "arrival_datetime": null, "departure_datetime": "2026-09-25T10:05:00", "distance_km": 0,  "boardable": true },
        { "code": "MZR", "name": "MURTAJAPUR JN.", "arrival_datetime": "2026-09-25T10:30:00", "departure_datetime": "2026-09-25T10:32:00", "distance_km": 41, "boardable": true }
        // ...
      ] }
      // ... 3 more segments
    ],
    "transfers": [
      { "station": { "code": "AK", "name": "AKOLA JN." }, "arrival_datetime": "2026-09-25T11:02:00", "departure_datetime": "2026-09-25T12:15:00", "wait_minutes": 73 }
      // ...
    ]
  }],
  "filters_applied": {},
  "pagination": { "page": 1, "limit": 5, "returned": 5, "total_available": 20, "total_unfiltered": 20, "total_pages": 4, "max_results": 20 },
  "meta": { "cached": false, "search_complete": true, "engine_ms": 10.2, "api_ms": 21.4 }
}
```

The engine always computes the full top-20 once. That result is cached, and `limit`, `page` and `filters`
only slice it, so paging or toggling filters never triggers a second routing run. Ranks refer to the
unfiltered ranking, so they stay stable while filters change.

| Case | Status | Body |
|---|---|---|
| Bad field, format or unknown key | 400 | `error.code = VALIDATION_ERROR`, with details |
| Unknown station code, or source = destination | 400 | `UNKNOWN_STATION` / `VALIDATION_ERROR` |
| Malformed JSON | 400 | `INVALID_JSON` |
| No route | 200 | `routes: []`, `message: "No valid journey found for the specified date and time."` |
| Filters exclude everything | 200 | `routes: []`, `message: "No journey matches the selected filters."` |
| Engine down, timed out or saturated | 503 | `ENGINE_UNAVAILABLE` |

### API internals

- **Route cache**: an LRU with TTL. The key is `src|dst|date|time|engine-config-hash`, and the cache
  **coalesces in-flight requests**: concurrent identical queries share one engine call.
- **Engine client**: keep-alive `fetch`, a timeout that covers queueing as well as the call, and a FIFO
  semaphore (`ENGINE_CONCURRENCY`). The semaphore matters because cpp-httplib holds a worker thread for
  each open keep-alive connection. Without it, a burst opens more sockets than the engine has threads, and
  the extra requests stall for the 5 s keep-alive timeout. This was found by the load test.
- **Filters**: a registry in `src/services/filters.ts`. A new filter is one entry: a schema field plus a
  predicate.
- **Logging**: structured pino JSON with a per-request `req_id`, which is propagated from the frontend
  proxy.

---

## Frontend

Next.js App Router. `app/page.tsx` is a client component. Its URL state (`?from&to&date&time`) makes
searches shareable and supports the back button.

- `components/StationPicker`: debounced autocomplete against `/api/stations`, with keyboard navigation.
- `components/SearchForm`: stations, a swap button, date and time.
- `components/JourneyCard`: summary (departure → arrival, duration, transfers, train chips), a vertical
  timeline per segment with transfer waits, "+1 day" badges on times after the search date, and
  expandable intermediate stops.
- `components/FilterPanel`: direct only, max transfers, and max duration (a slider up to 3000 min). The
  predicates live in a registry in `lib/filters.ts`. The frontend fetches the top 20 once, then filters
  and paginates (5 per page) on the client with no extra requests.
- `app/api/[...path]/route.ts`: a same-origin runtime proxy to `API_INTERNAL_URL`. The browser never talks
  to the API directly (no CORS setup is needed), and one image works in every environment.
- Supports dark mode via `prefers-color-scheme`. The standalone output is the Docker runtime image.

---

## MongoDB schema

Database `railway` (`MONGODB_DB`). The one-shot `seed` service (`npm run seed`) upserts the normalized data
and removes stale documents, so it can be re-run safely.

| Collection | Document | Indexes |
|---|---|---|
| `stations` | `{ code, name, all_known_names[], train_count, updated_at }` | `code` unique, `name`, `train_count` |
| `trains` | `{ number, name, type, route_id, operating_days, classes_available, stops[{ code, name, seq, arr, dep, day, distance_km }], … }` | `number` unique, `stops.code`, `type` |
| `ingest_reports` | `{ generated_at, raw, cleaned, issue_counts }` | `generated_at` |

At boot, the API loads the station master from Mongo into memory (a sorted array for prefix search). If
Mongo is unavailable or empty, it falls back to `stations.json`. Routing reads only the engine's
in-memory timetable.

---

## Configuration

All settings come from environment variables. See `.env.example`.

| Service | Variable | Default | Meaning |
|---|---|---|---|
| engine | `TIMETABLE_PATH` | `/data/timetable.json` | Preprocessed timetable |
| | `ENGINE_HOST` / `ENGINE_PORT` | `0.0.0.0` / `7070` | |
| | `ENGINE_THREADS` | 8 | HTTP worker threads. One is held per open connection, so keep it above the API's `ENGINE_CONCURRENCY` |
| | `MIN_TRANSFER_MINUTES` | 30 | Minimum transfer time (≥ 1) |
| | `MAX_TRANSFERS_INTERNAL` | 10 | Transfer cap |
| | `TOP_K` | 20 | Results computed |
| | `SEARCH_HORIZON_MINUTES` | 5760 | Arrival must fall within this window |
| | `MAX_LABELS` | 200000 | Deterministic work budget per query |
| | `K_NODE` | 0 | Heuristic per-event cap (0 = exact) |
| | `PRUNE_STAY_ON` / `PRUNE_BOARD_EARLIER` | 1 / 1 | Dominance rules |
| api | `API_PORT`, `API_HOST` | 4000, `0.0.0.0` | |
| | `ENGINE_URL` | `http://127.0.0.1:7070` | |
| | `ENGINE_TIMEOUT_MS` | 5000 | Includes queueing time |
| | `ENGINE_CONCURRENCY` | 4 | Maximum in-flight engine calls per API instance |
| | `MONGODB_URI`, `MONGODB_DB` | unset, `railway` | Mongo is optional outside Docker |
| | `STATIONS_FILE` | `data/processed/stations.json` | Fallback station master |
| | `CACHE_ENABLED`, `CACHE_MAX_ENTRIES`, `CACHE_TTL_SECONDS` | true, 1000, 3600 | Each entry holds about 100 KB of parsed results |
| | `CORS_ORIGIN`, `LOG_LEVEL` | unset, `info` | |
| frontend | `API_INTERNAL_URL` | `http://127.0.0.1:4000` | Proxy target |
| compose | `PUBLIC_PORT` | 80 | Published frontend port |
| | `MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD` | (required) | Use a URL-safe password: it is embedded in the Mongo URI |

---

## Deployment

### Docker Compose

`docker-compose.yml` (project `railway-routing`) defines:

- `mongo`: `mongo:8`, a named volume, and a `mongosh` ping healthcheck.
- `engine`: a multi-stage build. Stage 1 preprocesses the raw data, stage 2 compiles **and runs
  `engine_tests`** (so a failing test fails the image build), and stage 3 is a slim Debian runtime with a
  non-root user.
- `seed`: a one-shot job using the API image. It runs after Mongo is healthy.
- `api`: starts after the engine is healthy and the seed has completed successfully. Node 24 Alpine,
  non-root.
- `frontend`: the Next.js standalone server. It is the only published port.
- Networks: `backend` (mongo, engine, api) and `frontend` (api, frontend).
- Every service has a healthcheck, `restart: unless-stopped`, and rotated json-file logs (10 MB × 5).

### AWS EC2

1. Launch Ubuntu 24.04 on **t3.small or larger** (2 vCPU, 2 GB RAM; t3.medium gives headroom for the
   route cache). Use a 20 GB gp3 disk.
2. Security group: inbound 22 (your IP only), 80 and 443. Nothing else: Mongo, the engine and the API
   are not published.
3. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # then log out and back in
   ```
4. Deploy:
   ```bash
   git clone <repo> railway && cd railway
   cp .env.example .env && sed -i "s/^MONGO_ROOT_PASSWORD=.*/MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)/" .env
   docker compose up -d --build
   ```
5. **TLS (recommended):** set `PUBLIC_PORT=8080`, then put Caddy in front of it. Caddy obtains
   certificates automatically:
   ```
   # /etc/caddy/Caddyfile
   rail.example.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```
   Alternatively, add Caddy as a fourth compose service on the `frontend` network. nginx with certbot
   works the same way.
6. Updates: `git pull && docker compose up -d --build`. The seed re-runs idempotently.
   Logs: `docker compose logs -f api engine`.

---

## Benchmarks

Machine: 12-core x86-64 Linux, Docker Engine 29. Queries are uniformly random station pairs and times
on 2026-09-25, and about 70 % of the pairs have at least one route.

### Engine only (`routing-engine/build/bench`, 1000 queries, single thread)

| Metric | Value |
|---|---|
| Timetable load + pattern build | 100–360 ms (364 ms inside Docker) |
| p50 / p90 / p95 / p99 / max | 7.3 / 15.6 / 23.5 / ~100 / ~170 ms |
| Budget hit (`search_complete=false`) | ~1.5 % of queries |
| BD → NDLS, 2026-09-25 10:00 | 20 routes in ~10 ms |

### End to end (`npm run bench` in `api/`, autocannon, 20 s runs)

The API is benchmarked from a container on the compose network. The public path goes through the Next.js
proxy on `PUBLIC_PORT`.

| Scenario | Throughput | Client p50 / p90 / p99 | Server engine_ms p50 / p99 | Server api_ms p50 / p99 |
|---|---|---|---|---|
| API direct, cold (every query unique), 1 connection | ~33 req/s | 26 / 44 / 105 ms | 8.0 / 90 ms | 21 / 101 ms |
| API direct, cached, 10 connections | ~300 req/s | 27 / 51 / 92 ms | none (cache hits) | 0.15 / 0.5 ms |
| Public path (Next proxy), cold, 1 connection | ~20 req/s | 45 / 71 / 207 ms | 10.2 / 177 ms | 28 / 191 ms |
| Public path, cold, 10 connections | ~68 req/s | 138 / 200 / 289 ms | 13.0 / 110 ms | 75 / 227 ms |
| Public path, cached, 10 connections | ~113 req/s | 83 / 114 / 143 ms | none | 0.15 / 0.6 ms |

Where the time goes for a cold request (medians):

| Stage | Time |
|---|---|
| Routing (profile + search) | ~8 ms |
| Engine JSON serialization (nlohmann, about 100 KB for 20 routes with all stops) | ~6 ms |
| API: parse the engine response, shape it, and serialize | ~7 ms |
| Next.js proxy hop | ~20 ms |

At 10 connections, `api_ms` includes queueing for the 4 engine slots, which is intentional backpressure.

Two issues were found and fixed by the load test:

1. **Five-second stalls.** cpp-httplib dedicates a thread to each keep-alive connection. With 4 engine
   threads and 10 API sockets, requests stalled until keep-alive expired, which caused 15 × 503 errors in
   20 s and a 5 s p99. The fix is the API-side `ENGINE_CONCURRENCY` semaphore plus 8 engine threads. After
   the fix there were 0 errors.
2. **Nagle + delayed ACK.** httplib writes headers and body separately. Enabling `TCP_NODELAY` cut API
   p50 from 34 to 21 ms.

Reproduce:

```bash
cd api && npm run bench -- --mode cold --connections 10 --duration 20 --url http://localhost:8080
#   --mode cached   warms 50 queries, then replays them
```

---

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Preprocessing (9 tests) | `cd scripts && npm test` | Overnight rule (including KUR 23:45/00:05 doj 2), code recovery, name canonicalization, policies |
| Engine (25 cases, about 258k assertions) | `routing-engine/build/engine_tests` | See below |
| API (10 tests) | `cd api && npm test` | Validation and error codes, pagination, filters, cache and coalescing, no-route message, engine-down 503, semaphore |
| Types | `cd api && npx tsc --noEmit` | |
| Frontend build | `cd frontend && npx next build` | Type check and build |

The engine suites are:

- `test_time`: civil date/time arithmetic.
- `test_router`: hand-built scenarios:
  - A 30-min transfer is accepted and a 29-min one rejected.
  - A next-day first departure is rejected.
  - Instances that started the previous day are used.
  - A 2-transfer journey beats a direct train.
  - Loop trains, no station touched twice, and duplicate signatures.
  - Each dominance rule, including the JHN→DUMK regression.
  - Budget semantics.
- `test_oracle`: **differential testing** against a brute-force enumerator on random small timetables.
  The top-K must be identical. The default is 250 iterations; soak runs use
  `ORACLE_ITERS=1500 ORACLE_SEED=n`. About 22,700 queries across seeds have been checked with 0
  mismatches.
- `test_dataset`: real-data invariants over 200 random queries plus BD→NDLS:
  - Valid chaining and transfers of at least 30 minutes.
  - Monotone times and no repeated stations.
  - Unique signatures and sorted ranks.
  - Operating days respected.

---

## Known limitations

- **Work budget**: about 1.5 % of random queries (typically distant, poorly connected pairs) hit
  `MAX_LABELS` and return fewer than 20 journeys. The results returned are still exact and in rank order,
  and the response is flagged `search_complete: false`. Raising the budget trades latency for
  completeness.
- **Time zone**: naive IST, with no DST handling (none is needed in India).
- No platform, fare or seat-availability data. `platform` is always null in the source data.
- The minimum transfer is one global value, not per station.
- `K_NODE > 0` makes the search approximate. It is off by default.
- The route cache is per API process, and each entry costs about 100 KB of memory. Size
  `CACHE_MAX_ENTRIES` to the host.

## Future work

- A binary, memory-mapped timetable format, for faster cold starts and a smaller image.
- A streaming JSON writer in the engine to replace nlohmann trees (about 6 ms per request), and returning
  the engine's bytes through the API without re-serializing.
- Caching backward profiles per (destination, date window), which is reusable across sources.
- RAPTOR-style round pruning to shrink the label space for long-distance pairs.
- Horizontal scaling: engine replicas behind the API (they are stateless), and a shared cache (e.g.
  Redis) across API instances.
- Per-station minimum transfer times, if such data becomes available.
