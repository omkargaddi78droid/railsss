// Routing scenarios on synthetic timetables where the expected answer is obvious.
// 2026-09-25 is a Friday.
#include <algorithm>

#include "doctest.h"
#include "synthetic.h"

using namespace rail;
using namespace rail::test;

namespace {
std::vector<std::string> sigs(const RouteResult& r) {
  std::vector<std::string> v;
  for (const auto& j : r.journeys) v.push_back(j.signature);
  return v;
}
RouterConfig cfg_default() { return RouterConfig{}; }
}  // namespace

TEST_CASE("time normalization: day_of_journey is the departure day at overnight stops") {
  // KUR arrives 23:45 (day 1), departs 00:05 on day_of_journey 2 (as in the real data).
  const auto tt = build({{"07166", {{"BBSN", -1, t(1, "22:30")}, {"KUR", t(1, "23:45"), t(2, "00:05")}, {"BAM", t(2, "03:05"), -1}}}});
  const Router r(tt, cfg_default());
  const auto res = r.route(query(tt, "BBSN", "BAM", "2026-09-25", "22:00"));
  REQUIRE(res.journeys.size() == 1);
  CHECK(format_datetime(res.journeys[0].departure) == "2026-09-25T22:30:00");
  CHECK(format_datetime(res.journeys[0].arrival) == "2026-09-26T03:05:00");
}

