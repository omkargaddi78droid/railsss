// Differential test: the engine against an exhaustive brute-force enumeration of every valid journey
// on random small timetables. The oracle shares no search code with the engine; dominance rules are
// expressed declaratively ("the dominating alternative J' is itself a valid journey").
#include <algorithm>
#include <cstdlib>
#include <map>
#include <random>
#include <set>
#include <tuple>

#include "doctest.h"
#include "synthetic.h"

using namespace rail;
using namespace rail::test;

namespace {

struct OLeg {
  uint32_t train;
  int32_t start_day;
  uint32_t b, a;
  int32_t dep, arr;
  bool operator<(const OLeg& o) const { return std::tie(train, start_day, b, a) < std::tie(o.train, o.start_day, o.b, o.a); }
  bool operator==(const OLeg& o) const { return std::tie(train, start_day, b, a) == std::tie(o.train, o.start_day, o.b, o.a); }
};
using OJourney = std::vector<OLeg>;
using Key = std::tuple<int32_t, int32_t, int32_t, int32_t>;  // arrival, -first dep, transfers, waiting

Key key_of(const OJourney& j) {
  int32_t wait = 0;
  for (size_t i = 1; i < j.size(); ++i) wait += j[i].dep - j[i - 1].arr;
  return {j.back().arr, -j.front().dep, static_cast<int32_t>(j.size()) - 1, wait};
}

struct Oracle {
  const Timetable& tt;
  RouterConfig cfg;
  Query q;
  int32_t S, Qend, E;
  std::vector<std::pair<uint32_t, int32_t>> instances;  // (train, start day)
  std::vector<OJourney> all;

  Oracle(const Timetable& t, RouterConfig c, Query qq) : tt(t), cfg(c), q(qq) {
    S = q.date_day * 1440 + q.time_minute;
    Qend = q.date_day * 1440 + 1439;
    E = S + cfg.horizon_minutes;
    for (uint32_t tr = 0; tr < tt.trains.size(); ++tr)
      for (int32_t d = q.date_day - tt.max_span_days; d <= E / 1440; ++d)
        if ((tt.trains[tr].days_mask >> weekday(d)) & 1) instances.push_back({tr, d});
  }

  int32_t st(uint32_t tr, uint32_t k) const { return tt.stop(tt.trains[tr], k).station; }

  void dfs(int32_t s, int32_t lo, int32_t hi, OJourney& cur, std::set<int32_t>& visited, std::set<uint32_t>& used) {
    for (auto [tr, d] : instances) {
      if (used.count(tr)) continue;
      const Train& T = tt.trains[tr];
      for (uint32_t b = 0; b + 1 < T.num_stops; ++b) {
        if (st(tr, b) != s) continue;
        const int32_t dep = d * 1440 + tt.stop(T, b).dep;
        if (dep < lo || dep > hi) continue;
        std::vector<int32_t> added;
        for (uint32_t a = b + 1; a < T.num_stops; ++a) {
          const int32_t x = st(tr, a);
          if (visited.count(x)) break;
          visited.insert(x);
          added.push_back(x);
          const int32_t arr = d * 1440 + tt.stop(T, a).arr;
          if (arr > E) break;
          cur.push_back({tr, d, b, a, dep, arr});
          if (x == q.destination) {
            all.push_back(cur);
          } else if (static_cast<int32_t>(cur.size()) <= cfg.max_transfers) {
            used.insert(tr);
            dfs(x, arr + cfg.min_transfer_minutes, E, cur, visited, used);
            used.erase(tr);
          }
          cur.pop_back();
        }
        for (int32_t x : added) visited.erase(x);
      }
    }
  }

