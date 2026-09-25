// Express application factory. Dependencies are injected so tests can use a fake engine.
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "./logger.ts";
import { EngineError, type RoutingEngine } from "./services/engineClient.ts";
import type { RouteService } from "./services/routeService.ts";
import { StationService } from "./services/stationService.ts";

export interface AppDeps {
  logger: Logger;
  stations: StationService;
  routes: RouteService;
  engine: RoutingEngine;
  maxResults: number;
  maxDurationFilterMinutes: number;
  corsOrigin?: string | null;
  mongoStatus?: () => "connected" | "disabled" | "error";
  // Called once per finished request (Prometheus HTTP histogram); route is the matched pattern.
  observe?: (method: string, route: string, status: number, seconds: number) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const stationCode = z
  .string({ error: "must be a station code" })
  .trim()
  .min(1, "is required")
  .max(8)
  .transform((s) => s.toUpperCase());

export function routeRequestSchema(maxResults: number, maxDuration: number) {
  return z
    .object({
      source: stationCode,
      destination: stationCode,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").refine((d) => {
        const dt = new Date(d + "T00:00:00Z");
        return !Number.isNaN(dt.getTime()) && dt.toISOString().startsWith(d);
      }, "is not a valid calendar date"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)"),
      limit: z.coerce.number().int().min(1).max(maxResults, `must be <= ${maxResults}`).default(maxResults),
      page: z.coerce.number().int().min(1).max(maxResults).default(1),
      filters: z
        .object({
          max_duration_minutes: z.coerce.number().int().min(1).max(maxDuration, `must be <= ${maxDuration}`).optional(),
          max_transfers: z.coerce.number().int().min(0).max(50).optional(),
          direct_only: z.boolean().optional(),
        })
        .strict()
        .default({}),
    })
    .strict()
    .refine((r) => r.source !== r.destination, { message: "source and destination must differ", path: ["destination"] });
}

export function createApp(deps: AppDeps) {
  const { logger, stations, routes, engine } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "16kb" }));

  // request id + structured access log with timing
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers["x-request-id"] as string) || randomUUID();
    const start = performance.now();
    res.setHeader("x-request-id", id);
    (req as any).id = id;
    res.on("finish", () => {
      const ms = Math.round((performance.now() - start) * 100) / 100;
      deps.observe?.(req.method, req.route ? req.baseUrl + req.route.path : "unmatched", res.statusCode, ms / 1000);
      logger.info({ req_id: id, method: req.method, path: req.path, status: res.statusCode, ms }, "request");
    });
    if (deps.corsOrigin) {
      res.setHeader("access-control-allow-origin", deps.corsOrigin);
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") return void res.sendStatus(204);
    }
    next();
  });

  const health = async (_req: Request, res: Response) => {
    let engineStatus: Record<string, unknown> | null = null;
    try {
      engineStatus = await engine.health();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "engine health check failed");
    }
    const mongo = deps.mongoStatus?.() ?? "disabled";
    const healthy = engineStatus !== null && stations.size > 0;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "unhealthy",
      checks: {
        engine: engineStatus ? "up" : "down",
        stations: { count: stations.size, source: stations.source },
        mongo,
      },
      engine: engineStatus,
      uptime_s: Math.round(process.uptime()),
    });
  };
  app.get("/health", health);
  app.get("/api/health", health);

  app.get("/api/stations", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "10"), 10) || 10));
    res.json({ query: q, stations: stations.search(q, limit) });
  });

  app.get("/api/stations/:code", (req, res) => {
    const s = stations.get(req.params.code);
    if (!s) throw new HttpError(404, "STATION_NOT_FOUND", `unknown station code ${req.params.code}`);
    res.json({ ...StationService.hit(s), all_known_names: s.all_known_names });
  });

  const schema = routeRequestSchema(deps.maxResults, deps.maxDurationFilterMinutes);
  app.post("/api/routes", async (req, res) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid route request",
        parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
    }
    const q = parsed.data;
    for (const [field, code] of [["source", q.source], ["destination", q.destination]] as const) {
      if (!stations.get(code)) throw new HttpError(400, "UNKNOWN_STATION", `unknown ${field} station code ${code}`, [{ field, message: "unknown station code" }]);
    }
    const body = await routes.search(q);
    res.json(body);
  });

  app.use((_req, _res) => {
    throw new HttpError(404, "NOT_FOUND", "route not found");
  });

  // error handler: validation errors vs. engine outages vs. bugs
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof EngineError) {
      const [status, code] =
        err.kind === "invalid" ? [400, "INVALID_QUERY"] : err.kind === "overloaded" ? [429, "OVERLOADED"] : [503, "ENGINE_UNAVAILABLE"];
      if (err.kind === "overloaded") res.set("retry-after", "1");
      else logger.error({ req_id: (req as any).id, err: err.message }, "engine error");
      return void res.status(status).json({ error: { code, message: err.message } });
    }
    if ((err as any)?.type === "entity.parse.failed") {
      return void res.status(400).json({ error: { code: "INVALID_JSON", message: "request body is not valid JSON" } });
    }
    logger.error({ req_id: (req as any).id, err }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "internal server error" } });
  });

  return app;
}
