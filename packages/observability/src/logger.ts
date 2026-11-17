import pino, { type Logger, type LoggerOptions } from "pino";

export type ServiceLogger = Logger;

/** Cloud Logging–friendly JSON: severity + message (+ custom fields). */
export function createServiceLogger(
  service: string,
  opts?: { level?: string },
): ServiceLogger {
  const level = opts?.level ?? process.env.LOG_LEVEL ?? "info";
  const options: LoggerOptions = {
    level,
    base: { service },
    messageKey: "message",
    formatters: {
      level(label) {
        return { severity: label.toUpperCase() };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "password",
        "otp",
        "code",
        "*.otp",
        "*.accessToken",
      ],
      remove: true,
    },
  };
  return pino(options);
}

/** Fastify logger config — same shape as createServiceLogger for Cloud Logging. */
export function fastifyLoggerOptions(service = "localmeals-api"): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    messageKey: "message",
    formatters: {
      level(label) {
        return { severity: label.toUpperCase() };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "password",
        "otp",
        "code",
      ],
      remove: true,
    },
  };
}
