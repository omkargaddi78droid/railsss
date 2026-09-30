# Handoff: railway routing project

Read this first in a new session. The README describes the system; this file says where things stand.
The session-by-session history is in git (`git log`, and earlier versions of this file).

## State (2026-09-30)

Everything is built, tested and pushed (`origin` = github.com/omkargaddi78droid/railsss, branch `main`).
What is left is work only the user can do:

1. **Run the remaining experiments on AWS.** E1 is done (`loadtest/results/E1/`, 6 variants × 3 repeats).
   Next is E8, then the rest, in the order of `docs/next_sequence_commands.md`. The procedure and what to
   watch is `docs/experiment-runbook.md`.
2. **Write the explanations** in `docs/load-test-report.md`. `node loadtest/analyze.ts` regenerates the
   tables and charts in `docs/load-test/` after every `controller.sh pull`.

Before the next run:
- `terraform apply` in `deploy/terraform/main` (the security-group rule for SSH from the k6 host).
- Rebuild the images once (`deploy/images.sh`): the engine and API changed after E1 (`X-Inflight`,
  `least_reported`). Step 0 of `docs/next_sequence_commands.md`.
- E1 `w4` and `w8` ended their ramp at `MAX_RATE` before the SLO broke, so their capacity is a lower bound.
  To get real values: `deploy/controller.sh run E1 --variants w4,w8 PER_WORKER_RPS=80 --force`.

Untracked on purpose: `screenshots/` (Grafana images of E1 and E8; move them to
`loadtest/results/screenshots/<EXP>/` so `pack.ts` includes them), `skills-lock.json`.

## Where things are

| Need | Look at |
|---|---|
| What the system is and how it works | `README.md` |
| Study design and experiment catalogue | `docs/scaling-plan.md`, `loadtest/experiments.ts` |
| Running experiments | `docs/experiment-runbook.md`, `docs/next_sequence_commands.md`, `deploy/README.md` |
| Results | `docs/load-test/results.md` (generated), `docs/load-test-report.md` (written) |
| Handing results to another LLM | `node loadtest/pack.ts`, `docs/analysis-llm-prompt.md` |

## Verify

```bash
cd scripts && npm test                                    # 15 tests
cmake --build routing-engine/build -j && routing-engine/build/engine_tests   # 27 cases
cd api && npm test && npx tsc --noEmit                    # 39 tests
node --test loadtest/test/*.test.ts                       # 33 tests
node loadtest/run.ts --list && node loadtest/run.ts E8 --dry-run
node loadtest/analyze.ts                                  # rewrites docs/load-test/
docker compose up -d --build                              # the app on http://localhost:${PUBLIC_PORT}
docker compose -f loadtest/local/compose.yml up -d --build && loadtest/local/k6.sh smoke   # rehearsal stack
```

## Decisions already made (do not re-ask)

- Scope: learning-focused comparisons. A production deployment is not the goal.
- AWS: exactly 10 × m7i-flex.large for the study, never more; k6 on one extra host in another account.
  Terraform plus shell scripts. Region in use: us-east-1.
- Request handling stays in Node/Express; the C++ engine only computes.
- No in-process result cache: Redis only, plus the one-shot cache-warmer.
- Load tests never go through Next.js: k6 → nginx → Node API → workers.
- Experiments run on the k6 host (the controller), not the laptop.
- After E8 the study runs on `gw2-cluster2` (`API_HOSTS=2 NODE_CLUSTER=2`, 14 workers); E2, E3 and E14 stay
  on the default layout. `C16` comes from E1 `w16`, `C14` from E8 `gw2-cluster2`.
- E5 and E6 stay out of scope (reasons in `loadtest/experiments.ts`).
- Report: Markdown in the repo. Both `analyze.ts` and the LLM prompt are kept.
- Not wanted: API rate limiting, request-id propagation to the engine, worker memory caps, frontend tests,
  CI, a Makefile, more algorithm work on the engine's tail latency.
- Frontend filters are the reduced set (direct only, max changes, min change time, max wait, excluded
  trains) in a bar above a two-column layout.

## Gotchas

- Node 24 runs `.ts` directly but only erasable syntax: no enums, no parameter properties, imports with
  the `.ts` extension.
- k6 reruns with the same `SEED` are Redis cache hits, so the engines sit idle. Use `SEED=$RANDOM` or flush
  Redis for an uncached measurement. `run.ts` flushes on every deploy.
- The timetable is deterministic and hashed (FNV-1a 64). The API refuses to start if the engine's hash
  differs: build both images from the same commit. Flush Redis after a timetable change.
- cpp-httplib parks one thread per keep-alive connection: `ENGINE_THREADS` must be at least
  `ENGINE_CONCURRENCY` × API processes.
- `getaddrinfo` for a stopped container's name blocks a libuv thread for about 5 s; the pool's health
  checks therefore resolve with c-ares.
- Docker here is Docker Desktop (a VM): bind mounts from `/tmp` are denied and `network_mode: host` ports
  are not reachable from the laptop. SELinux is enforcing: bind-mounted services need
  `security_opt: label=disable`.
- The Mongo password is embedded in the connection URI, so it must be URL-safe.
- The engine image build takes about 75 s because it runs the whole engine test suite.
- `pkill -f <name>` inside a shell command whose own text contains that name kills the shell; put it in a
  script file.
- Map tiles: CARTO now needs an API key; Esri's grey canvas is used. Tailwind 4 custom classes must be
  inside `@layer components`.
- Mermaid diagrams in the docs were checked with `docker run minlag/mermaid-cli` (mount a folder inside the
  repo, not `/tmp`).
