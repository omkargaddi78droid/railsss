#pragma once

#include "json.hpp"
#include "router.h"

namespace rail {

// Compact result for the API: absolute minutes and timetable indices only; the API renders names,
// stops and datetimes from its own copy of the timetable (api/src/services/journeyRenderer.ts).
//   {"status","search_complete","worker","timetable","search_minute","stats":{...},
//    "journeys":[{"signature","dep","arr","transfers","train_minutes","waiting_minutes",
//                 "legs":[[train_idx,board_stop,alight_stop,start_day],...]}]}
std::string compact_json(const Timetable& tt, const Query& q, const RouteResult& r, const std::string& worker);

// Configuration as JSON (reported by /health and included in cache keys by the API).
nlohmann::json config_to_json(const RouterConfig& c);

}  // namespace rail
