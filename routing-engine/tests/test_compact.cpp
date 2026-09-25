// The compact /route output (journey_json.h compact_json) must parse and carry exactly the legs of
// the router's Journey structs; the API renders everything else from those tuples.
#include "doctest.h"
#include "journey_json.h"
#include "synthetic.h"

using namespace rail;
using namespace rail::test;

TEST_CASE("compact output parses and mirrors the journeys") {
  const auto tt = build({
      {"90001", {{"A", -1, t(1, "10:00")}, {"Z", t(2, "01:00"), -1}}},
      {"10001", {{"A", -1, t(1, "10:00")}, {"B", t(1, "11:00"), t(1, "11:05")}, {"C", t(1, "12:00"), -1}}},
      {"10002", {{"C", -1, t(1, "13:00")}, {"Z", t(1, "14:00"), -1}}},
  });
  const Router router(tt, RouterConfig{});
  const Query q = query(tt, "A", "Z", "2026-09-25", "09:00");
  const RouteResult r = router.route(q);
  REQUIRE(r.journeys.size() == 2);

  const auto doc = nlohmann::json::parse(compact_json(tt, q, r, "w\"1"));
  CHECK(doc["status"] == "ok");
  CHECK(doc["search_complete"] == true);
  CHECK(doc["worker"] == "w\"1");
  CHECK(doc["timetable"] == tt.hash);
  CHECK(doc["timetable"].get<std::string>().size() == 16);
  CHECK(doc["search_minute"] == static_cast<int64_t>(q.date_day) * 1440 + q.time_minute);
  REQUIRE(doc["journeys"].size() == r.journeys.size());
  for (size_t i = 0; i < r.journeys.size(); ++i) {
    const Journey& j = r.journeys[i];
    const auto& cj = doc["journeys"][i];
    CHECK(cj["signature"] == j.signature);
    CHECK(cj["dep"] == j.departure);
    CHECK(cj["arr"] == j.arrival);
    CHECK(cj["transfers"] == j.transfers);
    CHECK(cj["train_minutes"] == j.train_minutes);
    CHECK(cj["waiting_minutes"] == j.waiting_minutes);
    REQUIRE(cj["legs"].size() == j.legs.size());
    for (size_t k = 0; k < j.legs.size(); ++k) {
      const Leg& l = j.legs[k];
      CHECK(cj["legs"][k] == nlohmann::json::array({l.train, l.board_stop, l.alight_stop, l.start_day}));
    }
  }

  const RouteResult none = router.route(query(tt, "Z", "A", "2026-09-25", "09:00"));
  const auto empty = nlohmann::json::parse(compact_json(tt, q, none, "w1"));
  CHECK(empty["status"] == "no_route");
  CHECK(empty["journeys"].empty());
}

TEST_CASE("timetable hash is FNV-1a 64 of the file bytes") {
  CHECK(fnv1a64_hex("") == "cbf29ce484222325");
  CHECK(fnv1a64_hex("a") == "af63dc4c8601ec8c");
  CHECK(fnv1a64_hex("foobar") == "85944171f73967e8");
}
