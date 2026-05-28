import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type {
  IdleDetector,
  IdleDetectorOptions,
  OpenClawGatewayStatusClient,
} from "./idle.js";

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

  it("derives the default gateway websocket URL from OPENCLAW_GATEWAY_PORT", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19999");
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => ({
      tasks: { active: 0 },
    }));
    const detector = requireIdleDetector({
      statusClient,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(statusClient).toHaveBeenCalledWith({
      gatewayUrl: "ws://127.0.0.1:19999",
      gatewayToken: null,
      timeoutMs: 2_000,
    });
  });

  it("uses OPENCLAW_GATEWAY_URL when no explicit gateway URL is supplied", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway.example.com/openclaw");
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => ({
      tasks: { active: 0 },
    }));
    const detector = requireIdleDetector({
      statusClient,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(statusClient).toHaveBeenCalledWith({
      gatewayUrl: "wss://gateway.example.com/openclaw",
      gatewayToken: null,
      timeoutMs: 2_000,
    });
  });

  it("normalizes HTTPS gateway URLs to secure websocket URLs", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "https://gateway.example.com/rpc");
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => ({
      tasks: { active: 0 },
    }));
    const detector = requireIdleDetector({
      statusClient,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(statusClient).toHaveBeenCalledWith({
      gatewayUrl: "wss://gateway.example.com/rpc",
      gatewayToken: null,
      timeoutMs: 2_000,
    });
  });

  it("normalizes loopback HTTP gateway URLs to plaintext websocket URLs", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "http://localhost:18789/rpc");
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => ({
      tasks: { active: 0 },
    }));
    const detector = requireIdleDetector({
      statusClient,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(statusClient).toHaveBeenCalledWith({
      gatewayUrl: "ws://localhost:18789/rpc",
      gatewayToken: null,
      timeoutMs: 2_000,
    });
  });

  it("passes an explicit gateway URL and token to the status client", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://ignored.example.com");
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => ({
      tasks: { active: 0 },
    }));
    const detector = requireIdleDetector({
      gatewayUrl: "https://gateway.example.com",
      gatewayToken: "oc_token",
      statusClient,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(statusClient).toHaveBeenCalledWith({
      gatewayUrl: "wss://gateway.example.com",
      gatewayToken: "oc_token",
      timeoutMs: 2_000,
    });
  });

  it("rejects remote HTTP gateway URLs clearly", () => {
    expect(() =>
      createIdleDetector("openclaw", {
        gatewayUrl: "http://gateway.example.com",
      }),
    ).toThrow(
      "OpenClaw Gateway plaintext URLs must target localhost or a loopback address. Use wss:// for remote gateways.",
    );
  });

  it("rejects remote plaintext websocket URLs clearly", () => {
    expect(() =>
      createIdleDetector("openclaw", {
        gatewayUrl: "ws://gateway.example.com",
      }),
    ).toThrow(
      "OpenClaw Gateway plaintext URLs must target localhost or a loopback address. Use wss:// for remote gateways.",
    );
  });

  it("rejects unsupported gateway URL schemes clearly", () => {
    expect(() =>
      createIdleDetector("openclaw", {
        gatewayUrl: "ftp://gateway.example.com",
      }),
    ).toThrow(
      "OpenClaw Gateway URL must use ws://, wss://, http://, or https://; got ftp:",
    );
  });

  it("rejects malformed gateway URLs clearly", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "not a url");

    expect(() => createIdleDetector("openclaw")).toThrow(
      "OpenClaw Gateway URL must be a valid URL: not a url",
    );
  });

  it("marks openclaw as busy when gateway status reports active tasks", async () => {
    const detector = requireIdleDetector({
      statusClient: vi.fn<OpenClawGatewayStatusClient>(async () => ({
        tasks: { active: 2 },
      })),
    });

    await expect(detector.isIdle()).resolves.toBe(false);
    expect(solverLoggerMock.warn).not.toHaveBeenCalled();
  });

  it("marks openclaw as busy when gateway status reports running tasks", async () => {
    const detector = requireIdleDetector({
      statusClient: vi.fn<OpenClawGatewayStatusClient>(async () => ({
        tasks: { byStatus: { running: 1 } },
      })),
    });

    await expect(detector.isIdle()).resolves.toBe(false);
    expect(solverLoggerMock.warn).not.toHaveBeenCalled();
  });

  it("marks openclaw as idle when gateway status proves no active work", async () => {
    const detector = requireIdleDetector({
      statusClient: vi.fn<OpenClawGatewayStatusClient>(async () => ({
        tasks: { active: 0, byStatus: { running: 0 } },
      })),
    });

    await expect(detector.isIdle()).resolves.toBe(true);
    expect(solverLoggerMock.warn).not.toHaveBeenCalled();
  });

  it("falls back to idle when gateway is unavailable and no recent user activity exists", async () => {
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => {
      throw new Error("gateway unavailable");
    });
    const detector = requireIdleDetector({
      statusClient,
      nowMs: () => 120_000,
      fallbackBusyThresholdMs: 30_000,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(solverLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackIdle: true,
        gatewayUrl: "ws://127.0.0.1:18789",
      }),
      "solver_idle_gateway_unavailable_fallback_applied",
    );
  });

  it("falls back to busy when gateway is unavailable and recent user activity exists", async () => {
    let now = 120_000;
    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => {
      throw new Error("gateway unavailable");
    });
    const detector = requireIdleDetector({
      statusClient,
      nowMs: () => now,
      fallbackBusyThresholdMs: 30_000,
    });

    detector.recordUserActivity(100_000);
    now = 120_000;

    await expect(detector.isIdle()).resolves.toBe(false);

    expect(solverLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackIdle: false,
      }),
      "solver_idle_gateway_unavailable_fallback_applied",
    );
  });

  it("routes latest health liveness payloads through the unknown-status fallback", async () => {
    const detector = requireIdleDetector({
      statusClient: vi.fn<OpenClawGatewayStatusClient>(async () => ({
        ok: true,
        status: "live",
      })),
      nowMs: () => 120_000,
      fallbackBusyThresholdMs: 30_000,
    });

    await expect(detector.isIdle()).resolves.toBe(true);

    expect(solverLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackIdle: true,
        payloadShape: "object:ok,status",
      }),
      "solver_idle_gateway_status_unknown_fallback_applied",
    );
    expect(JSON.stringify(solverLoggerMock.warn.mock.calls)).not.toContain(
      "activeSessions",
    );
  });

  it("falls back to busy when gateway status is unknown and recent user activity exists", async () => {
    let now = 120_000;
    const detector = requireIdleDetector({
      statusClient: vi.fn<OpenClawGatewayStatusClient>(async () => ({
        tasks: { queued: 0 },
      })),
      nowMs: () => now,
      fallbackBusyThresholdMs: 30_000,
    });

    detector.recordUserActivity(100_000);
    now = 120_000;

    await expect(detector.isIdle()).resolves.toBe(false);

    expect(solverLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackIdle: false,
        payloadShape: "object:tasks",
        supportedFields: [],
      }),
      "solver_idle_gateway_status_unknown_fallback_applied",
    );
  });

  it("reads the fallback busy threshold from the environment", async () => {
    let now = 114_000;
    vi.stubEnv("CLAWRMA_IDLE_FALLBACK_BUSY_THRESHOLD_MS", "15000");

    const statusClient = vi.fn<OpenClawGatewayStatusClient>(async () => {
      throw new Error("gateway unavailable");
    });
    const detector = requireIdleDetector({
      statusClient,
      nowMs: () => now,
    });

    detector.recordUserActivity(100_000);

    await expect(detector.isIdle()).resolves.toBe(false);

    now = 116_000;
    await expect(detector.isIdle()).resolves.toBe(true);
  });

  it("fetches idle status through the real gateway websocket client", async () => {
    const gateway = await startFakeOpenClawGateway({
      statusPayload: { tasks: { active: 0 } },
    });
    try {
      const detector = requireIdleDetector({
        gatewayUrl: gateway.url,
        statusTimeoutMs: 500,
      });

      await expect(detector.isIdle()).resolves.toBe(true);

      expect(
        gateway.frames.map((frame) => readString(frame, "method")),
      ).toEqual(["connect", "status"]);
      expect(solverLoggerMock.warn).not.toHaveBeenCalled();
    } finally {
      await gateway.close();
    }
  });

  it("passes gateway token through the real gateway websocket connect frame", async () => {
    const gateway = await startFakeOpenClawGateway({
      statusPayload: { tasks: { active: 1 } },
    });
    try {
      const detector = requireIdleDetector({
        gatewayUrl: gateway.url,
        gatewayToken: "oc_token",
        statusTimeoutMs: 500,
      });

      await expect(detector.isIdle()).resolves.toBe(false);

      const connectFrame = gateway.frames.find(
        (frame) => readString(frame, "method") === "connect",
      );
      const params = readRecord(connectFrame, "params");
      const auth = readRecord(params, "auth");
      expect(auth?.token).toBe("oc_token");
    } finally {
      await gateway.close();
    }
  });

  it("falls back when the real gateway websocket status RPC fails", async () => {
    const gateway = await startFakeOpenClawGateway({
      statusError: "status unavailable",
    });
    try {
      const detector = requireIdleDetector({
        gatewayUrl: gateway.url,
        statusTimeoutMs: 500,
        nowMs: () => 120_000,
        fallbackBusyThresholdMs: 30_000,
      });

      await expect(detector.isIdle()).resolves.toBe(true);

      expect(solverLoggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbackIdle: true,
          gatewayUrl: gateway.url,
        }),
        "solver_idle_gateway_unavailable_fallback_applied",
      );
    } finally {
      await gateway.close();
    }
  });
});

