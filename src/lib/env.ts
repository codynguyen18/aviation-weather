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
  // Optional: enables the live AI chat. Without it the chat endpoint reports
  // "not configured" and everything else keeps working.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-4-8"),
  // Auth: cookie-signing secret (required in production — generate with
  // `openssl rand -base64 32`). Email delivery for magic links is optional:
  // without RESEND_API_KEY the link is printed to the server log instead.
  AUTH_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).default("onboarding@resend.dev"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}
