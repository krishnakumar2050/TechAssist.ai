import pino from "pino";
import { correlation } from "./trace-context";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  mixin: correlation,
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
