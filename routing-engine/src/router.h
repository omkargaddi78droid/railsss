// K-best earliest-arrival journey search.
//
// Model: a journey is a sequence of legs (train instance, boarding stop, alighting stop). Consecutive
// legs meet at the same station code and satisfy next.dep >= prev.arr + min_transfer. The first leg
// departs the source in [query time, 23:59 of the query date]. Journeys never touch a station twice
// and never reuse a train instance. Journeys are ranked lexicographically by
//   (arrival, -first departure, transfers, total transfer waiting, signature).
//
// Algorithm (see README "Routing algorithm"):
//   1. Backward Connection-Scan profile from the destination over the query horizon gives, for every
//      (train instance, stop), the exact earliest arrival at the destination when on board there, and
//      for every station a step function "at station s from time t -> earliest arrival".
//      These relax the loop / transfer-cap constraints, so they are admissible lower bounds.
//   2. Best-first (A*) enumeration of partial journeys keyed by (lower bound, tie-breakers). Keys are
//      monotone along extensions, so completed journeys are popped in exact rank order; the first K
//      completions are the answer.
//   3. Optional per-event label cap (k_node) bounds work on ties; see README for its exactness caveat.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "timetable.h"

namespace rail {

struct RouterConfig {
  int32_t min_transfer_minutes = 30;
  int32_t max_transfers = 10;           // internal cap; legs <= max_transfers + 1
  int32_t top_k = 20;
  // Optional heuristic cap on labels boarding / alighting one train event (0 = off, the exact default).
  // With it on, results are no longer guaranteed to be the exact top-K.
  int32_t k_node = 0;
  int32_t horizon_minutes = 5760;       // journeys must arrive within query time + horizon
  // Deterministic work budget. Completed journeys are emitted in exact rank order, so hitting the
  // budget never yields a wrong or misordered journey; it can only return fewer than top_k
  // (reported as truncated / search_complete = false).
  uint32_t max_labels = 200'000;
  // Shortcut dominance (see README): drop a journey when an obviously better journey with the same
  // or earlier arrival and strictly fewer transfers exists:
  //   stay-on:       it leaves a train that itself reaches the destination no later than the journey;
  //   board-earlier: it boards a train that it could already have boarded at an earlier point where
  //                  the passenger stood (source or a previous transfer station).
  bool prune_stay_on = true;
  bool prune_board_earlier = true;
};

struct Query {
  int32_t source = kNoStation;
  int32_t destination = kNoStation;
  int32_t date_day = 0;                 // days since 1970-01-01 (local)
  int32_t time_minute = 0;              // minute of day, 0..1439
  int32_t limit = 0;                    // 0 => config.top_k; clamped to config.top_k
};

struct Leg {
  uint32_t train;
  int32_t start_day;                    // date on which this train instance started (day_of_journey 1)
  uint32_t board_stop;
  uint32_t alight_stop;
  int64_t dep;                          // absolute minutes
  int64_t arr;
};

struct Journey {
  std::vector<Leg> legs;
  int64_t departure;
  int64_t arrival;
  int32_t transfers;
  int32_t waiting_minutes;              // sum of waits at transfer stations
  int32_t train_minutes;                // sum of on-board time
  std::string signature;
};

struct SearchStats {
  double setup_ms = 0, profile_ms = 0, search_ms = 0, total_ms = 0;
  uint64_t instances = 0, connections = 0, labels_created = 0, labels_popped = 0;
  uint64_t pruned_by_cap = 0, pruned_by_dominance = 0, duplicate_signatures = 0;
  int32_t lower_bound = -1;             // earliest possible arrival (minutes after query time), -1 if none
  bool truncated = false;
};

enum class RouteStatus { Ok, NoRoute, InvalidQuery };

struct RouteResult {
  RouteStatus status = RouteStatus::NoRoute;
  std::string error;
  std::vector<Journey> journeys;
  SearchStats stats;
};

namespace detail {
// Train instances and connections for all queries whose date falls on one weekday. Times are relative
// to 00:00 of the query date, so the same precomputed, pre-sorted structure serves every such date.
struct WeekPattern {
  struct Instance {
    uint32_t train;
    int32_t rel_base;  // (start day - query day) * 1440
    uint32_t offset;   // into per-instance-stop arrays
  };
  struct Connection {
    int32_t dep_rel, arr_rel;
    uint32_t inst;
    uint32_t stop;     // departs `stop`, arrives `stop + 1`
  };
  int32_t day_lo = 0, ndays = 0;          // instance start offsets [day_lo, day_lo + ndays)
  std::vector<Instance> instances;
  std::vector<int32_t> inst_of;           // train * ndays + (offset - day_lo) -> instance or -1
  std::vector<Connection> connections;    // sorted by dep_rel descending
  uint32_t instance_stops = 0;
};
}  // namespace detail

class Router {
 public:
  Router(const Timetable& tt, RouterConfig cfg);
  RouteResult route(const Query& q) const;
  const RouterConfig& config() const { return cfg_; }
  const Timetable& timetable() const { return tt_; }

 private:
  const Timetable& tt_;
  RouterConfig cfg_;
  std::vector<detail::WeekPattern> patterns_;  // indexed by weekday of the query date
};

}  // namespace rail
