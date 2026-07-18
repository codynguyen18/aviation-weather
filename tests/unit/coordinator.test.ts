import { describe, expect, it, vi } from "vitest";

import { FetchCoordinator } from "@/lib/ingest/coordinator";

const okResponse = (body: string) =>
  new Response(body, { status: 200 });

describe("FetchCoordinator", () => {
  it("coalesces concurrent requests for the same URL into one fetch", async () => {
    let calls = 0;
    const c = new FetchCoordinator({
      fetchImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return okResponse("data");
      },
    });
    const [a, b] = await Promise.all([
      c.get("https://x.test/a", 60_000),
      c.get("https://x.test/a", 60_000),
    ]);
    expect(calls).toBe(1);
    expect(a.state).toBe("fresh");
    expect(b.body).toBe("data");
  });

  it("serves from TTL cache without refetching", async () => {
    let calls = 0;
    const c = new FetchCoordinator({
      fetchImpl: async () => {
        calls++;
        return okResponse("v1");
      },
    });
    await c.get("https://x.test/b", 60_000);
    const second = await c.get("https://x.test/b", 60_000);
    expect(calls).toBe(1);
    expect(second.state).toBe("fresh");
  });

  it("returns cached-stale (labeled) when upstream fails after a success", async () => {
    let fail = false;
    const c = new FetchCoordinator({
      fetchImpl: async () => {
        if (fail) throw new Error("net down");
        return okResponse("old-data");
      },
    });
    await c.get("https://x.test/c", 1); // ttl 1ms -> immediately stale
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    const out = await c.get("https://x.test/c", 1);
    expect(out.state).toBe("cached-stale");
    expect(out.body).toBe("old-data");
    expect(out.error).toBeTruthy();
  });

  it("fails cleanly with no cache: state=failed, no body", async () => {
    const c = new FetchCoordinator({
      fetchImpl: async () => {
        throw new Error("refused");
      },
    });
    const out = await c.get("https://x.test/d", 1000);
    expect(out.state).toBe("failed");
    expect(out.body).toBeUndefined();
  });

  it("opens the circuit breaker after repeated failures", async () => {
    let calls = 0;
    const c = new FetchCoordinator({
      breakerThreshold: 2,
      breakerCooldownMs: 60_000,
      fetchImpl: async () => {
        calls++;
        throw new Error("down");
      },
    });
    await c.get("https://y.test/1", 1);
    await c.get("https://y.test/2", 1);
    const before = calls;
    const out = await c.get("https://y.test/3", 1);
    expect(out.state).toBe("failed");
    expect(out.error).toMatch(/circuit open/);
    expect(calls).toBe(before); // breaker prevented the fetch
  });

  it("retries a 403 once after a delay (NWS rate-limit shape)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const c = new FetchCoordinator({
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response("<html>Access Denied</html>", { status: 403 })
          : okResponse("recovered");
      },
    });
    const p = c.get("https://z.test/a", 1000);
    await vi.advanceTimersByTimeAsync(5_100);
    const out = await p;
    vi.useRealTimers();
    expect(calls).toBe(2);
    expect(out.state).toBe("fresh");
    expect(out.body).toBe("recovered");
  });
});