  std::vector<std::pair<Key, std::string>> run() {
    OJourney cur;
    std::set<int32_t> visited{q.source};
    std::set<uint32_t> used;
    dfs(q.source, S, std::min(Qend, E), cur, visited, used);
    std::set<OJourney> valid(all.begin(), all.end());

    auto dominated = [&](const OJourney& J) {
      const size_t n = J.size();
      if (cfg.prune_stay_on) {
        for (size_t li = 0; li + 1 < n; ++li) {
          const Train& T1 = tt.trains[J[li].train];
          for (size_t m = li + 1; m < n; ++m) {
            const int32_t z_station = st(J[m].train, J[m].a);
            for (uint32_t z = J[li].a + 1; z < T1.num_stops; ++z) {
              if (st(J[li].train, z) != z_station) continue;
              const int32_t arr = J[li].start_day * 1440 + tt.stop(T1, z).arr;
              if (arr > J[m].arr) break;
              OJourney alt(J.begin(), J.begin() + li);
              alt.push_back({J[li].train, J[li].start_day, J[li].b, z, J[li].dep, arr});
              alt.insert(alt.end(), J.begin() + m + 1, J.end());
              if (valid.count(alt)) return true;
              break;
            }
          }
        }
      }
      if (cfg.prune_board_earlier) {
        for (size_t li = 1; li < n; ++li) {
          const Train& T = tt.trains[J[li].train];
          for (size_t m = 0; m < li; ++m) {
            const int32_t p = m == 0 ? q.source : st(J[m - 1].train, J[m - 1].a);
            const int32_t lo = m == 0 ? std::max(S, J[0].dep) : J[m - 1].arr + cfg.min_transfer_minutes;
            const int32_t hi = m == 0 ? Qend : E;
            for (uint32_t j = 0; j < J[li].b; ++j) {
              if (st(J[li].train, j) != p) continue;
              const int32_t dj = J[li].start_day * 1440 + tt.stop(T, j).dep;
              if (dj < lo || dj > hi) continue;
              OJourney alt(J.begin(), J.begin() + m);
              alt.push_back({J[li].train, J[li].start_day, j, J[li].a, dj, J[li].arr});
              alt.insert(alt.end(), J.begin() + li + 1, J.end());
              if (valid.count(alt)) return true;
            }
          }
        }
      }
      return false;
    };

    std::vector<std::pair<Key, std::string>> ranked;
    for (const auto& J : all) {
      if (dominated(J)) continue;
      std::string sig;
      for (const auto& l : J)
        sig += tt.trains[l.train].number + ":" + tt.stations[st(l.train, l.b)].code + ">" + tt.stations[st(l.train, l.a)].code + "|";
      ranked.push_back({key_of(J), sig});
    }
    std::sort(ranked.begin(), ranked.end());
    std::vector<std::pair<Key, std::string>> out;
    std::set<std::string> seen;
    for (auto& r : ranked)
      if (seen.insert(r.second).second) out.push_back(r);
    return out;
  }
};

Timetable random_timetable(std::mt19937& rng, int nstations, int ntrains) {
  std::vector<STrain> trains;
  std::uniform_int_distribution<int> start(0, 1439), hop(20, 400), dwell(0, 20), len(2, 5), coin(0, 1), mask(1, 127);
  for (int i = 0; i < ntrains; ++i) {
    std::vector<int> perm(nstations);
    for (int k = 0; k < nstations; ++k) perm[k] = k;
    std::shuffle(perm.begin(), perm.end(), rng);
    const int n = std::min(nstations, len(rng));
    STrain tr{std::to_string(10000 + i), {}, coin(rng) ? DAILY : mask(rng)};
    int32_t time = start(rng);
    for (int k = 0; k < n; ++k) {
      SStop s{"S" + std::to_string(perm[k]), -1, -1};
      if (k > 0) {
        time += hop(rng);
        s.arr = time;
      }
      if (k + 1 < n) {
        if (k > 0) time += dwell(rng);
        s.dep = time;
      }
      tr.stops.push_back(s);
    }
    trains.push_back(tr);
  }
  // make sure every station code exists at least once for find_station
  return build(trains);
}

}  // namespace

