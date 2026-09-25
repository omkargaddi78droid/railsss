#include "journey_json.h"

#include "civil_time.h"

namespace rail {

using nlohmann::json;

static json station_json(const Timetable& tt, const Train& tr, uint32_t stop_idx) {
  const Stop& s = tt.stop(tr, stop_idx);
  if (s.station != kNoStation) return {{"code", tt.stations[s.station].code}, {"name", tt.stations[s.station].name}};
  // placeholder point: find its name by counting placeholders before it
  size_t n = 0;
  for (uint32_t i = 0; i < stop_idx; ++i)
    if (tt.stop(tr, i).station == kNoStation) ++n;
  return {{"code", nullptr}, {"name", n < tr.placeholder_names.size() ? tr.placeholder_names[n] : "UNNAMED POINT"}};
}

json config_to_json(const RouterConfig& c) {
  return {{"min_transfer_minutes", c.min_transfer_minutes},
          {"max_transfers", c.max_transfers},
          {"top_k", c.top_k},
          {"k_node", c.k_node},
          {"horizon_minutes", c.horizon_minutes},
          {"max_labels", c.max_labels},
          {"prune_stay_on", c.prune_stay_on},
          {"prune_board_earlier", c.prune_board_earlier}};
}

json result_to_json(const Timetable& tt, const Query& q, const RouteResult& r) {
  const int64_t S = static_cast<int64_t>(q.date_day) * 1440 + q.time_minute;
  json routes = json::array();
  int rank = 0;
  for (const Journey& j : r.journeys) {
    json segments = json::array();
    json transfers = json::array();
    for (size_t li = 0; li < j.legs.size(); ++li) {
      const Leg& leg = j.legs[li];
      const Train& tr = tt.trains[leg.train];
      const int64_t base = static_cast<int64_t>(leg.start_day) * 1440;
      json stops = json::array();
      for (uint32_t k = leg.board_stop; k <= leg.alight_stop; ++k) {
        const Stop& s = tt.stop(tr, k);
        json st = station_json(tt, tr, k);
        st["arrival_datetime"] = (k == leg.board_stop || s.arr == kNoTime) ? json(nullptr) : json(format_datetime(base + s.arr));
        st["departure_datetime"] = (k == leg.alight_stop || s.dep == kNoTime) ? json(nullptr) : json(format_datetime(base + s.dep));
        st["distance_km"] = s.distance_km - tt.stop(tr, leg.board_stop).distance_km;
        st["boardable"] = s.station != kNoStation;
        stops.push_back(std::move(st));
      }
      const float dist = tt.stop(tr, leg.alight_stop).distance_km - tt.stop(tr, leg.board_stop).distance_km;
      segments.push_back({{"train_number", tr.number},
                          {"train_name", tr.name},
                          {"train_type", tr.type},
                          {"train_start_date", format_date(leg.start_day)},
                          {"from_station", station_json(tt, tr, leg.board_stop)},
                          {"to_station", station_json(tt, tr, leg.alight_stop)},
                          {"departure_datetime", format_datetime(leg.dep)},
                          {"arrival_datetime", format_datetime(leg.arr)},
                          {"duration_minutes", leg.arr - leg.dep},
                          {"distance_km", dist},
                          {"stop_count", leg.alight_stop - leg.board_stop},
                          {"stops", std::move(stops)}});
      if (li + 1 < j.legs.size()) {
        const Leg& nxt = j.legs[li + 1];
        transfers.push_back({{"station", station_json(tt, tr, leg.alight_stop)},
                             {"arrival_datetime", format_datetime(leg.arr)},
                             {"departure_datetime", format_datetime(nxt.dep)},
                             {"wait_minutes", nxt.dep - leg.arr}});
      }
    }
    double total_km = 0;
    for (const auto& s : segments) total_km += s["distance_km"].get<double>();
    routes.push_back({{"rank", ++rank},
                      {"signature", j.signature},
                      {"departure_datetime", format_datetime(j.departure)},
                      {"arrival_datetime", format_datetime(j.arrival)},
                      {"duration_minutes", j.arrival - j.departure},
                      {"elapsed_from_search_minutes", j.arrival - S},
                      {"initial_wait_minutes", j.departure - S},
                      {"train_travel_minutes", j.train_minutes},
                      {"waiting_minutes", j.waiting_minutes},
                      {"transfer_count", j.transfers},
                      {"segment_count", j.legs.size()},
                      {"is_direct", j.transfers == 0},
                      {"distance_km", total_km},
                      {"segments", std::move(segments)},
                      {"transfers", std::move(transfers)}});
  }
  const auto& st = r.stats;
  return {{"status", r.status == RouteStatus::Ok ? "ok" : r.status == RouteStatus::NoRoute ? "no_route" : "invalid"},
          {"query",
           {{"source", tt.stations[q.source].code},
            {"destination", tt.stations[q.destination].code},
            {"search_datetime", format_datetime(S)}}},
          {"routes", std::move(routes)},
          {"stats",
           {{"setup_ms", st.setup_ms},
            {"profile_ms", st.profile_ms},
            {"search_ms", st.search_ms},
            {"total_ms", st.total_ms},
            {"instances", st.instances},
            {"connections", st.connections},
            {"labels_created", st.labels_created},
            {"labels_popped", st.labels_popped},
            {"pruned_by_cap", st.pruned_by_cap},
            {"pruned_by_dominance", st.pruned_by_dominance},
            {"duplicate_signatures", st.duplicate_signatures},
            {"truncated", st.truncated}}},
          {"search_complete", !st.truncated}};
}

}  // namespace rail
