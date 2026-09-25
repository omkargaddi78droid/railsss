// Calendar helpers. The model uses naive local (IST) time with no DST, so an absolute time is simply
// minutes since 1970-01-01 00:00 local: day_index * 1440 + minute_of_day.
#pragma once

#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>

namespace rail {

// Howard Hinnant's days_from_civil.
constexpr int32_t days_from_civil(int32_t y, uint32_t m, uint32_t d) {
  y -= m <= 2;
  const int32_t era = (y >= 0 ? y : y - 399) / 400;
  const uint32_t yoe = static_cast<uint32_t>(y - era * 400);
  const uint32_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int32_t>(doe) - 719468;
}

struct Civil {
  int32_t y;
  uint32_t m, d;
};

constexpr Civil civil_from_days(int32_t z) {
  z += 719468;
  const int32_t era = (z >= 0 ? z : z - 146096) / 146097;
  const uint32_t doe = static_cast<uint32_t>(z - era * 146097);
  const uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int32_t y = static_cast<int32_t>(yoe) + era * 400;
  const uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const uint32_t mp = (5 * doy + 2) / 153;
  const uint32_t d = doy - (153 * mp + 2) / 5 + 1;
  const uint32_t m = mp + (mp < 10 ? 3 : -9);
  return {y + (m <= 2), m, d};
}

// 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday).
constexpr int weekday(int32_t day_index) {
  const int w = static_cast<int>((day_index + 4) % 7);
  return w < 0 ? w + 7 : w;
}

inline int floor_div(int64_t a, int64_t b) { return static_cast<int>(a / b - ((a % b != 0) && ((a < 0) != (b < 0)))); }

// "YYYY-MM-DD" -> day index; validates the calendar date.
inline std::optional<int32_t> parse_date(std::string_view s) {
  if (s.size() != 10 || s[4] != '-' || s[7] != '-') return std::nullopt;
  for (size_t i : {0, 1, 2, 3, 5, 6, 8, 9})
    if (s[i] < '0' || s[i] > '9') return std::nullopt;
  const int y = (s[0] - '0') * 1000 + (s[1] - '0') * 100 + (s[2] - '0') * 10 + (s[3] - '0');
  const unsigned m = (s[5] - '0') * 10 + (s[6] - '0');
  const unsigned d = (s[8] - '0') * 10 + (s[9] - '0');
  if (m < 1 || m > 12 || d < 1 || d > 31) return std::nullopt;
  const int32_t idx = days_from_civil(y, m, d);
  const Civil back = civil_from_days(idx);
  if (back.y != y || back.m != m || back.d != d) return std::nullopt;  // e.g. 2026-02-30
  return idx;
}

// "HH:MM" -> minute of day.
inline std::optional<int32_t> parse_hhmm(std::string_view s) {
  if (s.size() != 5 || s[2] != ':') return std::nullopt;
  for (size_t i : {0, 1, 3, 4})
    if (s[i] < '0' || s[i] > '9') return std::nullopt;
  const int h = (s[0] - '0') * 10 + (s[1] - '0');
  const int m = (s[3] - '0') * 10 + (s[4] - '0');
  if (h > 23 || m > 59) return std::nullopt;
  return h * 60 + m;
}

// absolute minutes -> "YYYY-MM-DDTHH:MM:00"
inline std::string format_datetime(int64_t abs_min) {
  const int day = floor_div(abs_min, 1440);
  const int mod = static_cast<int>(abs_min - static_cast<int64_t>(day) * 1440);
  const Civil c = civil_from_days(day);
  char buf[32];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02uT%02d:%02d:00", c.y, c.m, c.d, mod / 60, mod % 60);
  return buf;
}

inline std::string format_date(int32_t day) {
  const Civil c = civil_from_days(day);
  char buf[16];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02u", c.y, c.m, c.d);
  return buf;
}

}  // namespace rail