TEST_CASE("engine equals brute force on random timetables") {
  // ORACLE_ITERS / ORACLE_SEED env vars allow longer soak runs.
  const char* it_env = std::getenv("ORACLE_ITERS");
  const char* seed_env = std::getenv("ORACLE_SEED");
  const int iters = it_env ? std::atoi(it_env) : 250;
  std::mt19937 rng(seed_env ? static_cast<unsigned>(std::atoi(seed_env)) : 12345u);
  int compared = 0, nonempty = 0;
  for (int iter = 0; iter < iters; ++iter) {
    const int nst = 5 + iter % 4;
    const Timetable tt = random_timetable(rng, nst, 8 + iter % 7);
    RouterConfig cfg;
    cfg.max_transfers = 3;
    cfg.horizon_minutes = 2880;
    cfg.top_k = 50;  // the production default
    cfg.max_labels = 50'000'000;
    cfg.prune_stay_on = iter % 5 != 1;
    cfg.prune_board_earlier = iter % 5 != 2;
    const Router router(tt, cfg);
    for (int qi = 0; qi < 6; ++qi) {
      const int32_t s = static_cast<int32_t>(rng() % tt.stations.size());
      const int32_t d = static_cast<int32_t>(rng() % tt.stations.size());
      if (s == d) continue;
      const Query q{s, d, *parse_date("2026-09-25") + static_cast<int32_t>(rng() % 7), static_cast<int32_t>(rng() % 1440), cfg.top_k};
      const RouteResult res = router.route(q);
      REQUIRE_FALSE(res.stats.truncated);
      Oracle oracle(tt, cfg, q);
      const auto expect = oracle.run();
      const size_t n = std::min<size_t>(expect.size(), static_cast<size_t>(cfg.top_k));
      INFO("iter " << iter << " query " << tt.stations[s].code << "->" << tt.stations[d].code);
      if (res.journeys.size() != n) {
        for (const auto& e : expect) MESSAGE("want " << std::get<0>(e.first) << " " << -std::get<1>(e.first) << " tr" << std::get<2>(e.first) << " w" << std::get<3>(e.first) << " " << e.second);
        for (const auto& j : res.journeys) MESSAGE("got  " << j.arrival << " " << j.departure << " tr" << j.transfers << " w" << j.waiting_minutes << " " << j.signature);
        for (const auto& tr : tt.trains) {
          std::string line = tr.number + " days=" + std::to_string(tr.days_mask) + ":";
          for (uint32_t k = 0; k < tr.num_stops; ++k) line += " " + tt.stations[tt.stop(tr, k).station].code + "(" + std::to_string(tt.stop(tr, k).arr) + "," + std::to_string(tt.stop(tr, k).dep) + ")";
          MESSAGE(line);
        }
        MESSAGE("S=" << q.date_day * 1440 + q.time_minute << " stay_on=" << cfg.prune_stay_on << " board_earlier=" << cfg.prune_board_earlier);
      }
      REQUIRE(res.journeys.size() == n);
      // identical key sequence
      for (size_t i = 0; i < n; ++i) {
        const Journey& j = res.journeys[i];
        const Key k{static_cast<int32_t>(j.arrival), -static_cast<int32_t>(j.departure), j.transfers, j.waiting_minutes};
        CHECK(k == expect[i].first);
      }
      // identical signatures within each fully included tie group; subset for the boundary group
      std::map<Key, std::set<std::string>> got, want;
      for (size_t i = 0; i < n; ++i) {
        const Journey& j = res.journeys[i];
        got[{static_cast<int32_t>(j.arrival), -static_cast<int32_t>(j.departure), j.transfers, j.waiting_minutes}].insert(j.signature);
      }
      for (const auto& e : expect) want[e.first].insert(e.second);
      for (const auto& [k, sigs] : got) {
        const bool boundary = n > 0 && k == expect[n - 1].first && n < expect.size() && expect[n].first == k;
        if (boundary) {
          for (const auto& sg : sigs) CHECK(want[k].count(sg) == 1);
        } else {
          CHECK(sigs == want[k]);
        }
      }
      ++compared;
      nonempty += n > 0;
    }
  }
  MESSAGE("compared " << compared << " queries, " << nonempty << " with journeys");
  CHECK(nonempty > iters * 4 / 5);
}
