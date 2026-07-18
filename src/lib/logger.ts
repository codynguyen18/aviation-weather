import pino from "pino";

import { env } from "@/lib/env";

export const logger = pino({
  level: env().NODE_ENV === "production" ? "info" : "debug",
  base: { app: "aviation-weather" },
});
