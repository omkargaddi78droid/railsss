// Helpers to build small synthetic timetables for tests.
#pragma once

#include <string>
#include <vector>

#include "civil_time.h"
#include "json.hpp"
#include "router.h"
#include "timetable.h"

namespace rail::test {

// Minutes relative to the train's start date, written like the raw data: "HH:MM" plus day_of_journey.
inline int32_t t(int day_of_journey, const char* hhmm) { return (day_of_journey - 1) * 1440 + *parse_hhmm(hhmm); }

struct SStop {
  std::string code;
  int32_t arr;  // -1 at origin
  int32_t dep;  // -1 at terminus
};

struct STrain {
  std::string number;
  std::vector<SStop> stops;
  int days = 0x7f;  // bit0 = Sunday
};

inline constexpr int SUN = 1, MON = 2, TUE = 4, WED = 8, THU = 16, FRI = 32, SAT = 64, DAILY = 0x7f;

inline Timetable build(const std::vector<STrain>& trains) {
  std::vector<std::string> codes;
  auto idx = [&](const std::string& c) {
    for (size_t i = 0; i < codes.size(); ++i)
      if (codes[i] == c) return static_cast<int>(i);
    codes.push_back(c);
    return static_cast<int>(codes.size() - 1);
  };
  nlohmann::json doc;
  doc["format"] = "railway-timetable/v1";
  doc["trains"] = nlohmann::json::array();
  for (const auto& tr : trains) {
    nlohmann::json jt{{"number", tr.number}, {"name", tr.number + " EXP"}, {"type", "TEST"}, {"days", tr.days}};
    jt["stops"] = nlohmann::json::array();
    float dist = 0;
    for (const auto& s : tr.stops) {
      jt["stops"].push_back({idx(s.code), s.arr, s.dep, dist});
      dist += 10;
    }
    doc["trains"].push_back(jt);
  }
  doc["stations"] = nlohmann::json::array();
  for (const auto& c : codes) doc["stations"].push_back({{"code", c}, {"name", c + " JN"}});
  return parse_timetable_json(doc.dump());
}

inline Query query(const Timetable& tt, const char* from, const char* to, const char* date, const char* time, int limit = 20) {
  return Query{tt.find_station(from), tt.find_station(to), *parse_date(date), *parse_hhmm(time), limit};
}

// "12345:A>B|67890:B>C|"
inline std::string legs_of(const Journey& j) { return j.signature; }

}  // namespace rail::test
