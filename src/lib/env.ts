import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://aviation:aviation@localhost:5432/aviation_weather"),
  UPSTREAM_USER_AGENT: z
    .string()
    .min(1)
    .default("aviation-weather-planner (dev, unconfigured@example.com)"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}
