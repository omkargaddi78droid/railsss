// Long-running, compute-only routing worker. Loads the processed timetable once, then answers
//   POST /route   {"source":"BD","destination":"NDLS","date":"2026-09-25","time":"10:00","limit":50}
//                 -> compact journeys (timetable indices + absolute minutes; see journey_json.h)
//   GET  /health
//   GET  /metrics  (Prometheus text format)
// /health and /metrics are also served on ADMIN_PORT by a separate two-thread listener, so health
// checkers and Prometheus never park one of the routing threads on their kept-alive sockets.
// SIGTERM/SIGINT drain the worker: /health turns 503 "draining" for SHUTDOWN_GRACE_MS (dispatchers
// eject it while it still serves), then the listeners stop and in-flight searches finish.
// Configuration comes from environment variables (see .env.example).

#include <atomic>
#include <csignal>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

#include <pthread.h>

#include "civil_time.h"
#include "httplib.h"
#include "journey_json.h"
#include "metrics.h"
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
  // Block the shutdown signals in every thread (httplib's pools inherit the mask); a dedicated
  // thread receives them with sigwait. This also makes the engine stoppable as PID 1 in a container.
  sigset_t stop_signals;
  sigemptyset(&stop_signals);
  sigaddset(&stop_signals, SIGTERM);
  sigaddset(&stop_signals, SIGINT);
  pthread_sigmask(SIG_BLOCK, &stop_signals, nullptr);

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
  // cpp-httplib holds a pool thread per open (keep-alive) connection, so this must be at least the
  // number of concurrent client connections: the API's ENGINE_CONCURRENCY per API process, plus
  // any health checker or scraper that uses ENGINE_PORT instead of ADMIN_PORT.
  const int threads = env_int("ENGINE_THREADS", 8);
  const int admin_port = env_int("ADMIN_PORT", 7071);  // 0 = no separate admin listener
  const int grace_ms = env_int("SHUTDOWN_GRACE_MS", 3000);
  // Identifies this process when many workers sit behind one dispatcher (logs, metrics, responses).
  const std::string worker_id = env_str("WORKER_ID", "engine");

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
            {"timetable", tt.hash},
            {"stations", tt.stations.size()},
            {"trains", tt.trains.size()},
            {"stops", tt.stops.size()},
            {"load_ms", load_ms},
            {"config", rail::config_to_json(router.config())}});

  std::atomic<uint64_t> requests{0}, errors{0};
  std::atomic<uint64_t> total_route_us{0};
  rail::EngineMetrics metrics;
  std::atomic<bool> draining{false};

  httplib::Server srv;
  srv.new_task_queue = [threads] { return new httplib::ThreadPool(static_cast<size_t>(threads)); };
  // httplib writes headers and body separately; with Nagle on, the body waits for the client's
  // delayed ACK of the headers (~40 ms per response on Linux).
  srv.set_tcp_nodelay(true);

  const auto health = [&](const httplib::Request&, httplib::Response& res) {
    const uint64_t n = requests.load();
    const bool drain = draining.load();
    reply(res, drain ? 503 : 200,
          {{"status", drain ? "draining" : "ok"},
           {"worker", worker_id},
           {"timetable", tt.hash},
           {"stations", tt.stations.size()},
           {"trains", tt.trains.size()},
           {"load_ms", load_ms},
           {"requests", n},
           {"errors", errors.load()},
           {"avg_route_ms", n ? total_route_us.load() / 1000.0 / n : 0.0},
           {"config", rail::config_to_json(router.config())}});
  };
  const auto metrics_text = [&](const httplib::Request&, httplib::Response& res) {
    res.set_content(metrics.render(worker_id), "text/plain; version=0.0.4");
  };
  srv.Get("/health", health);
  srv.Get("/metrics", metrics_text);

  srv.Post("/route", [&](const httplib::Request& req, httplib::Response& res) {
    const double start = now_ms();
    metrics.in_flight.fetch_add(1, std::memory_order_relaxed);
    struct InFlight {
      rail::EngineMetrics& m;
      ~InFlight() { m.in_flight.fetch_sub(1, std::memory_order_relaxed); }
    } in_flight_guard{metrics};
    json body;
    try {
      body = json::parse(req.body);
    } catch (...) {
      ++errors;
      ++metrics.requests_invalid;
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
      ++metrics.requests_invalid;
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
      ++metrics.requests_invalid;
      return reply(res, 400, {{"status", "invalid"}, {"error", r.error}});
    }
    ++requests;
    total_route_us += static_cast<uint64_t>(r.stats.total_ms * 1000);
    res.set_content(rail::compact_json(tt, q, r, worker_id), "application/json");
    res.status = 200;
    ++(r.status == rail::RouteStatus::Ok ? metrics.requests_ok : metrics.requests_no_route);
    if (r.stats.truncated) ++metrics.budget_hits;
    metrics.labels_popped += r.stats.labels_popped;
    metrics.response_bytes += res.body.size();
    metrics.route_seconds.observe(r.stats.total_ms / 1000.0);
    metrics.handler_seconds.observe((now_ms() - start) / 1000.0);
  });

  srv.set_exception_handler([&](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
    ++errors;
    ++metrics.requests_error;
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

  httplib::Server admin;
  admin.new_task_queue = [] { return new httplib::ThreadPool(2); };
  admin.set_tcp_nodelay(true);
  admin.Get("/health", health);
  admin.Get("/metrics", metrics_text);
  std::thread admin_thread;
  if (admin_port > 0) {
    if (!admin.bind_to_port(host, admin_port)) {
      log_line({{"level", "fatal"}, {"msg", "failed to bind"}, {"host", host}, {"port", admin_port}});
      return 1;
    }
    admin_thread = std::thread([&] { admin.listen_after_bind(); });
  }

  // Detached: if the main bind fails, main returns while this thread still waits in sigwait.
  std::thread([&] {
    int sig = 0;
    sigwait(&stop_signals, &sig);
    draining = true;
    log_line({{"level", "info"}, {"msg", "draining"}, {"signal", sig}, {"grace_ms", grace_ms}});
    std::this_thread::sleep_for(std::chrono::milliseconds(grace_ms));
    srv.wait_until_ready();
    srv.stop();  // listen() returns once the in-flight and already accepted requests are answered
  }).detach();

  log_line({{"level", "info"},
            {"msg", "listening"},
            {"host", host},
            {"port", port},
            {"admin_port", admin_port},
            {"threads", threads},
            {"worker", worker_id}});
  if (!srv.listen(host, port)) {
    log_line({{"level", "fatal"}, {"msg", "failed to bind"}, {"host", host}, {"port", port}});
    std::_Exit(1);  // skip destructors: the admin and signal threads still reference locals
  }
  if (admin_thread.joinable()) {
    admin.stop();
    admin_thread.join();
  }
  log_line({{"level", "info"}, {"msg", "stopped"}, {"requests", requests.load()}});
  return 0;
}