TEST_CASE("multi-transfer journey that arrives earlier ranks above a direct train") {
  const auto tt = build({
      {"90001", {{"A", -1, t(1, "10:00")}, {"Z", t(1, "20:00"), -1}}},
      {"10001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}},
      {"10002", {{"B", -1, t(1, "11:30")}, {"C", t(1, "12:30"), -1}}},
      {"10003", {{"C", -1, t(1, "13:00")}, {"Z", t(1, "14:00"), -1}}},
  });
  const Router r(tt, cfg_default());
  const auto res = r.route(query(tt, "A", "Z", "2026-09-25", "09:00"));
  REQUIRE(res.journeys.size() == 2);
  CHECK(res.journeys[0].signature == "10001:A>B|10002:B>C|10003:C>Z|");
  CHECK(res.journeys[0].transfers == 2);
  CHECK(res.journeys[0].waiting_minutes == 60);
  CHECK(res.journeys[0].train_minutes == 180);
  CHECK(res.journeys[1].signature == "90001:A>Z|");
  CHECK(res.journeys[1].transfers == 0);
}

TEST_CASE("minimum transfer time: exactly 30 minutes is valid, 29 is not") {
  for (auto [dep, ok] : {std::pair{"11:30", true}, std::pair{"11:29", false}}) {
    const auto tt = build({
        {"10001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}},
        {"10002", {{"B", -1, t(1, dep)}, {"C", t(1, "12:30"), -1}}, DAILY},
    });
    // horizon 600 min so the next day's 10002 is out of reach
    RouterConfig c;
    c.horizon_minutes = 600;
    const Router r2(tt, c);
    const auto res = r2.route(query(tt, "A", "C", "2026-09-25", "09:00"));
    CHECK(res.journeys.size() == (ok ? 1u : 0u));
  }
}

TEST_CASE("configurable transfer time") {
  const auto tt = build({
      {"10001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}},
      {"10002", {{"B", -1, t(1, "11:10")}, {"C", t(1, "12:30"), -1}}},
  });
  RouterConfig c;
  c.horizon_minutes = 600;
  c.min_transfer_minutes = 10;
  CHECK(Router(tt, c).route(query(tt, "A", "C", "2026-09-25", "09:00")).journeys.size() == 1);
  c.min_transfer_minutes = 11;
  CHECK(Router(tt, c).route(query(tt, "A", "C", "2026-09-25", "09:00")).journeys.empty());
}

TEST_CASE("overnight train and overnight transfer") {
  const auto tt = build({
      {"20001", {{"A", -1, t(1, "22:00")}, {"B", t(1, "23:50"), t(2, "00:10")}, {"C", t(2, "03:00"), -1}}},
      {"20002", {{"C", -1, t(1, "03:30")}, {"D", t(1, "05:00"), -1}}},
  });
  const Router r(tt, cfg_default());
  const auto res = r.route(query(tt, "A", "D", "2026-09-25", "21:00"));
  REQUIRE(res.journeys.size() == 1);
  const auto& j = res.journeys[0];
  CHECK(j.signature == "20001:A>C|20002:C>D|");
  CHECK(format_datetime(j.legs[0].arr) == "2026-09-26T03:00:00");
  CHECK(format_datetime(j.legs[1].dep) == "2026-09-26T03:30:00");
  CHECK(j.legs[1].start_day == *parse_date("2026-09-26"));
  CHECK(format_datetime(j.arrival) == "2026-09-26T05:00:00");
}

TEST_CASE("initial departure must be on the requested calendar date") {
  const auto tt = build({{"30001", {{"A", -1, t(1, "08:00")}, {"B", t(1, "09:00"), -1}}}});
  const Router r(tt, cfg_default());
  CHECK(r.route(query(tt, "A", "B", "2026-09-25", "22:00")).status == RouteStatus::NoRoute);
  const auto ok = r.route(query(tt, "A", "B", "2026-09-25", "07:00"));
  REQUIRE(ok.journeys.size() == 1);
  CHECK(format_datetime(ok.journeys[0].departure) == "2026-09-25T08:00:00");
  // exactly at the requested time is allowed
  CHECK(r.route(query(tt, "A", "B", "2026-09-25", "08:00")).journeys.size() == 1);
  CHECK(r.route(query(tt, "A", "B", "2026-09-25", "08:01")).journeys.empty());
}

TEST_CASE("initial departure after midnight belongs to the next date; en-route instances are usable") {
  // Starts at X 22:00 day 1, passes A at 01:00 on day 2.
  const auto tt = build({{"30002", {{"X", -1, t(1, "22:00")}, {"A", t(2, "00:55"), t(2, "01:00")}, {"B", t(2, "02:00"), -1}}}});
  const Router r(tt, cfg_default());
  CHECK(r.route(query(tt, "A", "B", "2026-09-25", "23:00")).journeys.empty());  // would depart on the 26th
  const auto res = r.route(query(tt, "A", "B", "2026-09-26", "00:30"));        // instance started on the 25th
  REQUIRE(res.journeys.size() == 1);
  CHECK(res.journeys[0].legs[0].start_day == *parse_date("2026-09-25"));
}

TEST_CASE("operating days apply to the train's start date") {
  const auto tt = build({
      {"40001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}, MON},
      // starts Sunday 20:00 at X, reaches A on day 2 (Monday) 02:05
      {"40002", {{"X", -1, t(1, "20:00")}, {"A", t(2, "02:00"), t(2, "02:05")}, {"C", t(2, "04:00"), -1}}, SUN},
  });
  const Router r(tt, cfg_default());
  CHECK(r.route(query(tt, "A", "B", "2026-09-25", "09:00")).journeys.empty());       // Friday
  CHECK(r.route(query(tt, "A", "B", "2026-09-28", "09:00")).journeys.size() == 1);   // Monday
  CHECK(r.route(query(tt, "A", "C", "2026-09-28", "01:00")).journeys.size() == 1);   // Sunday instance
  CHECK(r.route(query(tt, "A", "C", "2026-09-27", "01:00")).journeys.empty());       // Sunday: previous Saturday no run
}

TEST_CASE("no cycles: journeys never revisit a station") {
  const auto tt = build({
      {"50001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}},
      {"50002", {{"B", -1, t(1, "11:30")}, {"A", t(1, "12:30"), -1}}},
      {"50003", {{"A", -1, t(1, "13:00")}, {"C", t(1, "14:00"), -1}}},
      {"50004", {{"B", -1, t(1, "12:00")}, {"C", t(1, "15:00"), -1}}},
  });
  RouterConfig c;
  c.horizon_minutes = 600;
  const auto res = Router(tt, c).route(query(tt, "A", "C", "2026-09-25", "09:00"));
  CHECK(sigs(res) == std::vector<std::string>{"50003:A>C|", "50001:A>B|50004:B>C|"});
}

TEST_CASE("loop train: boarding where the train would pass the boarding station again is rejected") {
  const auto tt = build({{"60001", {{"X", -1, t(1, "10:00")}, {"Y", t(1, "11:00"), t(1, "11:05")}, {"X", t(1, "12:00"), t(1, "12:05")}, {"Z", t(1, "13:00"), -1}}}});
  RouterConfig c;
  c.horizon_minutes = 600;
  const Router r(tt, c);
  const auto res = r.route(query(tt, "X", "Z", "2026-09-25", "09:00"));
  REQUIRE(res.journeys.size() == 1);
  CHECK(format_datetime(res.journeys[0].departure) == "2026-09-25T12:05:00");
  CHECK(res.journeys[0].legs[0].board_stop == 2);
  const auto y = r.route(query(tt, "Y", "Z", "2026-09-25", "09:00"));
  CHECK(y.journeys.size() == 1);  // passes X once: fine
}

TEST_CASE("identical timetables under different numbers are distinct; identical numbers deduplicate") {
  const std::vector<SStop> s{{"A", -1, t(1, "10:00")}, {"B", t(1, "12:00"), -1}};
  RouterConfig c;
  c.horizon_minutes = 600;
  {
    const auto tt = build({{"12881", s, THU | TUE}, {"12887", s, FRI}});
    const auto res = Router(tt, c).route(query(tt, "A", "B", "2026-09-25", "09:00"));  // Friday
    CHECK(sigs(res) == std::vector<std::string>{"12887:A>B|"});
  }
  {
    const auto tt = build({{"12881", s}, {"12881", s}});
    const auto res = Router(tt, c).route(query(tt, "A", "B", "2026-09-25", "09:00"));
    CHECK(res.journeys.size() == 1);
  }
  {
    const auto tt = build({{"12881", s}, {"12887", s}});
    CHECK(Router(tt, c).route(query(tt, "A", "B", "2026-09-25", "09:00")).journeys.size() == 2);
  }
}

TEST_CASE("same itinerary on a later day is the same journey (signature excludes dates)") {
  const auto tt = build({{"70001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}}, {"70002", {{"B", -1, t(1, "12:00")}, {"C", t(1, "13:00"), -1}}}});
  const auto res = Router(tt, cfg_default()).route(query(tt, "A", "C", "2026-09-25", "09:00"));
  REQUIRE(res.journeys.size() == 1);  // not repeated with 70002 on the 26th, 27th, ...
  CHECK(format_datetime(res.journeys[0].arrival) == "2026-09-25T13:00:00");
}

TEST_CASE("internal transfer cap") {
  const auto tt = build({
      {"80001", {{"A", -1, t(1, "01:00")}, {"B", t(1, "02:00"), -1}}},
      {"80002", {{"B", -1, t(1, "03:00")}, {"C", t(1, "04:00"), -1}}},
      {"80003", {{"C", -1, t(1, "05:00")}, {"D", t(1, "06:00"), -1}}},
      {"80004", {{"D", -1, t(1, "07:00")}, {"E", t(1, "08:00"), -1}}},
  });
  RouterConfig c;
  c.max_transfers = 2;
  CHECK(Router(tt, c).route(query(tt, "A", "E", "2026-09-25", "00:00")).journeys.empty());
  c.max_transfers = 3;
  const auto res = Router(tt, c).route(query(tt, "A", "E", "2026-09-25", "00:00"));
  REQUIRE(res.journeys.size() == 1);
  CHECK(res.journeys[0].transfers == 3);
}

TEST_CASE("stay-on dominance removes a pointless change of train") {
  const auto tt = build({
      {"11001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), t(1, "11:05")}, {"Z", t(1, "13:00"), -1}}},
      {"11002", {{"B", -1, t(1, "11:30")}, {"Z", t(1, "13:00"), -1}}},
      {"11003", {{"B", -1, t(1, "11:35")}, {"Z", t(1, "12:50"), -1}}},
  });
  RouterConfig c;
  c.horizon_minutes = 600;
  const auto on = Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "09:00"));
  CHECK(sigs(on) == std::vector<std::string>{"11001:A>B|11003:B>Z|", "11001:A>Z|"});
  c.prune_stay_on = false;
  const auto off = Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "09:00"));
  CHECK(sigs(off) == std::vector<std::string>{"11001:A>B|11003:B>Z|", "11001:A>Z|", "11001:A>B|11002:B>Z|"});
}

TEST_CASE("board-earlier dominance removes a change onto a train that was already boardable") {
  const auto tt = build({
      {"12001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}},
      {"12002", {{"A", -1, t(1, "10:40")}, {"B", t(1, "11:40"), t(1, "11:45")}, {"Z", t(1, "14:00"), -1}}},
  });
  RouterConfig c;
  c.horizon_minutes = 600;
  CHECK(sigs(Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "09:00"))) == std::vector<std::string>{"12002:A>Z|"});
  c.prune_board_earlier = false;
  CHECK(sigs(Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "09:00"))) ==
        std::vector<std::string>{"12002:A>Z|", "12001:A>B|12002:B>Z|"});
}

TEST_CASE("board-earlier does not apply when the alternative departs earlier (worse tie-break)") {
  const auto tt = build({
      {"12001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}},
      {"12002", {{"A", -1, t(1, "09:00")}, {"B", t(1, "11:40"), t(1, "11:45")}, {"Z", t(1, "14:00"), -1}}},
  });
  RouterConfig c;
  c.horizon_minutes = 600;
  CHECK(sigs(Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "08:00"))) ==
        std::vector<std::string>{"12001:A>B|12002:B>Z|", "12002:A>Z|"});
}

TEST_CASE("ranking: earliest arrival, then later departure, then fewer transfers") {
  const auto tt = build({
      {"13001", {{"A", -1, t(1, "09:00")}, {"Z", t(1, "12:00"), -1}}},
      {"13002", {{"A", -1, t(1, "10:00")}, {"Z", t(1, "12:00"), -1}}},
      {"13003", {{"A", -1, t(1, "10:00")}, {"M", t(1, "10:30"), -1}}},
      {"13004", {{"M", -1, t(1, "11:00")}, {"Z", t(1, "12:00"), -1}}},
      {"13005", {{"A", -1, t(1, "08:00")}, {"Z", t(1, "11:59"), -1}}},
  });
  RouterConfig c;
  c.horizon_minutes = 600;
  const auto res = Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "07:00"));
  CHECK(sigs(res) == std::vector<std::string>{"13005:A>Z|", "13002:A>Z|", "13003:A>M|13004:M>Z|", "13001:A>Z|"});
  const auto one = Router(tt, c).route(query(tt, "A", "Z", "2026-09-25", "07:00", 1));
  CHECK(one.journeys.size() == 1);
}

