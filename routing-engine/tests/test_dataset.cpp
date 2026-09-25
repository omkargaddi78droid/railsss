// Invariant checks on the real processed dataset (skipped if it has not been generated).
#include <filesystem>
#include <random>
#include <set>

#include "doctest.h"
#include "router.h"
#include "civil_time.h"

using namespace rail;

#ifndef RAIL_DATA_DIR
#define RAIL_DATA_DIR "../data/processed"
#endif

TEST_CASE("real dataset: every returned journey satisfies the routing rules") {
  const std::string path = std::string(RAIL_DATA_DIR) + "/timetable.json";
  if (!std::filesystem::exists(path)) {
    MESSAGE("skipped: " << path << " not found (run scripts/preprocess.ts)");
    return;
  }
  const Timetable tt = load_timetable_json(path);
  RouterConfig cfg;
  const Router router(tt, cfg);

  std::vector<int32_t> cand;
  for (int32_t s = 0; s < static_cast<int32_t>(tt.stations.size()); ++s)
    if (!tt.departures[s].empty()) cand.push_back(s);
  std::mt19937 rng(2026);
  int with_routes = 0, journeys = 0, multi_transfer = 0;

  auto check_query = [&](const Query& q) {
    const RouteResult r = router.route(q);
    REQUIRE(r.status != RouteStatus::InvalidQuery);
    const int32_t S = q.date_day * 1440 + q.time_minute;
    std::set<std::string> sigs;
    Journey const* prev = nullptr;
    for (const Journey& j : r.journeys) {
      ++journeys;
      multi_transfer += j.transfers >= 2;
      CHECK(sigs.insert(j.signature).second);  // unique
      REQUIRE_FALSE(j.legs.empty());
      CHECK(static_cast<int32_t>(j.legs.size()) <= cfg.max_transfers + 1);
      // first departure on the requested date, not before the requested time
      CHECK(j.departure >= S);
      CHECK(j.departure <= q.date_day * 1440 + 1439);
      CHECK(j.arrival <= S + cfg.horizon_minutes);
      std::set<int32_t> stations{q.source};
      std::set<uint32_t> trains;
      int32_t wait = 0, train_minutes = 0;
      for (size_t i = 0; i < j.legs.size(); ++i) {
        const Leg& l = j.legs[i];
        const Train& tr = tt.trains[l.train];
        CHECK(trains.insert(l.train).second);
        // operating day: the instance start date must be a running day
        CHECK(((tr.days_mask >> weekday(l.start_day)) & 1) == 1);
        REQUIRE(l.board_stop < l.alight_stop);
        REQUIRE(l.alight_stop < tr.num_stops);
        const int64_t base = static_cast<int64_t>(l.start_day) * 1440;
        CHECK(l.dep == base + tt.stop(tr, l.board_stop).dep);
        CHECK(l.arr == base + tt.stop(tr, l.alight_stop).arr);
        CHECK(l.arr >= l.dep);
        const int32_t from = tt.stop(tr, l.board_stop).station;
        CHECK(from != kNoStation);
        CHECK(tt.stop(tr, l.alight_stop).station != kNoStation);
        if (i == 0) CHECK(from == q.source);
        else {
          const Leg& p = j.legs[i - 1];
          CHECK(from == tt.stop(tt.trains[p.train], p.alight_stop).station);  // same station code
          CHECK(l.dep >= p.arr + cfg.min_transfer_minutes);                   // >= 30 min transfer
          wait += static_cast<int32_t>(l.dep - p.arr);
        }
        for (uint32_t k = l.board_stop + 1; k <= l.alight_stop; ++k) {
          const int32_t s = tt.stop(tr, k).station;
          if (s != kNoStation) CHECK(stations.insert(s).second);  // no station touched twice
        }
        train_minutes += static_cast<int32_t>(l.arr - l.dep);
      }
      CHECK(tt.stop(tt.trains[j.legs.back().train], j.legs.back().alight_stop).station == q.destination);
      CHECK(j.waiting_minutes == wait);
      CHECK(j.train_minutes == train_minutes);
      CHECK(j.transfers == static_cast<int32_t>(j.legs.size()) - 1);
      if (prev) {  // ranking order
        const auto kp = std::make_tuple(prev->arrival, -prev->departure, prev->transfers, prev->waiting_minutes);
        const auto kc = std::make_tuple(j.arrival, -j.departure, j.transfers, j.waiting_minutes);
        CHECK(kp <= kc);
      }
      prev = &j;
    }
    with_routes += !r.journeys.empty();
  };

  const int32_t day = *parse_date("2026-09-25");
  for (int i = 0; i < 200; ++i) {
    Query q{cand[rng() % cand.size()], cand[rng() % cand.size()], day + static_cast<int32_t>(rng() % 7), static_cast<int32_t>(rng() % 1440), 50};
    if (q.source == q.destination) continue;
    check_query(q);
  }
  // Headline query from the specification.
  check_query(Query{tt.find_station("BD"), tt.find_station("NDLS"), day, 600, 50});
  MESSAGE(with_routes << " queries with routes, " << journeys << " journeys checked, " << multi_transfer << " with >= 2 transfers");
  CHECK(with_routes > 100);
}
