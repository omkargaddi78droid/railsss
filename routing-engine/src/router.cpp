#include "router.h"

#include <algorithm>
#include <chrono>
#include <limits>
#include <queue>
#include <unordered_set>

#include "civil_time.h"

namespace rail {
namespace {

using Clock = std::chrono::steady_clock;
using detail::WeekPattern;
constexpr int32_t INF = std::numeric_limits<int32_t>::max();

double ms_since(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

// Lexicographic bound (arrival, remaining transfers) packed into one integer so min() compares
// arrival first and transfers second.
using Lex = int64_t;
constexpr int kTrBits = 8;
constexpr Lex kTrMask = (1 << kTrBits) - 1;
constexpr Lex LEX_INF = std::numeric_limits<Lex>::max();
inline Lex lex(int32_t arr, int32_t tr) { return (static_cast<Lex>(arr) << kTrBits) | std::min<Lex>(tr, kTrMask); }
inline int32_t lex_arr(Lex v) { return v == LEX_INF ? INF : static_cast<int32_t>(v >> kTrBits); }
inline int32_t lex_tr(Lex v) { return static_cast<int32_t>(v & kTrMask); }
inline Lex plus_transfer(Lex v) { return v == LEX_INF || (v & kTrMask) == kTrMask ? v : v + 1; }

enum Kind : uint8_t { kRoot, kOnboard, kAtStation };

// A partial journey is a sequence of legs. Labels are:
//   Root:          at the source at the query time.
//   Onboard(k):    on train instance `inst` (boarded at `board_stop`), having just arrived at stop k.
//   AtStation:     alighted from `inst` at stop `stop` (leg board_stop..stop), free to transfer.
// `parent` of Onboard/AtStation labels is the Root/AtStation label where the current leg was boarded,
// so walking parents visits one label per leg (<= max_transfers + 2 steps).
struct Label {
  int32_t parent;
  uint32_t inst;
  uint16_t stop;
  uint8_t kind;
  uint8_t transfers;
  uint8_t just_boarded;
  int32_t station;
  int32_t time;       // arrival time at `station` / at stop `stop`
  int32_t first_dep;
  int32_t wait;       // transfer waiting so far (including the wait to board the current leg)
  int32_t ceiling;    // stay-on dominance: completions must arrive strictly before this
  uint16_t board_stop;  // onboard / at-station: where the current (last) leg was boarded
  uint64_t bloom;     // superset hash of stations touched by the chain (fast negative membership test)
};

// Priority: lower bounds of the ranking key (arrival, -first departure, transfers, waiting).
struct QueueKey {
  int32_t arr_lb;
  int32_t neg_first_dep;
  int32_t tr_lb;
  int32_t wait;
  uint32_t label;
  bool operator>(const QueueKey& o) const {
    if (arr_lb != o.arr_lb) return arr_lb > o.arr_lb;
    if (neg_first_dep != o.neg_first_dep) return neg_first_dep > o.neg_first_dep;
    if (tr_lb != o.tr_lb) return tr_lb > o.tr_lb;
    if (wait != o.wait) return wait > o.wait;
    return label > o.label;
  }
};

inline uint64_t bloom_bit(int32_t station) {
  uint64_t x = static_cast<uint64_t>(station) * 0x9E3779B97F4A7C15ull;
  return 1ull << (x >> 58);
}

// Per-thread scratch memory, reused across queries to avoid reallocations.
struct Workspace {
  std::vector<Lex> val;                      // onboard bound per instance-stop
  std::vector<uint16_t> board_count, alight_count;
  std::vector<Lex> trip_best;
  std::vector<std::vector<std::pair<int32_t, Lex>>> profile;  // station -> (dep, bound), dep nonincreasing
  std::vector<Label> labels;
  std::vector<uint32_t> station_mark, train_mark;
  uint32_t epoch = 0;
};

Workspace& workspace() {
  thread_local Workspace ws;
  return ws;
}

// Best bound for a passenger free at a station from time `t`: last entry with dep >= t.
inline Lex profile_eval(const std::vector<std::pair<int32_t, Lex>>& p, int32_t t) {
  size_t lo = 0, hi = p.size();
  while (lo < hi) {
    const size_t mid = (lo + hi) / 2;
    if (p[mid].first >= t) lo = mid + 1;
    else hi = mid;
  }
  return lo == 0 ? LEX_INF : p[lo - 1].second;
}

WeekPattern build_pattern(const Timetable& tt, int query_weekday, int32_t horizon) {
  WeekPattern p;
  p.day_lo = -tt.max_span_days;
  const int32_t day_hi = (1439 + horizon) / 1440;
  p.ndays = day_hi - p.day_lo + 1;
  p.inst_of.assign(tt.trains.size() * static_cast<size_t>(p.ndays), -1);
  for (uint32_t t = 0; t < tt.trains.size(); ++t) {
    const Train& tr = tt.trains[t];
    const int32_t last_arr = tt.stop(tr, tr.num_stops - 1).arr;
    for (int32_t off = p.day_lo; off <= day_hi; ++off) {
      const int wd = ((query_weekday + off) % 7 + 7) % 7;
      if (!((tr.days_mask >> wd) & 1)) continue;
      if (off * 1440 + last_arr < 0) continue;  // finished before the query date began
      p.inst_of[t * static_cast<size_t>(p.ndays) + (off - p.day_lo)] = static_cast<int32_t>(p.instances.size());
      p.instances.push_back({t, off * 1440, p.instance_stops});
      p.instance_stops += tr.num_stops;
    }
  }
  for (uint32_t i = 0; i < p.instances.size(); ++i) {
    const auto& in = p.instances[i];
    const Train& tr = tt.trains[in.train];
    for (uint32_t k = 0; k + 1 < tr.num_stops; ++k) {
      const int32_t dep = in.rel_base + tt.stop(tr, k).dep;
      if (dep < 0) continue;
      p.connections.push_back({dep, in.rel_base + tt.stop(tr, k + 1).arr, i, k});
    }
  }
  // Descending departure. Ties: later stops of the same trip first, so "stay seated" values are ready.
  std::sort(p.connections.begin(), p.connections.end(), [](const WeekPattern::Connection& a, const WeekPattern::Connection& b) {
    if (a.dep_rel != b.dep_rel) return a.dep_rel > b.dep_rel;
    if (a.inst != b.inst) return a.inst < b.inst;
    return a.stop > b.stop;
  });
  return p;
}

// Board-earlier dominance, evaluated on a complete journey J (so the check is exact):
// J is dominated if some leg n >= 1 rides train instance T that the passenger could already have
// boarded at an earlier point P where they stood (the source, or the station where leg m < n ended),
// giving J' = legs[0..m) + T from P + J's remainder. J' has the same arrival, the same or a later
// first departure and strictly fewer transfers, so it ranks strictly ahead of J. J' must itself be
// valid: departure inside P's boarding window and no station touched twice.
bool boards_train_late(const Timetable& tt, const Journey& J, int32_t src, int32_t S, int32_t first_leg_last_dep, int32_t TR) {
  const size_t n = J.legs.size();
  if (n < 2) return false;
  auto leg_stations = [&](const Leg& l, uint32_t from, uint32_t to, std::vector<int32_t>& out) {
    const Train& tr = tt.trains[l.train];
    for (uint32_t k = from; k <= to; ++k)
      if (tt.stop(tr, k).station != kNoStation) out.push_back(tt.stop(tr, k).station);
  };
  for (size_t li = 1; li < n; ++li) {
    const Leg& leg = J.legs[li];
    const Train& tr = tt.trains[leg.train];
    const int32_t base = leg.start_day * 1440;
    // stations touched from this boarding onward (J's remainder)
    std::vector<int32_t> rest;
    // (a transfer station is listed once: legs after the first one start at board_stop + 1)
    for (size_t r = li; r < n; ++r) leg_stations(J.legs[r], J.legs[r].board_stop + (r > li ? 1 : 0), J.legs[r].alight_stop, rest);
    std::vector<int32_t> prefix{src};
    for (size_t m = 0; m < li; ++m) {
      // presence point P_m: source (m == 0) or where leg m-1 ended
      const int32_t p_station = m == 0 ? src : tt.stop(tt.trains[J.legs[m - 1].train], J.legs[m - 1].alight_stop).station;
      const int32_t lo = m == 0 ? std::max<int32_t>(S, static_cast<int32_t>(J.departure)) : static_cast<int32_t>(J.legs[m - 1].arr) + TR;
      const int32_t hi = m == 0 ? first_leg_last_dep : std::numeric_limits<int32_t>::max();
      if (m > 0) leg_stations(J.legs[m - 1], J.legs[m - 1].board_stop + 1, J.legs[m - 1].alight_stop, prefix);
      for (uint32_t jst = 0; jst < leg.board_stop; ++jst) {
        const Stop& sj = tt.stop(tr, jst);
        if (sj.station != p_station) continue;
        const int32_t dj = base + sj.dep;
        if (dj < lo || dj > hi) continue;
        // J' touches prefix(P) + T[jst .. board_stop) + rest: all must be distinct
        std::vector<int32_t> all = prefix;
        all.pop_back();  // p_station itself is re-added as T's first stop below
        leg_stations(leg, jst, leg.board_stop - 1, all);
        all.insert(all.end(), rest.begin(), rest.end());
        std::sort(all.begin(), all.end());
        if (std::adjacent_find(all.begin(), all.end()) == all.end()) return true;
      }
    }
  }
  return false;
}

// Generalized stay-on dominance, evaluated on a complete journey J (exact):
// J is dominated if it leaves train T1 (leg n) although T1 itself reaches the alighting station Z of a
// later leg m no later than J does. J' = legs[0..n] with leg n extended to Z + legs(m, end) has the
// same first departure, the same or earlier arrival and fewer transfers. J' must touch no station twice.
bool leaves_train_early(const Timetable& tt, const Journey& J) {
  const size_t n = J.legs.size();
  for (size_t li = 0; li + 1 < n; ++li) {
    const Leg& leg = J.legs[li];
    const Train& t1 = tt.trains[leg.train];
    const int32_t base = leg.start_day * 1440;
    for (size_t m = li + 1; m < n; ++m) {
      const Leg& lm = J.legs[m];
      const int32_t z_station = tt.stop(tt.trains[lm.train], lm.alight_stop).station;
      for (uint32_t z = leg.alight_stop + 1; z < t1.num_stops; ++z) {
        if (tt.stop(t1, z).station != z_station) continue;
        if (base + tt.stop(t1, z).arr > lm.arr) break;
        std::vector<int32_t> all;
        for (size_t r = 0; r <= li; ++r) {
          const Train& tr = tt.trains[J.legs[r].train];
          for (uint32_t k = J.legs[r].board_stop + (r > 0 ? 1 : 0); k <= (r == li ? z : J.legs[r].alight_stop); ++k)
            if (tt.stop(tr, k).station != kNoStation) all.push_back(tt.stop(tr, k).station);
        }
        for (size_t r = m + 1; r < n; ++r) {
          const Train& tr = tt.trains[J.legs[r].train];
          for (uint32_t k = J.legs[r].board_stop + 1; k <= J.legs[r].alight_stop; ++k)
            if (tt.stop(tr, k).station != kNoStation) all.push_back(tt.stop(tr, k).station);
        }
        std::sort(all.begin(), all.end());
        if (std::adjacent_find(all.begin(), all.end()) == all.end()) return true;
        break;
      }
    }
  }
  return false;
}

}  // namespace

Router::Router(const Timetable& tt, RouterConfig cfg) : tt_(tt), cfg_(cfg) {
  cfg_.min_transfer_minutes = std::max(1, cfg_.min_transfer_minutes);  // >0 keeps the profile scan exact
  cfg_.max_transfers = std::clamp(cfg_.max_transfers, 0, 250);
  cfg_.top_k = std::max(1, cfg_.top_k);
  cfg_.k_node = std::clamp(cfg_.k_node, 0, 65535);
  cfg_.horizon_minutes = std::clamp(cfg_.horizon_minutes, 60, 30 * 1440);
  patterns_.reserve(7);
  for (int w = 0; w < 7; ++w) patterns_.push_back(build_pattern(tt_, w, cfg_.horizon_minutes));
}

RouteResult Router::route(const Query& q) const {
  const auto t_start = Clock::now();
  RouteResult res;
  const int32_t nst = static_cast<int32_t>(tt_.stations.size());
  auto invalid = [&](const char* msg) {
    res.status = RouteStatus::InvalidQuery;
    res.error = msg;
    return res;
  };
  if (q.source < 0 || q.source >= nst || q.destination < 0 || q.destination >= nst) return invalid("unknown station");
  if (q.source == q.destination) return invalid("source and destination must differ");
  if (q.time_minute < 0 || q.time_minute >= 1440) return invalid("time out of range");
  if (q.date_day < 0 || q.date_day > 200000) return invalid("date out of range");

  const int32_t K = q.limit > 0 ? std::min(q.limit, cfg_.top_k) : cfg_.top_k;
  const int32_t TR = cfg_.min_transfer_minutes;
  const int32_t qbase = q.date_day * 1440;
  const int32_t S = qbase + q.time_minute;               // passenger available at source
  const int32_t first_leg_last_dep = qbase + 1439;       // first train must leave on the query date
  const int32_t E = S + cfg_.horizon_minutes;            // arrival horizon
  const int32_t src = q.source, dst = q.destination;
  const WeekPattern& P = patterns_[weekday(q.date_day)];

  Workspace& ws = workspace();
  ws.val.assign(P.instance_stops, LEX_INF);
  ws.board_count.assign(P.instance_stops, 0);
  ws.alight_count.assign(P.instance_stops, 0);
  ws.trip_best.assign(P.instances.size(), LEX_INF);
  if (ws.profile.size() != static_cast<size_t>(nst)) ws.profile.assign(nst, {});
  for (auto& p : ws.profile) p.clear();
  res.stats.instances = P.instances.size();
  res.stats.setup_ms = ms_since(t_start);

  // ---- 1. backward profile scan ---------------------------------------------------------------
  // val[inst, k] = lexicographically best (arrival, remaining transfers) at the destination for a
  // passenger on board `inst` arriving at stop k, ignoring the loop rule, transfer cap and dominance
  // rules (a relaxation, hence an admissible and consistent bound).
  const auto t_profile = Clock::now();
  const int32_t t_rel = q.time_minute, e_rel = q.time_minute + cfg_.horizon_minutes;
  for (const auto& c : P.connections) {
    if (c.dep_rel < t_rel) break;
    if (c.arr_rel > e_rel) continue;
    ++res.stats.connections;
    const auto& in = P.instances[c.inst];
    const Train& tr = tt_.trains[in.train];
    const int32_t arr = qbase + c.arr_rel;
    const int32_t to = tt_.stop(tr, c.stop + 1).station;
    Lex best = ws.trip_best[c.inst];                                                     // stay seated
    if (to == dst) best = std::min(best, lex(arr, 0));                                    // alight at destination
    else if (to != kNoStation) best = std::min(best, plus_transfer(profile_eval(ws.profile[to], arr + TR)));  // change
    ws.val[in.offset + c.stop + 1] = best;
    ws.trip_best[c.inst] = best;
    const int32_t from = tt_.stop(tr, c.stop).station;
    if (best != LEX_INF && from != kNoStation) {
      auto& p = ws.profile[from];
      if (p.empty() || best < p.back().second) p.emplace_back(qbase + c.dep_rel, best);
    }
  }
  res.stats.profile_ms = ms_since(t_profile);

  // ---- 2. best-first K-best enumeration ---------------------------------------------------------
  const auto t_search = Clock::now();
  ws.labels.clear();
  std::priority_queue<QueueKey, std::vector<QueueKey>, std::greater<QueueKey>> pq;
  if (ws.station_mark.size() != static_cast<size_t>(nst)) {
    ws.station_mark.assign(nst, 0);
  }
  if (ws.train_mark.size() != tt_.trains.size()) ws.train_mark.assign(tt_.trains.size(), 0);

  const bool stay_on = cfg_.prune_stay_on, board_earlier = cfg_.prune_board_earlier;
  const uint16_t cap = static_cast<uint16_t>(cfg_.k_node);
  auto base_of = [&](const WeekPattern::Instance& in) { return qbase + in.rel_base; };

  auto push = [&](const Label& l, int32_t arr_lb, int32_t tr_lb) {
    ws.labels.push_back(l);
    const uint32_t idx = static_cast<uint32_t>(ws.labels.size() - 1);
    pq.push({arr_lb, l.first_dep == INF ? -INF : -l.first_dep, tr_lb, l.wait, idx});
    ++res.stats.labels_created;
  };

  // True if `station` is touched by the partial journey of label `l` (an Onboard or AtStation label).
  auto chain_has_station = [&](const Label& l, int32_t station) {
    if (!(l.bloom & bloom_bit(station))) return false;
    if (tt_.train_calls_at(P.instances[l.inst].train, station, l.board_stop, l.stop)) return true;
    for (int32_t x = l.parent; x >= 0; x = ws.labels[x].parent) {
      const Label& c = ws.labels[x];
      if (c.kind == kRoot) return c.station == station;
      if (tt_.train_calls_at(P.instances[c.inst].train, station, c.board_stop, c.stop)) return true;
    }
    return false;
  };

  // Enumerate departure events at `station` with absolute departure in [lo, hi].
  auto for_each_departure = [&](int32_t station, int32_t lo, int32_t hi, auto&& fn) {
    const auto& evs = tt_.departures[station];
    if (evs.empty() || lo > hi) return;
    for (int32_t D = floor_div(lo, 1440); D <= floor_div(hi, 1440); ++D) {
      const int32_t tod_lo = std::max(0, lo - D * 1440);
      const int32_t tod_hi = std::min(1439, hi - D * 1440);
      auto it = std::lower_bound(evs.begin(), evs.end(), tod_lo, [](const DepartureEvent& e, int32_t v) { return e.tod < v; });
      for (; it != evs.end() && it->tod <= tod_hi; ++it) {
        const int32_t off = D - q.date_day - it->day_offset;  // instance start day relative to the query date
        if (off < P.day_lo || off >= P.day_lo + P.ndays) continue;
        const int32_t inst = P.inst_of[it->train * static_cast<size_t>(P.ndays) + (off - P.day_lo)];
        if (inst < 0) continue;
        fn(static_cast<uint32_t>(inst), it->stop, D * 1440 + it->tod);
      }
    }
  };

  push(Label{-1, 0, 0, kRoot, 0, 0, src, S, INF, 0, INF, 0, bloom_bit(src)}, 0, 0);
  std::unordered_set<std::string> seen_signatures;

  while (!pq.empty()) {
    if (ws.labels.size() >= cfg_.max_labels) {
      res.stats.truncated = true;
      break;
    }
    const QueueKey top = pq.top();
    pq.pop();
    ++res.stats.labels_popped;
    const Label L = ws.labels[top.label];  // copy: push() may reallocate

    if (L.kind == kOnboard && L.just_boarded && cap) {
      uint16_t& c = ws.board_count[P.instances[L.inst].offset + L.stop - 1];
      if (c >= cap) { ++res.stats.pruned_by_cap; continue; }
      ++c;
    }

    if (L.kind == kAtStation && L.station == dst) {
      // ---- completed journey (popped in exact rank order): reconstruct legs --------------------
      Journey j;
      for (int32_t x = static_cast<int32_t>(top.label); x >= 0 && ws.labels[x].kind == kAtStation; x = ws.labels[x].parent) {
        const Label& c = ws.labels[x];
        const auto& in = P.instances[c.inst];
        const Train& tr = tt_.trains[in.train];
        j.legs.push_back({in.train, q.date_day + in.rel_base / 1440, c.board_stop, c.stop, base_of(in) + tt_.stop(tr, c.board_stop).dep, c.time});
      }
      std::reverse(j.legs.begin(), j.legs.end());
      j.departure = j.legs.front().dep;
      j.arrival = j.legs.back().arr;
      j.transfers = static_cast<int32_t>(j.legs.size()) - 1;
      j.waiting_minutes = L.wait;
      j.train_minutes = 0;
      for (const Leg& leg : j.legs) {
        j.train_minutes += static_cast<int32_t>(leg.arr - leg.dep);
        const Train& tr = tt_.trains[leg.train];
        j.signature += tr.number + ":" + tt_.stations[tt_.stop(tr, leg.board_stop).station].code + ">" +
                       tt_.stations[tt_.stop(tr, leg.alight_stop).station].code + "|";
      }
      if ((board_earlier && boards_train_late(tt_, j, src, S, first_leg_last_dep, TR)) || (stay_on && leaves_train_early(tt_, j))) {
        ++res.stats.pruned_by_dominance;
        continue;
      }
      if (!seen_signatures.insert(j.signature).second) { ++res.stats.duplicate_signatures; continue; }
      res.journeys.push_back(std::move(j));
      if (static_cast<int32_t>(res.journeys.size()) >= K) break;
      continue;
    }

    if (L.kind == kOnboard) {
      const auto& in = P.instances[L.inst];
      const Train& tr = tt_.trains[in.train];
      const int32_t base = base_of(in);
      const int32_t st = tt_.stop(tr, L.stop).station;
      // (a) alight here
      if (st != kNoStation && (st == dst || L.transfers < cfg_.max_transfers)) {
        int32_t arr_lb, tr_lb;
        if (st == dst) {
          arr_lb = L.time;
          tr_lb = L.transfers;
        } else {
          const Lex v = profile_eval(ws.profile[st], L.time + TR);
          arr_lb = lex_arr(v);
          tr_lb = L.transfers + 1 + lex_tr(v);
        }
        int32_t ceiling = L.ceiling;
        if (stay_on && st != dst) {
          // stay-on: if this train continues to the destination without touching the chain, a journey
          // that alights here must beat that arrival to be worth keeping.
          for (uint32_t m = L.stop + 1u; m < tr.num_stops; ++m) {
            const int32_t sm = tt_.stop(tr, m).station;
            if (sm == dst) {
              ceiling = std::min(ceiling, base + tt_.stop(tr, m).arr);
              break;
            }
            if (sm != kNoStation && chain_has_station(L, sm)) break;
          }
        }
        if (arr_lb >= ceiling) ++res.stats.pruned_by_dominance;
        else if (arr_lb <= E)
          push(Label{L.parent, L.inst, L.stop, kAtStation, L.transfers, 0, st, L.time, L.first_dep, L.wait, ceiling,
                     L.board_stop, L.bloom},
               arr_lb, tr_lb);
      }
      // (b) stay on board to the next stop
      if (st != dst && L.stop + 1u < tr.num_stops) {
        const uint32_t k = L.stop + 1u;
        const Lex v = ws.val[in.offset + k];
        const int32_t arr_lb = lex_arr(v);
        const int32_t nxt = tt_.stop(tr, k).station;
        if (arr_lb <= E && arr_lb < L.ceiling && (nxt == kNoStation || !chain_has_station(L, nxt))) {
          push(Label{L.parent, L.inst, static_cast<uint16_t>(k), kOnboard, L.transfers, 0, nxt, base + tt_.stop(tr, k).arr,
                     L.first_dep, L.wait, L.ceiling, L.board_stop, nxt == kNoStation ? L.bloom : (L.bloom | bloom_bit(nxt))},
               arr_lb, L.transfers + lex_tr(v));
        }
      }
      continue;
    }

    // Root or AtStation (not destination): board a departing train.
    if (L.kind == kAtStation && cap) {
      uint16_t& c = ws.alight_count[P.instances[L.inst].offset + L.stop];
      if (c >= cap) { ++res.stats.pruned_by_cap; continue; }
      ++c;
    }
    const bool is_root = L.kind == kRoot;
    const int32_t lo = is_root ? S : L.time + TR;
    const int32_t hi = is_root ? std::min(first_leg_last_dep, E) : E;
    const uint8_t next_transfers = is_root ? 0 : static_cast<uint8_t>(L.transfers + 1);

    // Mark the chain's stations / instances for O(1) membership tests.
    if (++ws.epoch == 0) {
      std::fill(ws.station_mark.begin(), ws.station_mark.end(), 0);
      std::fill(ws.train_mark.begin(), ws.train_mark.end(), 0);
      ws.epoch = 1;
    }
    for (int32_t x = static_cast<int32_t>(top.label); x >= 0; x = ws.labels[x].parent) {
      const Label& c = ws.labels[x];
      if (c.kind == kRoot) {
        ws.station_mark[c.station] = ws.epoch;
        break;
      }
      const uint32_t t = P.instances[c.inst].train;
      ws.train_mark[t] = ws.epoch;
      const Train& tr = tt_.trains[t];
      for (uint32_t k = c.board_stop; k <= c.stop; ++k)
        if (tt_.stop(tr, k).station != kNoStation) ws.station_mark[tt_.stop(tr, k).station] = ws.epoch;
    }

    for_each_departure(L.station, lo, hi, [&](uint32_t inst, uint32_t stop, int32_t dep) {
      const auto& in = P.instances[inst];
      if (ws.train_mark[in.train] == ws.epoch) return;  // each train (number) at most once per journey
      const Train& tr = tt_.trains[in.train];
      const uint32_t k = stop + 1;
      const Lex v = ws.val[in.offset + k];
      const int32_t arr_lb = lex_arr(v);
      if (arr_lb > E || arr_lb >= L.ceiling) return;  // cannot reach the destination usefully this way
      const int32_t nxt = tt_.stop(tr, k).station;
      if (nxt != kNoStation && ws.station_mark[nxt] == ws.epoch) return;
      const int32_t first_dep = is_root ? dep : L.first_dep;
      const int32_t wait = is_root ? 0 : L.wait + (dep - L.time);
      push(Label{static_cast<int32_t>(top.label), inst, static_cast<uint16_t>(k), kOnboard, next_transfers, 1, nxt, base_of(in) + tt_.stop(tr, k).arr,
                 first_dep, wait, L.ceiling, static_cast<uint16_t>(stop), nxt == kNoStation ? L.bloom : (L.bloom | bloom_bit(nxt))},
           arr_lb, next_transfers + lex_tr(v));
    });
  }

  res.stats.search_ms = ms_since(t_search);
  res.stats.total_ms = ms_since(t_start);
  res.stats.lower_bound = res.journeys.empty() ? -1 : static_cast<int32_t>(res.journeys.front().arrival - S);
  res.status = res.journeys.empty() ? RouteStatus::NoRoute : RouteStatus::Ok;
  return res;
}

}  // namespace rail
