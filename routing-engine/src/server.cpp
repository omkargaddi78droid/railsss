// Long-running routing service. Loads the processed timetable once, then answers
//   POST /route   {"source":"BD","destination":"NDLS","date":"2026-09-25","time":"10:00","limit":20}
//   GET  /health
// Configuration comes from environment variables (see .env.example).

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>

#include "civil_time.h"
#include "httplib.h"
#include "journey_json.h"
#include "router.h"

using nlohmann::json;

namespace {

int env_int(const char* name, int def) {
  const char* v = std::getenv(name);
  if (!v || !*v) return def;
  try {
    return std::stoi(v);
  } catch (...) {
    std::cerr << "invalid integer for " << name << ", using " << def << "\n";
    return def;
  }
}

std::string env_str(const char* name, const std::string& def) {
  const char* v = std::getenv(name);
  return v && *v ? v : def;
}

std::mutex log_mu;
void log_line(const json& j) {
  std::lock_guard<std::mutex> lk(log_mu);
  std::cout << j.dump() << std::endl;
}

double now_ms() {
  return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

}  // namespace

int main() {
  const auto t0 = std::chrono::steady_clock::now();
  const std::string path = env_str("TIMETABLE_PATH", "../data/processed/timetable.json");
  rail::RouterConfig cfg;
  cfg.min_transfer_minutes = env_int("MIN_TRANSFER_MINUTES", cfg.min_transfer_minutes);
  cfg.max_transfers = env_int("MAX_TRANSFERS_INTERNAL", cfg.max_transfers);
  cfg.top_k = env_int("TOP_K", cfg.top_k);
  cfg.k_node = env_int("K_NODE", cfg.k_node);
  cfg.prune_stay_on = env_int("PRUNE_STAY_ON", 1) != 0;
  cfg.prune_board_earlier = env_int("PRUNE_BOARD_EARLIER", 1) != 0;
  cfg.horizon_minutes = env_int("SEARCH_HORIZON_MINUTES", cfg.horizon_minutes);
  cfg.max_labels = static_cast<uint32_t>(env_int("MAX_LABELS", static_cast<int>(cfg.max_labels)));
  const std::string host = env_str("ENGINE_HOST", "0.0.0.0");
  const int port = env_int("ENGINE_PORT", 7070);
  // cpp-httplib holds a pool thread per open (keep-alive) connection, so this must exceed the
  // number of concurrent client connections (the API caps its own at ENGINE_CONCURRENCY).
  const int threads = env_int("ENGINE_THREADS", 8);

  rail::Timetable tt;
  try {
    tt = rail::load_timetable_json(path);
  } catch (const std::exception& e) {
    log_line({{"level", "fatal"}, {"msg", "failed to load timetable"}, {"path", path}, {"error", e.what()}});
    return 1;
  }
  const rail::Router router(tt, cfg);
  const double load_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  log_line({{"level", "info"},
            {"msg", "timetable loaded"},
            {"path", path},
            {"stations", tt.stations.size()},
            {"trains", tt.trains.size()},
            {"stops", tt.stops.size()},
            {"load_ms", load_ms},
            {"config", rail::config_to_json(router.config())}});

  std::atomic<uint64_t> requests{0}, errors{0};
  std::atomic<uint64_t> total_route_us{0};

  httplib::Server srv;
  srv.new_task_queue = [threads] { return new httplib::ThreadPool(static_cast<size_t>(threads)); };
  // httplib writes headers and body separately; with Nagle on, the body waits for the client's
  // delayed ACK of the headers (~40 ms per response on Linux).
  srv.set_tcp_nodelay(true);

  srv.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
    const uint64_t n = requests.load();
    reply(res, 200,
          {{"status", "ok"},
           {"stations", tt.stations.size()},
           {"trains", tt.trains.size()},
           {"load_ms", load_ms},
           {"requests", n},
           {"errors", errors.load()},
           {"avg_route_ms", n ? total_route_us.load() / 1000.0 / n : 0.0},
           {"config", rail::config_to_json(router.config())}});
  });

  srv.Post("/route", [&](const httplib::Request& req, httplib::Response& res) {
    const double start = now_ms();
    json body;
    try {
      body = json::parse(req.body);
    } catch (...) {
      ++errors;
      return reply(res, 400, {{"status", "invalid"}, {"error", "body is not valid JSON"}});
    }
    auto str = [&](const char* k) { return body.contains(k) && body[k].is_string() ? body[k].get<std::string>() : std::string(); };
    rail::Query q;
    q.source = tt.find_station(str("source"));
    q.destination = tt.find_station(str("destination"));
    const auto day = rail::parse_date(str("date"));
    const auto tm = rail::parse_hhmm(str("time"));
    if (q.source < 0 || q.destination < 0 || !day || !tm) {
      ++errors;
      return reply(res, 400,
                   {{"status", "invalid"},
                    {"error", q.source < 0 ? "unknown source station"
                              : q.destination < 0 ? "unknown destination station"
                              : !day ? "date must be YYYY-MM-DD"
                                     : "time must be HH:MM"}});
    }
    q.date_day = *day;
    q.time_minute = *tm;
    q.limit = body.contains("limit") && body["limit"].is_number_integer() ? body["limit"].get<int>() : 0;

    const rail::RouteResult r = router.route(q);
    if (r.status == rail::RouteStatus::InvalidQuery) {
      ++errors;
      return reply(res, 400, {{"status", "invalid"}, {"error", r.error}});
    }
    json out = rail::result_to_json(tt, q, r);
    ++requests;
    total_route_us += static_cast<uint64_t>(r.stats.total_ms * 1000);
    reply(res, 200, out);
    log_line({{"level", "info"},
              {"msg", "route"},
              {"source", str("source")},
              {"destination", str("destination")},
              {"date", str("date")},
              {"time", str("time")},
              {"routes", r.journeys.size()},
              {"route_ms", r.stats.total_ms},
              {"handler_ms", now_ms() - start},
              {"labels", r.stats.labels_created},
              {"truncated", r.stats.truncated}});
  });

  srv.set_exception_handler([&](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
    ++errors;
    std::string what = "internal error";
    try {
      if (ep) std::rethrow_exception(ep);
    } catch (const std::exception& e) {
      what = e.what();
    } catch (...) {
    }
    log_line({{"level", "error"}, {"msg", "handler exception"}, {"error", what}});
    reply(res, 500, {{"status", "error"}, {"error", "internal error"}});
  });

  log_line({{"level", "info"}, {"msg", "listening"}, {"host", host}, {"port", port}, {"threads", threads}});
  if (!srv.listen(host, port)) {
    log_line({{"level", "fatal"}, {"msg", "failed to bind"}, {"host", host}, {"port", port}});
    return 1;
  }
  return 0;
}
