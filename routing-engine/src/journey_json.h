#pragma once

#include "json.hpp"
#include "router.h"

namespace rail {

// Full JSON representation of a route result, including every intermediate stop of each leg.
nlohmann::json result_to_json(const Timetable& tt, const Query& q, const RouteResult& r);

// Configuration as JSON (reported by /health and included in cache keys by the API).
nlohmann::json config_to_json(const RouterConfig& c);

}  // namespace rail
