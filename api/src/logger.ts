import { pino, type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({ level, base: { service: "railway-api" }, timestamp: pino.stdTimeFunctions.isoTime });
}

export type { Logger };
