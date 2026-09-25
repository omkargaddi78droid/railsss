// Immutable, query-independent timetable loaded once at startup.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace rail {

constexpr int32_t kNoTime = -1;
constexpr int32_t kNoStation = -1;

struct Station {
  std::string code;
  std::string name;
};

// One scheduled stop of a train. Times are minutes relative to 00:00 of the train's start date
// (day_of_journey 1), so a day-3 departure at 01:15 is 2*1440 + 75.
struct Stop {
  int32_t station;      // index into Timetable::stations, or kNoStation for a non-boardable point
  int32_t arr;          // kNoTime at the origin
  int32_t dep;          // kNoTime at the terminus
  float distance_km;
};

struct Train {
  std::string number;
  std::string name;
  std::string type;
  uint8_t days_mask;    // bit w set => a service starts on weekday w (0 = Sunday)
  uint32_t first_stop;  // offset into Timetable::stops
  uint32_t num_stops;
  std::vector<std::string> placeholder_names;  // names for kNoStation stops, in order
};

// A departure opportunity of a train pattern at a station, independent of the calendar date.
struct DepartureEvent {
  int32_t tod;          // departure time of day, 0..1439
  int32_t day_offset;   // (dep / 1440): how many days after the train's start date it departs
  uint32_t train;
  uint32_t stop;        // stop index within the train
};

struct Timetable {
  std::vector<Station> stations;
  std::vector<Train> trains;
  std::vector<Stop> stops;
  // stations[s] -> departure events sorted by (tod, train, stop)
  std::vector<std::vector<DepartureEvent>> departures;
  std::unordered_map<std::string, int32_t> station_by_code;
  // per train: (station, stop index) pairs sorted by station, at [first_stop, first_stop + num_stops)
  // (placeholder stops excluded, so a train's range may hold fewer entries; see station_index_end)
  std::vector<std::pair<int32_t, uint32_t>> station_index;
  std::vector<uint32_t> station_index_end;  // per train: end offset into station_index
  int32_t max_span_days = 1;    // max over trains of ceil(last arrival / 1440)
  size_t connection_count = 0;  // elementary stop-to-stop hops per service day pattern
  // FNV-1a 64 of the source file bytes, as 16 lowercase hex digits. The API computes the same hash
  // over its own copy, so it can refuse to render results computed from a different timetable.
  std::string hash;

  const Stop& stop(const Train& t, uint32_t i) const { return stops[t.first_stop + i]; }
  // True if train `t` calls at `station` at a stop index in [lo, hi].
  bool train_calls_at(uint32_t t, int32_t station, uint32_t lo, uint32_t hi) const;
  int32_t find_station(std::string_view code) const;

  // Build derived indexes (departures, spans). Called by loaders after stations/trains/stops are set.
  void finalize();
};

// Loads data/processed/timetable.json (format "railway-timetable/v1").
Timetable load_timetable_json(const std::string& path);

// FNV-1a 64 of `bytes`, as 16 lowercase hex digits.
std::string fnv1a64_hex(std::string_view bytes);

// Parses the same format from an in-memory string (used by tests).
Timetable parse_timetable_json(const std::string& text);

}  // namespace rail