TEST_CASE("invalid queries are distinguished from no-route results") {
  const auto tt = build({{"14001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), -1}}}, {"14002", {{"C", -1, t(1, "10:00")}, {"D", t(1, "11:00"), -1}}}});
  const Router r(tt, cfg_default());
  CHECK(r.route(query(tt, "A", "A", "2026-09-25", "09:00")).status == RouteStatus::InvalidQuery);
  Query bad = query(tt, "A", "B", "2026-09-25", "09:00");
  bad.source = 999;
  CHECK(r.route(bad).status == RouteStatus::InvalidQuery);
  CHECK(r.route(query(tt, "A", "D", "2026-09-25", "09:00")).status == RouteStatus::NoRoute);  // no connection
  CHECK(r.route(query(tt, "B", "A", "2026-09-25", "09:00")).status == RouteStatus::NoRoute);  // no outgoing train from B
}

TEST_CASE("destination reached days after start once the journey has begun") {
  const auto tt = build({{"15001", {{"A", -1, t(1, "23:00")}, {"B", t(3, "10:00"), -1}}}, {"15002", {{"B", -1, t(1, "09:00")}, {"C", t(2, "09:00"), -1}}}});
  const auto res = Router(tt, cfg_default()).route(query(tt, "A", "C", "2026-09-25", "22:00"));
  REQUIRE(res.journeys.size() == 1);
  CHECK(format_datetime(res.journeys[0].arrival) == "2026-09-29T09:00:00");
}

TEST_CASE("search horizon bounds arrival") {
  const auto tt = build({{"16001", {{"A", -1, t(1, "10:00")}, {"B", t(2, "10:00"), -1}}}});
  RouterConfig c;
  c.horizon_minutes = 1000;
  CHECK(Router(tt, c).route(query(tt, "A", "B", "2026-09-25", "09:00")).journeys.empty());
  c.horizon_minutes = 1500;
  CHECK(Router(tt, c).route(query(tt, "A", "B", "2026-09-25", "09:00")).journeys.size() == 1);
}
