#include "timetable.h"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <stdexcept>

#include "json.hpp"

namespace rail {

int32_t Timetable::find_station(std::string_view code) const {
  auto it = station_by_code.find(std::string(code));
  return it == station_by_code.end() ? kNoStation : it->second;
}

bool Timetable::train_calls_at(uint32_t t, int32_t station, uint32_t lo, uint32_t hi) const {
  const auto b = station_index.begin() + trains[t].first_stop, e = station_index.begin() + station_index_end[t];
  for (auto it = std::lower_bound(b, e, std::make_pair(station, lo)); it != e && it->first == station; ++it)
    if (it->second <= hi) return true;
  return false;
}

void Timetable::finalize() {
  station_by_code.clear();
  for (size_t i = 0; i < stations.size(); ++i) station_by_code.emplace(stations[i].code, static_cast<int32_t>(i));

  departures.assign(stations.size(), {});
  max_span_days = 1;
  connection_count = 0;
  for (uint32_t t = 0; t < trains.size(); ++t) {
    const Train& tr = trains[t];
    if (tr.num_stops < 2) throw std::runtime_error("train " + tr.number + " has fewer than 2 stops");
    int32_t prev = -1;
    for (uint32_t i = 0; i < tr.num_stops; ++i) {
      const Stop& s = stop(tr, i);
      for (int32_t v : {s.arr, s.dep}) {
        if (v == kNoTime) continue;
        if (v < prev) throw std::runtime_error("train " + tr.number + " has non-monotone times");
        prev = v;
      }
      if (i + 1 < tr.num_stops) {
        if (s.dep == kNoTime) throw std::runtime_error("train " + tr.number + " intermediate stop without departure");
        ++connection_count;
        if (s.station != kNoStation) departures[s.station].push_back({s.dep % 1440, s.dep / 1440, t, i});
      } else if (s.arr == kNoTime) {
        throw std::runtime_error("train " + tr.number + " terminus without arrival");
      }
    }
    const int32_t last_arr = stop(tr, tr.num_stops - 1).arr;
    max_span_days = std::max(max_span_days, last_arr / 1440 + 1);
  }
  station_index.assign(stops.size(), {kNoStation, 0});
  station_index_end.assign(trains.size(), 0);
  for (uint32_t t = 0; t < trains.size(); ++t) {
    const Train& tr = trains[t];
    uint32_t w = tr.first_stop;
    for (uint32_t i = 0; i < tr.num_stops; ++i)
      if (stop(tr, i).station != kNoStation) station_index[w++] = {stop(tr, i).station, i};
    std::sort(station_index.begin() + tr.first_stop, station_index.begin() + w);
    station_index_end[t] = w;
  }
  for (auto& v : departures) {
    std::sort(v.begin(), v.end(), [](const DepartureEvent& a, const DepartureEvent& b) {
      if (a.tod != b.tod) return a.tod < b.tod;
      if (a.train != b.train) return a.train < b.train;
      return a.stop < b.stop;
    });
  }
}

Timetable parse_timetable_json(const std::string& text) {
  using nlohmann::json;
  const json doc = json::parse(text);
  if (doc.value("format", "") != "railway-timetable/v1") throw std::runtime_error("unsupported timetable format");

  Timetable tt;
  for (const auto& s : doc.at("stations")) tt.stations.push_back({s.at("code").get<std::string>(), s.at("name").get<std::string>()});
  const auto nst = static_cast<int32_t>(tt.stations.size());

  for (const auto& jt : doc.at("trains")) {
    Train tr;
    tr.number = jt.at("number").get<std::string>();
    tr.name = jt.value("name", tr.number);
    tr.type = jt.value("type", std::string("UNKNOWN"));
    tr.days_mask = static_cast<uint8_t>(jt.at("days").get<int>() & 0x7f);
    tr.first_stop = static_cast<uint32_t>(tt.stops.size());
    for (const auto& row : jt.at("stops")) {
      Stop s{};
      s.station = row.at(0).get<int32_t>();
      s.arr = row.at(1).get<int32_t>();
      s.dep = row.at(2).get<int32_t>();
      s.distance_km = row.at(3).get<float>();
      if (s.station < kNoStation || s.station >= nst) throw std::runtime_error("bad station index in train " + tr.number);
      if (s.station == kNoStation) tr.placeholder_names.push_back(row.size() > 4 ? row.at(4).get<std::string>() : "UNNAMED POINT");
      tt.stops.push_back(s);
    }
    tr.num_stops = static_cast<uint32_t>(tt.stops.size() - tr.first_stop);
    if (tr.days_mask == 0) continue;  // never runs; nothing to route
    tt.trains.push_back(std::move(tr));
  }
  tt.finalize();
  return tt;
}

Timetable load_timetable_json(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open timetable " + path);
  std::stringstream ss;
  ss << in.rdbuf();
  return parse_timetable_json(ss.str());
}

}  // namespace rail
