#include "civil_time.h"
#include "doctest.h"

using namespace rail;

TEST_CASE("civil date round trip and weekday") {
  CHECK(days_from_civil(1970, 1, 1) == 0);
  CHECK(weekday(0) == 4);  // Thursday
  const int32_t d = *parse_date("2026-09-25");
  CHECK(weekday(d) == 5);  // Friday
  CHECK(format_date(d) == "2026-09-25");
  CHECK(format_date(*parse_date("2024-02-29")) == "2024-02-29");
  for (int32_t x = -1000; x < 80000; x += 37) {
    const Civil c = civil_from_days(x);
    CHECK(days_from_civil(c.y, c.m, c.d) == x);
  }
}

TEST_CASE("date and time parsing rejects invalid input") {
  CHECK_FALSE(parse_date("2026-02-30"));
  CHECK_FALSE(parse_date("2026-13-01"));
  CHECK_FALSE(parse_date("26-09-25"));
  CHECK_FALSE(parse_date("2026/09/25"));
  CHECK(parse_hhmm("00:00") == 0);
  CHECK(parse_hhmm("23:59") == 1439);
  CHECK_FALSE(parse_hhmm("24:00"));
  CHECK_FALSE(parse_hhmm("9:00"));
  CHECK_FALSE(parse_hhmm("09:60"));
}

TEST_CASE("absolute datetime formatting crosses midnight and months") {
  const int64_t d = *parse_date("2026-09-30");
  CHECK(format_datetime(d * 1440 + 23 * 60 + 40) == "2026-09-30T23:40:00");
  CHECK(format_datetime(d * 1440 + 1440 + 75) == "2026-10-01T01:15:00");
}