function requireIdleDetector(options: IdleDetectorOptions): IdleDetector {
  const detector = createIdleDetector("openclaw", options);
  expect(detector).not.toBeNull();
  if (!detector) {
    throw new Error("Expected OpenClaw idle detector.");
  }
  return detector;
}

interface FakeOpenClawGatewayOptions {
  statusPayload?: unknown;
  statusError?: string;
}

interface FakeOpenClawGateway {
  frames: Array<Record<string, unknown>>;
  url: string;
  close(): Promise<void>;
}

async function startFakeOpenClawGateway(
  options: FakeOpenClawGatewayOptions,
): Promise<FakeOpenClawGateway> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Array<Record<string, unknown>> = [];

  server.on("connection", (socket: WebSocket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "fake-nonce", ts: 120_000 },
      }),
    );

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString("utf8")) as unknown;
      if (!isRecord(frame)) {
        return;
      }
      frames.push(frame);

      const id = readString(frame, "id");
      const method = readString(frame, "method");
      if (!id || !method) {
        return;
      }

      if (method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id,
            ok: true,
            payload: { type: "hello-ok" },
          }),
        );
        return;
      }

      if (method === "status" && options.statusError) {
        socket.send(
          JSON.stringify({
            type: "res",
            id,
            ok: false,
            error: { message: options.statusError },
          }),
        );
        return;
      }

      if (method === "status") {
        socket.send(
          JSON.stringify({
            type: "res",
            id,
            ok: true,
            payload: options.statusPayload ?? { tasks: { active: 0 } },
          }),
        );
      }
    });
  });

  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake OpenClaw Gateway did not expose a TCP address.");
  }

  return {
    frames,
    url: `ws://127.0.0.1:${(address as AddressInfo).port}`,
    close: async () => {
      for (const client of server.clients) {
        client.close();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function readRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const child = value[key];
  return isRecord(child) ? child : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const child = value[key];
  return typeof child === "string" ? child : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
