#include "journey_json.h"

#include <cstdio>

namespace rail {

using nlohmann::json;

static void append_json_string(std::string& out, std::string_view v) {
  out += '"';
  for (char c : v) {
    const auto u = static_cast<unsigned char>(c);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (u < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", u);
      out += buf;
    } else {
      out += c;
    }
  }
  out += '"';
}

static void append_num(std::string& out, int64_t v) { out += std::to_string(v); }

static void append_ms(std::string& out, double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.3f", v);
  out += buf;
}

std::string compact_json(const Timetable& tt, const Query& q, const RouteResult& r, const std::string& worker) {
  const auto& st = r.stats;
  std::string out;
  out.reserve(256 + r.journeys.size() * 160);
  out += "{\"status\":";
  out += r.status == RouteStatus::Ok ? "\"ok\"" : "\"no_route\"";
  out += ",\"search_complete\":";
  out += st.truncated ? "false" : "true";
  out += ",\"worker\":";
  append_json_string(out, worker);
  out += ",\"timetable\":";
  append_json_string(out, tt.hash);
  out += ",\"search_minute\":";
  append_num(out, static_cast<int64_t>(q.date_day) * 1440 + q.time_minute);
  out += ",\"stats\":{\"total_ms\":";
  append_ms(out, st.total_ms);
  out += ",\"profile_ms\":";
  append_ms(out, st.profile_ms);
  out += ",\"search_ms\":";
  append_ms(out, st.search_ms);
  out += ",\"labels_popped\":";
  append_num(out, static_cast<int64_t>(st.labels_popped));
  out += ",\"truncated\":";
  out += st.truncated ? "true" : "false";
  out += "},\"journeys\":[";
  for (size_t ji = 0; ji < r.journeys.size(); ++ji) {
    const Journey& j = r.journeys[ji];
    if (ji) out += ',';
    out += "{\"signature\":";
    append_json_string(out, j.signature);
    out += ",\"dep\":";
    append_num(out, j.departure);
    out += ",\"arr\":";
    append_num(out, j.arrival);
    out += ",\"transfers\":";
    append_num(out, j.transfers);
    out += ",\"train_minutes\":";
    append_num(out, j.train_minutes);
    out += ",\"waiting_minutes\":";
    append_num(out, j.waiting_minutes);
    out += ",\"legs\":[";
    for (size_t li = 0; li < j.legs.size(); ++li) {
      const Leg& l = j.legs[li];
      if (li) out += ',';
      out += '[';
      append_num(out, l.train);
      out += ',';
      append_num(out, l.board_stop);
      out += ',';
      append_num(out, l.alight_stop);
      out += ',';
      append_num(out, l.start_day);
      out += ']';
    }
    out += "]}";
  }
  out += "]}";
  return out;
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

}  // namespace rail
