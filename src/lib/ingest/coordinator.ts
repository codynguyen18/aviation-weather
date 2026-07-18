import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

// The fetch coordinator owns ALL upstream traffic (PLAN.md §7.8):
// - per-host token bucket (self-imposed, far under AWC's 100 req/min)
// - request coalescing: one in-flight fetch per URL, callers share it
// - TTL memory cache keyed by URL (per-product TTLs from verified headers)
// - timeout + single retry + per-host circuit breaker
// - tri-state results: fresh | cached-stale | failed — no silent failures

export type FetchState = "fresh" | "cached-stale" | "failed";

export interface FetchOutcome {
  state: FetchState;
  httpStatus?: number;
  body?: string;         // present for fresh and cached-stale
  fetchedAt?: string;    // when the body was actually retrieved
  error?: string;
  url: string;
}

interface CacheEntry {
  body: string;
  fetchedAt: number;
  httpStatus: number;
}

interface HostState {
  tokens: number;
  lastRefill: number;
  failures: number;
  openUntil: number; // circuit breaker: no requests until this time
}

export interface CoordinatorOptions {
  tokensPerMinute?: number;
  timeoutMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests
}

export class FetchCoordinator {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<FetchOutcome>>();
  private hosts = new Map<string, HostState>();
  private readonly tokensPerMinute: number;
  private readonly timeoutMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CoordinatorOptions = {}) {
    this.tokensPerMinute = opts.tokensPerMinute ?? 30;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.breakerThreshold = opts.breakerThreshold ?? 4;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Fetch with coalescing + cache. ttlMs: how long a body stays "fresh". */
  async get(url: string, ttlMs: number): Promise<FetchOutcome> {
    const cached = this.cache.get(url);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < ttlMs) {
      return {
        state: "fresh",
        body: cached.body,
        httpStatus: cached.httpStatus,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        url,
      };
    }

    const existing = this.inflight.get(url);
    if (existing) return existing;

    const p = this.fetchWithPolicy(url)
      .then((outcome): FetchOutcome => {
        if (outcome.state === "fresh" && outcome.body !== undefined) {
          this.cache.set(url, {
            body: outcome.body,
            fetchedAt: Date.parse(outcome.fetchedAt!),
            httpStatus: outcome.httpStatus ?? 200,
          });
          return outcome;
        }
        // Upstream failed: serve the stale cached body if we have one,
        // clearly labeled — never silently, never as fresh.
        if (cached) {
          return {
            state: "cached-stale",
            body: cached.body,
            httpStatus: cached.httpStatus,
            fetchedAt: new Date(cached.fetchedAt).toISOString(),
            error: outcome.error,
            url,
          };
        }
        return outcome;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private hostState(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { tokens: this.tokensPerMinute, lastRefill: Date.now(), failures: 0, openUntil: 0 };
      this.hosts.set(host, s);
    }
    return s;
  }

  private async fetchWithPolicy(url: string): Promise<FetchOutcome> {
    const host = new URL(url).host;
    const state = this.hostState(host);
    const now = Date.now();

    if (now < state.openUntil) {
      return { state: "failed", error: `circuit open for ${host}`, url };
    }

    // Token bucket refill (per-minute rate).
    const elapsedMin = (now - state.lastRefill) / 60_000;
    state.tokens = Math.min(
      this.tokensPerMinute,
      state.tokens + elapsedMin * this.tokensPerMinute,
    );
    state.lastRefill = now;
    if (state.tokens < 1) {
      return { state: "failed", error: `rate limit budget exhausted for ${host}`, url };
    }
    state.tokens -= 1;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            "User-Agent": env().UPSTREAM_USER_AGENT,
            Accept: "*/*",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await res.text();
        if (res.ok) {
          state.failures = 0;
          return {
            state: "fresh",
            httpStatus: res.status,
            body,
            fetchedAt: new Date().toISOString(),
            url,
          };
        }
        // NWS rate limiting is a 403 HTML page that clears in ~5 s — one
        // short-delay retry is the documented remedy (PLAN.md §7.2).
        if (res.status === 403 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        if (res.status >= 500 && attempt === 0) continue;
        this.recordFailure(state, host);
        return { state: "failed", httpStatus: res.status, error: `HTTP ${res.status}`, url };
      } catch (err) {
        if (attempt === 0) continue;
        this.recordFailure(state, host);
        return { state: "failed", error: String(err), url };
      }
    }
    this.recordFailure(state, host);
    return { state: "failed", error: "unreachable", url };
  }

  private recordFailure(state: HostState, host: string) {
    state.failures += 1;
    if (state.failures >= this.breakerThreshold) {
      state.openUntil = Date.now() + this.breakerCooldownMs;
      state.failures = 0;
      logger.warn({ host }, "circuit breaker opened");
    }
  }
}

// Process-wide singleton (the app runs as one long-lived server).
let shared: FetchCoordinator | null = null;
export function coordinator(): FetchCoordinator {
  if (!shared) shared = new FetchCoordinator();
  return shared;
}
