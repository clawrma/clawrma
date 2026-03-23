import { afterEach, describe, expect, it, vi } from "vitest";

const solverLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logging.js", () => ({
  solverLogger: solverLoggerMock,
}));

import { createIdleDetector } from "./idle.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("idle detection", () => {
  it("returns null detector for framework none", () => {
    expect(createIdleDetector("none")).toBeNull();
  });

  it("marks openclaw as busy when gateway reports active sessions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ activeSessions: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const detector = createIdleDetector("openclaw", {
      fetchImpl: fetchMock,
    });
    expect(detector).not.toBeNull();
    await expect(detector?.isIdle()).resolves.toBe(false);
  });

  it("marks openclaw as idle when gateway reports zero active sessions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ activeSessions: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const detector = createIdleDetector("openclaw", {
      fetchImpl: fetchMock,
    });
    expect(detector).not.toBeNull();
    await expect(detector?.isIdle()).resolves.toBe(true);
  });

  it("falls back to idle when gateway is unavailable and no recent user activity exists", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const detector = createIdleDetector("openclaw", {
      fetchImpl: fetchMock,
      nowMs: () => 120_000,
      fallbackBusyThresholdMs: 30_000,
    });
    expect(detector).not.toBeNull();
    await expect(detector?.isIdle()).resolves.toBe(true);
  });

  it("falls back to busy when gateway is unavailable and recent user activity exists", async () => {
    let now = 120_000;
    const fetchMock = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const detector = createIdleDetector("openclaw", {
      fetchImpl: fetchMock,
      nowMs: () => now,
      fallbackBusyThresholdMs: 30_000,
    });
    expect(detector).not.toBeNull();

    detector?.recordUserActivity(100_000);
    now = 120_000;

    await expect(detector?.isIdle()).resolves.toBe(false);
  });

  it("reads the fallback busy threshold from the environment", async () => {
    let now = 114_000;
    vi.stubEnv("CLAWRMA_IDLE_FALLBACK_BUSY_THRESHOLD_MS", "15000");

    const fetchMock = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const detector = createIdleDetector("openclaw", {
      fetchImpl: fetchMock,
      nowMs: () => now,
    });
    expect(detector).not.toBeNull();

    detector?.recordUserActivity(100_000);

    await expect(detector?.isIdle()).resolves.toBe(false);

    now = 116_000;
    await expect(detector?.isIdle()).resolves.toBe(true);
  });
});
