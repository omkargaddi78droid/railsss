// Benchmark on the real processed dataset.
//   bench [timetable.json] [num_random_queries] [date] [k_node] [max_labels]
// Prints load time, then per-query percentiles for engine time, and a sample itinerary.

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>
#include <vector>

#include "civil_time.h"
#include "router.h"

using namespace rail;

static double pct(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  return v[std::min(v.size() - 1, static_cast<size_t>(p * (v.size() - 1) + 0.5))];
}

int main(int argc, char** argv) {
  const std::string path = argc > 1 ? argv[1] : "../data/processed/timetable.json";
  const int n = argc > 2 ? std::atoi(argv[2]) : 300;
  const std::string date = argc > 3 ? argv[3] : "2026-09-25";
  RouterConfig cfg;
  if (argc > 4) cfg.k_node = std::atoi(argv[4]);
  if (argc > 5) cfg.max_labels = static_cast<uint32_t>(std::atoi(argv[5]));

  const auto t0 = std::chrono::steady_clock::now();
  const Timetable tt = load_timetable_json(path);
  const double load_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::printf("load: %.1f ms  stations=%zu trains=%zu stops=%zu max_span_days=%d  k_node=%d\n", load_ms, tt.stations.size(), tt.trains.size(),
              tt.stops.size(), tt.max_span_days, cfg.k_node);

  const Router router(tt, cfg);
  const int32_t day = *parse_date(date);

  // Sample itinerary for the headline query.
  {
    Query q{tt.find_station("BD"), tt.find_station("NDLS"), day, 600, 20};
    if (q.source >= 0 && q.destination >= 0) {
      const RouteResult r = router.route(q);
      std::printf("\nBD -> NDLS %s 10:00: %zu routes in %.2f ms (setup %.2f, profile %.2f, search %.2f; labels %llu popped %llu capped %llu)\n",
                  date.c_str(), r.journeys.size(), r.stats.total_ms, r.stats.setup_ms, r.stats.profile_ms, r.stats.search_ms,
                  (unsigned long long)r.stats.labels_created, (unsigned long long)r.stats.labels_popped, (unsigned long long)r.stats.pruned_by_cap);
      int rank = 0;
      for (const Journey& j : r.journeys) {
        std::printf("  #%-2d dep %s arr %s  %4lld min  transfers %d  wait %4d  ", ++rank, format_datetime(j.departure).c_str(),
                    format_datetime(j.arrival).c_str(), (long long)(j.arrival - j.departure), j.transfers, j.waiting_minutes);
        for (const Leg& l : j.legs) {
          const Train& t = tt.trains[l.train];
          std::printf("[%s %s>%s] ", t.number.c_str(), tt.stations[tt.stop(t, l.board_stop).station].code.c_str(),
                      tt.stations[tt.stop(t, l.alight_stop).station].code.c_str());
        }
        std::printf("\n");
      }
    }
  }

  // Random queries between stations served by >= 1 departure, fixed seed for reproducibility.
  std::vector<int32_t> candidates;
  for (int32_t s = 0; s < static_cast<int32_t>(tt.stations.size()); ++s)
    if (!tt.departures[s].empty()) candidates.push_back(s);
  std::mt19937 rng(42);
  std::uniform_int_distribution<size_t> pick(0, candidates.size() - 1);
  std::uniform_int_distribution<int> tod(0, 23);
  std::vector<double> total, profile, search;
  size_t found = 0, full = 0, truncated = 0;
  uint64_t max_labels = 0;
  double worst = 0;
  std::string worst_q;
  for (int i = 0; i < n; ++i) {
    Query q{candidates[pick(rng)], candidates[pick(rng)], day, tod(rng) * 60, 20};
    if (q.source == q.destination) continue;
    const RouteResult r = router.route(q);
    total.push_back(r.stats.total_ms);
    profile.push_back(r.stats.profile_ms);
    search.push_back(r.stats.search_ms);
    found += !r.journeys.empty();
    full += r.journeys.size() == 20;
    truncated += r.stats.truncated;
    max_labels = std::max<uint64_t>(max_labels, r.stats.labels_created);
    if (r.stats.total_ms > worst) {
      worst = r.stats.total_ms;
      worst_q = tt.stations[q.source].code + "->" + tt.stations[q.destination].code + " " + std::to_string(q.time_minute / 60) + ":00";
    }
  }
  std::printf("\n%zu random queries: with_route=%zu full_20=%zu truncated=%zu max_labels=%llu\n", total.size(), found, full, truncated,
              (unsigned long long)max_labels);
  std::printf("engine total ms  p50 %.2f  p90 %.2f  p95 %.2f  p99 %.2f  max %.2f (%s)\n", pct(total, .5), pct(total, .9), pct(total, .95),
              pct(total, .99), worst, worst_q.c_str());
  std::printf("profile ms       p50 %.2f  p95 %.2f\n", pct(profile, .5), pct(profile, .95));
  std::printf("search ms        p50 %.2f  p95 %.2f\n", pct(search, .5), pct(search, .95));
  return 0;
}
