// Lock-free Prometheus counters and histograms for the engine's GET /metrics (text format 0.0.4).
// Only what the load-testing study needs; no external dependency.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <sstream>
#include <string>

namespace rail {

// Cumulative histogram with fixed upper bounds (plus the implicit +Inf bucket).
template <size_t N>
class Histogram {
 public:
  explicit constexpr Histogram(const std::array<double, N>& bounds) : bounds_(bounds) {}

  void observe(double v) {
    size_t i = 0;
    while (i < N && v > bounds_[i]) ++i;
    counts_[i].fetch_add(1, std::memory_order_relaxed);
    sum_micro_.fetch_add(static_cast<uint64_t>(v * 1e6), std::memory_order_relaxed);
  }

  void write(std::ostringstream& out, const std::string& name, const std::string& labels) const {
    const std::string sep = labels.empty() ? "" : ",";
    uint64_t cum = 0;
    for (size_t i = 0; i <= N; ++i) {
      cum += counts_[i].load(std::memory_order_relaxed);
      out << name << "_bucket{" << labels << sep << "le=\"";
      if (i < N) out << bounds_[i]; else out << "+Inf";
      out << "\"} " << cum << "\n";
    }
    const std::string braces = labels.empty() ? "" : "{" + labels + "}";
    out << name << "_sum" << braces << " " << sum_micro_.load(std::memory_order_relaxed) / 1e6 << "\n";
    out << name << "_count" << braces << " " << cum << "\n";
  }

 private:
  std::array<double, N> bounds_;
  std::array<std::atomic<uint64_t>, N + 1> counts_{};
  std::atomic<uint64_t> sum_micro_{0};
};

struct EngineMetrics {
  std::atomic<uint64_t> requests_ok{0}, requests_no_route{0}, requests_invalid{0}, requests_error{0};
  std::atomic<int64_t> in_flight{0};
  std::atomic<uint64_t> budget_hits{0}, labels_popped{0}, response_bytes{0};
  // Seconds. Route = profile + search; handler = parse + route + serialization.
  Histogram<14> route_seconds{{0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1.0}};
  Histogram<14> handler_seconds{{0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1.0}};

  std::string render(const std::string& worker_id) const {
    std::ostringstream out;
    const std::string w = "worker=\"" + worker_id + "\"";
    auto counter = [&](const char* name, const char* help, const std::string& labels, uint64_t v) {
      out << "# HELP " << name << " " << help << "\n# TYPE " << name << " counter\n";
      out << name << "{" << labels << "} " << v << "\n";
    };
    out << "# HELP engine_requests_total Route requests by outcome.\n# TYPE engine_requests_total counter\n";
    out << "engine_requests_total{" << w << ",outcome=\"ok\"} " << requests_ok.load() << "\n";
    out << "engine_requests_total{" << w << ",outcome=\"no_route\"} " << requests_no_route.load() << "\n";
    out << "engine_requests_total{" << w << ",outcome=\"invalid\"} " << requests_invalid.load() << "\n";
    out << "engine_requests_total{" << w << ",outcome=\"error\"} " << requests_error.load() << "\n";
    out << "# HELP engine_in_flight Route requests currently being handled.\n# TYPE engine_in_flight gauge\n";
    out << "engine_in_flight{" << w << "} " << in_flight.load() << "\n";
    counter("engine_budget_hits_total", "Searches that hit MAX_LABELS (search_complete=false).", w, budget_hits.load());
    counter("engine_labels_popped_total", "Search labels popped, a proxy for work done.", w, labels_popped.load());
    counter("engine_response_bytes_total", "Bytes of /route response bodies.", w, response_bytes.load());
    out << "# HELP engine_route_seconds Routing time (profile + search).\n# TYPE engine_route_seconds histogram\n";
    route_seconds.write(out, "engine_route_seconds", w);
    out << "# HELP engine_handler_seconds Whole /route handler time incl. JSON.\n# TYPE engine_handler_seconds histogram\n";
    handler_seconds.write(out, "engine_handler_seconds", w);
    return out.str();
  }
};

}  // namespace rail
