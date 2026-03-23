import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ClawrmaConfig, SolverCapability } from "./types.js";

const wsLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./logging.js", () => ({
  wsLogger: wsLoggerMock,
}));

import {
  buildSolverWebSocketUrl,
  computeReconnectDelayMs,
  createWebSocket,
  sendPause,
  sendResume,
  sendSubscribe,
} from "./ws.js";

function makeConfig(apiBaseUrl: string): ClawrmaConfig {
  return {
    version: 1,
    accountId: "cr_usr_test",
    apiKey: "cr_sk_test",
    apiBaseUrl,
    framework: "none",
    solver: {
      enabled: true,
      schedule: {
        preset: "overnight",
        source: "manual",
        timezone: "UTC",
        windows: [],
      },
      taskTypes: ["proxy_fetch"],
      excludedBillingTypes: [],
      domainPolicy: "allowlist",
    },
    webFetchFallback: {
      injected: false,
      method: "none",
    },
    notifications: {
      channel: "",
      target: "",
      earningsThreshold: 1,
      dailySummary: false,
    },
    welcomeCredit: 200,
    installedAt: new Date().toISOString(),
  };
}

async function startWebSocketServer(): Promise<{
  server: WebSocketServer;
  port: number;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("WebSocket server did not expose a TCP address.");
  }

  return {
    server,
    port: (address as AddressInfo).port,
  };
}

async function stopWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 2000,
  intervalMs: number = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

describe("ws manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds websocket URL from API base URL", () => {
    expect(buildSolverWebSocketUrl("https://api.clawrma.com")).toBe(
      "wss://api.clawrma.com/v1/solver/connect",
    );
    expect(buildSolverWebSocketUrl("http://localhost:8000")).toBe(
      "ws://localhost:8000/v1/solver/connect",
    );
  });

  it("calculates exponential reconnect backoff with a 30s cap", () => {
    const attempts = [0, 1, 2, 3, 4, 5, 6];
    const delays = attempts.map((attempt) => computeReconnectDelayMs(attempt));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("connects with Authorization header and sends subscribe/pause/resume payloads", async () => {
    const { server, port } = await startWebSocketServer();
    const received: Array<Record<string, unknown>> = [];
    let authorizationHeader = "";

    server.on("connection", (socket, request) => {
      authorizationHeader = String(request.headers.authorization ?? "");
      socket.on("message", (raw) => {
        received.push(
          JSON.parse(raw.toString("utf8")) as Record<string, unknown>,
        );
      });
    });

    const manager = createWebSocket(makeConfig(`http://127.0.0.1:${port}`), {
      heartbeatIntervalMs: 60_000,
    });

    try {
      await waitFor(() => manager.isConnected());

      const capabilities: SolverCapability[] = [
        {
          task_type: "web_search",
          billing_type: "local",
          fulfillment_path: "api",
          provider_name: "test-provider",
          model_name: "test-model",
        },
      ];

      sendSubscribe(manager, capabilities, "open");
      sendPause(manager, "schedule");
      sendResume(manager);

      await waitFor(() => received.length >= 3);

      expect(authorizationHeader).toBe("Bearer cr_sk_test");
      expect(received[0]).toEqual({
        type: "subscribe",
        capabilities,
        domain_policy: "open",
      });
      expect(received[1]).toEqual({
        type: "pause",
        reason: "schedule",
      });
      expect(received[2]).toEqual({
        type: "resume",
      });
    } finally {
      manager.close();
      await stopWebSocketServer(server);
    }
  });

  it("reconnects after server-side close using backoff delays", async () => {
    const { server, port } = await startWebSocketServer();
    const connectTimes: number[] = [];

    server.on("connection", (socket) => {
      connectTimes.push(Date.now());
      if (connectTimes.length === 1) {
        setTimeout(() => {
          socket.close(1011, "force-reconnect");
        }, 5);
      }
    });

    const manager = createWebSocket(makeConfig(`http://127.0.0.1:${port}`), {
      reconnectDelaysMs: [40],
      heartbeatIntervalMs: 60_000,
    });

    try {
      await waitFor(() => connectTimes.length >= 2);
      const firstConnectAt = connectTimes[0];
      const secondConnectAt = connectTimes[1];
      if (firstConnectAt === undefined || secondConnectAt === undefined) {
        throw new Error("Reconnect timestamps were not captured.");
      }
      expect(secondConnectAt - firstConnectAt).toBeGreaterThanOrEqual(25);
    } finally {
      manager.close();
      await stopWebSocketServer(server);
    }
  });

  it("responds to gateway ping messages with pong and idle state", async () => {
    const { server, port } = await startWebSocketServer();
    let pongMessage: Record<string, unknown> | null = null;

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        pongMessage = JSON.parse(raw.toString("utf8")) as Record<
          string,
          unknown
        >;
      });
      socket.send(JSON.stringify({ type: "ping" }));
    });

    const manager = createWebSocket(makeConfig(`http://127.0.0.1:${port}`), {
      heartbeatIntervalMs: 60_000,
    });
    manager.setIdleStateProvider(() => false);

    try {
      await waitFor(() => pongMessage !== null);
      expect(pongMessage).toEqual({
        type: "pong",
        is_idle: false,
      });
    } finally {
      manager.close();
      await stopWebSocketServer(server);
    }
  });

  it("logs invalid inbound websocket payloads without dumping raw contents", async () => {
    const { server, port } = await startWebSocketServer();

    server.on("connection", (socket) => {
      socket.send('{"apiKey":"cr_sk_secret"');
      socket.send(JSON.stringify(["cr_sk_secret"]));
    });

    const manager = createWebSocket(makeConfig(`http://127.0.0.1:${port}`), {
      heartbeatIntervalMs: 60_000,
    });

    try {
      await waitFor(() => wsLoggerMock.warn.mock.calls.length >= 2);

      expect(wsLoggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          byteLength: expect.any(Number),
        }),
        "ws_invalid_json_message",
      );
      expect(wsLoggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          byteLength: expect.any(Number),
          parsedType: "array",
        }),
        "ws_invalid_message_shape",
      );

      const logPayloads = wsLoggerMock.warn.mock.calls.map((call) => call[0]);
      for (const payload of logPayloads) {
        expect(payload).not.toHaveProperty("text");
        expect(payload).not.toHaveProperty("parsed");
      }
    } finally {
      manager.close();
      await stopWebSocketServer(server);
    }
  });
});
