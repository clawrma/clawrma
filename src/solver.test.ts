import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawrmaConfig,
  DetectionResult,
  SolverCapability,
  SolverSchedule,
} from "./types.js";
import type {
  ConnectionChangeHandler,
  MessageHandler,
  WebSocketManager,
} from "./ws.js";
import type { WebSearchFulfiller } from "./fulfillments/web-search.js";

const solverLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./logging.js", () => ({
  solverLogger: solverLoggerMock,
}));

import {
  registerCapabilitiesHttpFallback,
  startSolver,
  type IdleDetector,
  type SolverRuntimeDependencies,
} from "./solver.js";

function makeMockProcess(
  lines: string[],
  exitCode = 0,
  stderrText = "",
): ChildProcessWithoutNullStreams {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: vi.fn(),
  });

  setTimeout(() => {
    for (const line of lines) {
      stdout.write(`${line}\n`);
    }
    stdout.end();
    stderr.end(stderrText);
    (process as unknown as { exitCode: number | null }).exitCode = exitCode;
    process.emit("close", exitCode);
  }, 0);

  return process;
}

class FakeWebSocketManager implements WebSocketManager {
  public sent: object[] = [];
  private connected = true;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly connectionHandlers = new Set<ConnectionChangeHandler>();

  public send(message: object): void {
    this.sent.push(message);
  }

  public close(): void {
    this.connected = false;
    this.emitConnection(false);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onConnectionChange(handler: ConnectionChangeHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  public setIdleStateProvider(_provider: () => boolean): void {
    // B.2 coverage does not use idle state provider.
  }

  public emitMessage(message: Record<string, unknown>): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  public setConnected(connected: boolean): void {
    this.connected = connected;
    this.emitConnection(connected);
  }

  private emitConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }
}

function makeConfig(schedule: SolverSchedule): ClawrmaConfig {
  return {
    version: 1,
    accountId: "cr_usr_test",
    apiKey: "cr_sk_test",
    apiBaseUrl: "http://127.0.0.1:8000",
    framework: "none",
    solver: {
      enabled: true,
      schedule,
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
    installedAt: "2026-02-25T00:00:00.000Z",
  };
}

function makeDetectionResult(
  providers: DetectionResult["providers"] = [],
  options: {
    browserAvailable?: boolean;
  } = {},
): DetectionResult {
  return {
    providers,
    browserAvailable: options.browserAvailable ?? false,
    notificationChannels: [],
    activeHours: null,
    existingSearchConfig: false,
    existingFirecrawlConfig: false,
    existingClawrmaSearchConfig: false,
    selectedSearchProvider: null,
  };
}

class ThrowingSubscribeWebSocketManager extends FakeWebSocketManager {
  public override send(message: object): void {
    if ((message as { type?: string }).type === "subscribe") {
      throw new Error("subscribe not supported");
    }
    super.send(message);
  }
}

function overnightSchedule(): SolverSchedule {
  return {
    preset: "overnight",
    source: "manual",
    timezone: "UTC",
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "00:00",
        end: "06:00",
      },
    ],
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for predicate after ${timeoutMs}ms.`);
}

function getMessagesByType(
  messages: object[],
  type: string,
): Record<string, unknown>[] {
  return messages.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).type === type,
  );
}

function makeAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function makeWebSearchCapability(
  providerName: string,
  modelName: string,
): SolverCapability {
  return {
    task_type: "web_search",
    billing_type: "local",
    fulfillment_path: "api",
    provider_name: providerName,
    model_name: modelName,
  };
}

function makeTestWebSearchFulfiller(
  capability: SolverCapability,
  title: string,
): WebSearchFulfiller {
  return {
    detect: () => capability,
    fulfill: async (payload) => {
      const payloadRecord = payload as { query?: unknown } | null;
      const query =
        typeof payloadRecord?.query === "string"
          ? payloadRecord.query.trim()
          : "";

      return {
        query,
        results: [
          {
            title,
            url: `https://example.com/${title.toLowerCase().replace(/\s+/g, "-")}`,
            snippet: `${title} result`,
          },
        ],
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("solver runtime dispatch", () => {
  it("completes proxy_fetch task assignments", async () => {
    const fakeWs = new FakeWebSocketManager();
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>ok</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_proxy_1",
        task_type: "proxy_fetch",
        payload: {
          url: "https://example.com",
        },
      });

      await waitFor(
        () => getMessagesByType(fakeWs.sent, "task_complete").length >= 1,
      );
      const completion = getMessagesByType(fakeWs.sent, "task_complete").find(
        (entry) => entry.task_id === "task_proxy_1",
      );
      expect(completion).toBeDefined();
      expect(completion?.result).toMatchObject({
        url: "https://example.com",
        status_code: 200,
        headers: { "content-type": "text/html" },
        body: "<html>ok</html>",
        content_format: "html",
        original_content_type: "text/html",
      });
    } finally {
      await handle.stop();
    }
  });

  it("accepts raw_html on local proxy_fetch assignments without changing the raw HTML result", async () => {
    const fakeWs = new FakeWebSocketManager();
    const fetchMock = vi.fn(
      async () =>
        new Response("<html><body>raw-html</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_proxy_raw_html",
        task_type: "proxy_fetch",
        payload: {
          url: "https://example.com/raw",
          raw_html: true,
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_proxy_raw_html",
        ),
      );

      const completion = getMessagesByType(fakeWs.sent, "task_complete").find(
        (entry) => entry.task_id === "task_proxy_raw_html",
      );
      expect(completion?.result).toMatchObject({
        url: "https://example.com/raw",
        status_code: 200,
        body: "<html><body>raw-html</body></html>",
        content_format: "html",
        original_content_type: "text/html; charset=utf-8",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await handle.stop();
    }
  });

  it("dispatches llm_inference through the runtime api wrapper", async () => {
    const fakeWs = new FakeWebSocketManager();
    const streamedBody = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":340,"prompt_tokens_details":{"cached_tokens":20}}}',
      "data: [DONE]",
    ].join("\n");
    const fetchMock = vi.fn(
      async () =>
        new Response(streamedBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_api_1",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "api",
          provider_name: "openrouter",
          model_name: "openai/gpt-4o-mini",
        },
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_api_1",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_chunk").find(
          (entry) => entry.task_id === "task_api_1",
        )?.chunk,
      ).toMatchObject({ type: "text_delta", text: "hello" });
      expect(
        getMessagesByType(fakeWs.sent, "task_complete").find(
          (entry) => entry.task_id === "task_api_1",
        ),
      ).toEqual({
        type: "task_complete",
        task_id: "task_api_1",
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cached_input_tokens: 20,
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop();
    }
  });

  it("forwards structured tool-call chunks and terminal assistant state for llm_inference", async () => {
    const fakeWs = new FakeWebSocketManager();
    const streamedBody = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"exec","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}',
      'data: {"object":"chat.completion.chunk","choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_123","type":"function","function":{"name":"exec","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}',
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":340}}',
      "data: [DONE]",
    ].join("\n");
    const fetchMock = vi.fn(
      async () =>
        new Response(streamedBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_api_tool_call",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "api",
          provider_name: "openrouter",
          model_name: "openai/gpt-4o-mini",
        },
        payload: {
          messages: [{ role: "user", content: "Run ls" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_api_tool_call",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_chunk").find(
          (entry) => entry.task_id === "task_api_tool_call",
        )?.chunk,
      ).toEqual({
        type: "tool_call_delta",
        tool_call: {
          index: 0,
          id: "call_123",
          type: "function",
          function: {
            name: "exec",
            arguments: '{"cmd":"ls"}',
          },
        },
      });
      expect(
        getMessagesByType(fakeWs.sent, "task_complete").find(
          (entry) => entry.task_id === "task_api_tool_call",
        ),
      ).toEqual({
        type: "task_complete",
        task_id: "task_api_tool_call",
        result: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "exec",
                arguments: '{"cmd":"ls"}',
              },
            },
          ],
        },
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
        },
      });
    } finally {
      await handle.stop();
    }
  });

  it("forwards structured CLI-originated tool-call chunks and terminal assistant state for llm_inference", async () => {
    const fakeWs = new FakeWebSocketManager();

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        spawnImpl: vi.fn(() =>
          makeMockProcess([
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Running"}}',
            '{"type":"item.completed","item":{"id":"call_123","type":"mcp_tool_call","server":"workspace","tool":"exec","arguments":{"cmd":"ls"}}}',
            '{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":340}}',
          ]),
        ),
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_cli_tool_call",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "cli_codex",
          provider_name: "openai-codex",
          model_name: "gpt-5.3-codex",
        },
        payload: {
          messages: [{ role: "user", content: "Run ls" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_cli_tool_call",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_chunk").filter(
          (entry) => entry.task_id === "task_cli_tool_call",
        ),
      ).toEqual([
        {
          type: "task_chunk",
          task_id: "task_cli_tool_call",
          chunk: {
            type: "text_delta",
            text: "Running",
          },
        },
        {
          type: "task_chunk",
          task_id: "task_cli_tool_call",
          chunk: {
            type: "tool_call_delta",
            tool_call: {
              index: 0,
              id: "call_123",
              type: "function",
              function: {
                name: "workspace.exec",
                arguments: '{"cmd":"ls"}',
              },
            },
          },
        },
      ]);
      expect(
        getMessagesByType(fakeWs.sent, "task_complete").find(
          (entry) => entry.task_id === "task_cli_tool_call",
        ),
      ).toEqual({
        type: "task_complete",
        task_id: "task_cli_tool_call",
        result: {
          role: "assistant",
          content: "Running",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "workspace.exec",
                arguments: '{"cmd":"ls"}',
              },
            },
          ],
        },
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
        },
      });
    } finally {
      await handle.stop();
    }
  });

  it("uses the configured dedicated workspace root for CLI-backed llm_inference tasks", async () => {
    const fakeWs = new FakeWebSocketManager();
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "clawrma-solver-runtime-workspaces-"),
    );
    let spawnedCwd = "";

    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.cliSandbox = {
      workspaceRoot,
    };

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      spawnImpl: vi.fn((_command, _args, spawnOptions) => {
        spawnedCwd = String(spawnOptions.cwd ?? "");
        return makeMockProcess([
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
          '{"type":"turn.completed","usage":{"input_tokens":14,"output_tokens":2}}',
        ]);
      }),
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_cli_workspace_runtime",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "cli_codex",
          provider_name: "openai-codex",
          model_name: "gpt-5.3-codex",
        },
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_cli_workspace_runtime",
        ),
      );

      expect(spawnedCwd).toContain(
        join(workspaceRoot, "codex", "task_cli_workspace_runtime-"),
      );
      await expect(stat(spawnedCwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await handle.stop();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reports task_error when llm_inference payload is not an object", async () => {
    const fakeWs = new FakeWebSocketManager();

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_invalid_payload",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "api",
          provider_name: "openrouter",
          model_name: "openai/gpt-4o-mini",
        },
        payload: "not-an-object",
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_invalid_payload",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_invalid_payload",
        )?.error,
      ).toBe("llm_inference payload must be an object.");
    } finally {
      await handle.stop();
    }
  });

  it("falls back to payload.model when assignment model metadata is absent", async () => {
    const fakeWs = new FakeWebSocketManager();
    const streamedBody = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
      "data: [DONE]",
    ].join("\n");
    const fetchMock = vi.fn(
      async () =>
        new Response(streamedBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_payload_model_fallback",
        task_type: "llm_inference",
        capability: {
          provider_name: "openrouter",
        },
        payload: {
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Say hello" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_payload_model_fallback",
        ),
      );

      const firstCall = fetchMock.mock.calls.at(0) as unknown[] | undefined;
      if (!firstCall) {
        throw new Error("Fallback model fetch call was not captured.");
      }
      const init = firstCall[1] as Record<string, unknown> | undefined;
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      expect(requestBody.model).toBe("openai/gpt-4o-mini");
    } finally {
      await handle.stop();
    }
  });

  it("reports task_error when assignment metadata leaves api provider resolution unknown", async () => {
    const fakeWs = new FakeWebSocketManager();

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        providerResolver: async () => null,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_missing_provider_metadata",
        task_type: "llm_inference",
        capability: {
          model_name: "openai/gpt-4o-mini",
        },
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_missing_provider_metadata",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_missing_provider_metadata",
        )?.error,
      ).toBe("API fulfillment missing provider endpoint for 'unknown'.");
    } finally {
      await handle.stop();
    }
  });

  it("reports task_error when llm_inference assignment is missing model_name", async () => {
    const fakeWs = new FakeWebSocketManager();

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_missing_model",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "api",
          provider_name: "openrouter",
        },
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_missing_model",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_missing_model",
        )?.error,
      ).toBe("llm_inference assignment missing model_name.");
    } finally {
      await handle.stop();
    }
  });

  it("reports task_error when api fulfillment stream has no usage metadata", async () => {
    const fakeWs = new FakeWebSocketManager();
    const streamedBody = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
      "data: [DONE]",
    ].join("\n");
    const fetchMock = vi.fn(
      async () =>
        new Response(streamedBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_api_missing_usage",
        task_type: "llm_inference",
        capability: {
          fulfillment_path: "api",
          provider_name: "openrouter",
          model_name: "openai/gpt-4o-mini",
        },
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_api_missing_usage",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_api_missing_usage",
        )?.error,
      ).toBe("Provider stream ended without usage metadata.");
      expect(
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_api_missing_usage",
        ),
      ).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("logs invalid task assignments without dumping full payloads", async () => {
    const fakeWs = new FakeWebSocketManager();

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "",
        task_type: "llm_inference",
        payload: {
          apiKey: "cr_sk_secret",
        },
      });

      await waitFor(() => solverLoggerMock.warn.mock.calls.length >= 1);

      expect(solverLoggerMock.warn).toHaveBeenCalledWith(
        {
          taskIdPresent: false,
          taskIdType: "string",
          taskType: "llm_inference",
          hasPayload: true,
          hasCapability: false,
        },
        "solver_invalid_task_assignment",
      );

      const logPayload = solverLoggerMock.warn.mock.calls[0]?.[0];
      expect(logPayload).not.toHaveProperty("message");
      expect(JSON.stringify(logPayload)).not.toContain("cr_sk_secret");
    } finally {
      await handle.stop();
    }
  });

  it("declines assignments when idle detector reports busy (soft gate)", async () => {
    const fakeWs = new FakeWebSocketManager();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const idleDetector: IdleDetector = {
      isIdle: vi.fn(async () => false),
      recordUserActivity: vi.fn(),
    };

    const handle = await startSolver(
      makeConfig({
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      }),
      {
        wsFactory: () => fakeWs,
        fetchImpl: fetchMock,
        idleDetector,
        now: () => new Date("2026-02-23T12:00:00.000Z"),
      },
    );

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_busy_1",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com" },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_busy_1",
        ),
      );

      const taskError = getMessagesByType(fakeWs.sent, "task_error").find(
        (entry) => entry.task_id === "task_busy_1",
      );
      expect(taskError?.error).toContain("busy");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
    }
  });

  it("sends earnings and low-balance notifications after task completion", async () => {
    const fakeWs = new FakeWebSocketManager();
    const notificationMessages: string[] = [];
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const statusProvider = vi
      .fn()
      .mockResolvedValueOnce({
        balance: 120,
        solverState: {
          activeTasks: 0,
          tasksSolvedToday: 1,
          tasksSolvedTotal: 1,
          earningsToday: 2,
          earningsTotal: 2,
          paused: false,
          connected: true,
        },
        recentActivity: {
          tasksSolvedToday: 1,
          earningsToday: 2,
        },
        uptimeSeconds: 120,
        capabilities: [],
      })
      .mockResolvedValueOnce({
        balance: 40,
        solverState: {
          activeTasks: 0,
          tasksSolvedToday: 2,
          tasksSolvedTotal: 2,
          earningsToday: 6,
          earningsTotal: 6,
          paused: false,
          connected: true,
        },
        recentActivity: {
          tasksSolvedToday: 2,
          earningsToday: 6,
        },
        uptimeSeconds: 240,
        capabilities: [],
      });

    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.framework = "openclaw";
    config.notifications.channel = "telegram";
    config.notifications.target = "@chat";
    config.notifications.earningsThreshold = 5;

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      fetchImpl: fetchMock,
      statusProvider,
      notificationSender: async (_cfg, message) => {
        notificationMessages.push(message);
      },
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_notify_1",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/1" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_notify_1",
        ),
      );

      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_notify_2",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/2" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_notify_2",
        ),
      );

      await waitFor(() => notificationMessages.length >= 2);
      expect(notificationMessages).toContain(
        "Earned 6.00 points from 2 tasks. Balance: 40.00 points.",
      );
      expect(notificationMessages).toContain(
        "Balance below 50.00 points - solver may stop accepting inference tasks.",
      );
    } finally {
      await handle.stop();
    }
  });

  it("sends daily summary on day rollover while keeping below-threshold earnings batched", async () => {
    const fakeWs = new FakeWebSocketManager();
    const notificationMessages: string[] = [];
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    let now = new Date("2026-02-23T23:55:00.000Z");

    const statusProvider = vi
      .fn()
      .mockResolvedValueOnce({
        balance: 150,
        solverState: {
          activeTasks: 0,
          tasksSolvedToday: 5,
          tasksSolvedTotal: 5,
          earningsToday: 0.02,
          earningsTotal: 0.02,
          paused: false,
          connected: true,
        },
        recentActivity: {
          tasksSolvedToday: 5,
          earningsToday: 0.02,
        },
        uptimeSeconds: 120,
        capabilities: [],
      })
      .mockResolvedValueOnce({
        balance: 150,
        solverState: {
          activeTasks: 0,
          tasksSolvedToday: 1,
          tasksSolvedTotal: 6,
          earningsToday: 0.03,
          earningsTotal: 0.05,
          paused: false,
          connected: true,
        },
        recentActivity: {
          tasksSolvedToday: 1,
          earningsToday: 0.03,
        },
        uptimeSeconds: 180,
        capabilities: [],
      });

    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.framework = "openclaw";
    config.notifications.channel = "telegram";
    config.notifications.target = "@chat";
    config.notifications.earningsThreshold = 1.0;
    config.notifications.dailySummary = true;

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      fetchImpl: fetchMock,
      statusProvider,
      notificationSender: async (_cfg, message) => {
        notificationMessages.push(message);
      },
      now: () => now,
    });

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_summary_1",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/summary-1" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_summary_1",
        ),
      );

      now = new Date("2026-02-24T00:05:00.000Z");
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_summary_2",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/summary-2" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_summary_2",
        ),
      );

      await waitFor(() => notificationMessages.length >= 1);
      expect(notificationMessages[0]).toContain(
        "Today: 5 tasks, 0.02 points earned,",
      );
      expect(
        notificationMessages.some((message) => message.startsWith("Earned ")),
      ).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("rate-limits solver error notifications to one per minute", async () => {
    const fakeWs = new FakeWebSocketManager();
    const notificationMessages: string[] = [];
    let now = new Date("2026-02-23T12:00:00.000Z");
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });

    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.framework = "openclaw";
    config.notifications.channel = "telegram";
    config.notifications.target = "@chat";

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      fetchImpl: fetchMock,
      notificationSender: async (_cfg, message) => {
        notificationMessages.push(message);
      },
      now: () => now,
    });

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_error_1",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/one" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_error_1",
        ),
      );

      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_error_2",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/two" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_error_2",
        ),
      );
      await sleep(20);
      expect(notificationMessages.length).toBe(1);

      now = new Date("2026-02-23T12:01:05.000Z");
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_error_3",
        task_type: "proxy_fetch",
        payload: { url: "https://example.com/three" },
      });
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_error_3",
        ),
      );
      await waitFor(() => notificationMessages.length === 2);
      expect(notificationMessages[0]).toContain("Solver error:");
      expect(notificationMessages[1]).toContain("Solver error:");
    } finally {
      await handle.stop();
    }
  });

  it("fails unmatched browser assignments explicitly when no browser fulfillers are advertised", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["screenshot", "page_snapshot"];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      detectCapabilitiesImpl: async () => makeDetectionResult(),
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_screenshot_1",
        task_type: "screenshot",
        capability: {
          task_type: "screenshot",
          fulfillment_path: "api",
          provider_name: "clawrma-browser",
          model_name: "screenshot-v1",
        },
        payload: { url: "https://example.com" },
      });
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_snapshot_1",
        task_type: "page_snapshot",
        capability: {
          task_type: "page_snapshot",
          fulfillment_path: "api",
          provider_name: "clawrma-browser",
          model_name: "page-snapshot-v1",
        },
        payload: { url: "https://example.com" },
      });

      await waitFor(() => {
        const errors = getMessagesByType(fakeWs.sent, "task_error");
        return (
          errors.some((entry) => entry.task_id === "task_screenshot_1") &&
          errors.some((entry) => entry.task_id === "task_snapshot_1")
        );
      });

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_screenshot_1",
        ),
      ).toMatchObject({
        error:
          "Assigned capability 'clawrma-browser/screenshot-v1/api' for task type 'screenshot' is not available in the local solver runtime.",
      });
      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_snapshot_1",
        ),
      ).toMatchObject({
        error:
          "Assigned capability 'clawrma-browser/page-snapshot-v1/api' for task type 'page_snapshot' is not available in the local solver runtime.",
      });
    } finally {
      await handle.stop();
    }
  });

  it("surfaces web_search timeout errors through the shared fetch timeout path", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");

    const fakeWs = new FakeWebSocketManager();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Missing abort signal."));
            return;
          }

          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(makeAbortError());
            },
            { once: true },
          );
        }),
    ) as typeof fetch;

    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["web_search"];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      fetchImpl: fetchMock,
      fetchTimeoutMs: 5,
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_search_timeout",
        task_type: "web_search",
        capability: {
          task_type: "web_search",
          fulfillment_path: "api",
          provider_name: "clawrma-search",
          model_name: "web-search",
        },
        payload: { query: "clawrma", count: 2 },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_search_timeout",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_search_timeout",
        ),
      ).toMatchObject({
        error: "web_search timed out after 5ms.",
        category: "timeout",
      });
    } finally {
      await handle.stop();
    }
  });

  it("dispatches web_search through the assigned capability when multiple fulfillers exist", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["web_search"];

    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const providerB = makeWebSearchCapability("provider-b", "search-b");
    const solverDependencies = {
      wsFactory: () => fakeWs,
      now: () => new Date("2026-02-23T12:00:00.000Z"),
      fulfillers: {
        web_search: [
          makeTestWebSearchFulfiller(providerA, "Provider A"),
          makeTestWebSearchFulfiller(providerB, "Provider B"),
        ],
      },
    };

    const handle = await startSolver(config, solverDependencies);

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_search_assigned_provider",
        task_type: "web_search",
        capability: {
          task_type: "web_search",
          fulfillment_path: "api",
          provider_name: "provider-b",
          model_name: "search-b",
        },
        payload: { query: "assigned dispatch" },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_search_assigned_provider",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_complete").find(
          (entry) => entry.task_id === "task_search_assigned_provider",
        ),
      ).toMatchObject({
        result: {
          query: "assigned dispatch",
          results: [
            {
              title: "Provider B",
            },
          ],
        },
      });
    } finally {
      await handle.stop();
    }
  });

  it("fails clearly when extensible assignment capability metadata is missing", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["web_search"];

    const solverDependencies = {
      wsFactory: () => fakeWs,
      now: () => new Date("2026-02-23T12:00:00.000Z"),
      fulfillers: {
        web_search: [
          makeTestWebSearchFulfiller(
            makeWebSearchCapability("provider-a", "search-a"),
            "Provider A",
          ),
        ],
      },
    };

    const handle = await startSolver(config, solverDependencies);

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_search_missing_capability",
        task_type: "web_search",
        payload: { query: "missing capability" },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_search_missing_capability",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_search_missing_capability",
        ),
      ).toMatchObject({
        error: "Task assignment missing capability.task_type for 'web_search'.",
      });
    } finally {
      await handle.stop();
    }
  });

  it("fails clearly when extensible assignment capability.task_type does not match", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["web_search"];

    const solverDependencies = {
      wsFactory: () => fakeWs,
      now: () => new Date("2026-02-23T12:00:00.000Z"),
      fulfillers: {
        web_search: [
          makeTestWebSearchFulfiller(
            makeWebSearchCapability("provider-a", "search-a"),
            "Provider A",
          ),
        ],
      },
    };

    const handle = await startSolver(config, solverDependencies);

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_search_mismatched_capability_task_type",
        task_type: "web_search",
        capability: {
          task_type: "screenshot",
          fulfillment_path: "api",
          provider_name: "provider-a",
          model_name: "search-a",
        },
        payload: { query: "mismatch" },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) =>
            entry.task_id === "task_search_mismatched_capability_task_type",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) =>
            entry.task_id === "task_search_mismatched_capability_task_type",
        ),
      ).toMatchObject({
        error:
          "Task assignment capability.task_type 'screenshot' does not match task_type 'web_search'.",
      });
    } finally {
      await handle.stop();
    }
  });

  it("fails clearly when the assigned capability was not advertised", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["web_search"];

    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const solverDependencies = {
      wsFactory: () => fakeWs,
      now: () => new Date("2026-02-23T12:00:00.000Z"),
      fulfillers: {
        web_search: [makeTestWebSearchFulfiller(providerA, "Provider A")],
      },
      resolvedCapabilities: [providerA],
    };

    const handle = await startSolver(config, solverDependencies);

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_search_unadvertised_assignment",
        task_type: "web_search",
        capability: {
          task_type: "web_search",
          fulfillment_path: "api",
          provider_name: "provider-b",
          model_name: "search-b",
        },
        payload: { query: "not advertised" },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_search_unadvertised_assignment",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_search_unadvertised_assignment",
        ),
      ).toMatchObject({
        error:
          "Assigned capability 'provider-b/search-b/api' for task type 'web_search' is not available in the local solver runtime.",
      });
      expect(
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_search_unadvertised_assignment",
        ),
      ).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("does not dispatch a local fulfiller that was not advertised", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig({
      preset: "idle-always",
      source: "manual",
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "00:00",
        },
      ],
    });
    config.solver.taskTypes = ["web_search"];

    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const providerB = makeWebSearchCapability("provider-b", "search-b");
    const solverDependencies = {
      wsFactory: () => fakeWs,
      now: () => new Date("2026-02-23T12:00:00.000Z"),
      fulfillers: {
        web_search: [
          makeTestWebSearchFulfiller(providerA, "Provider A"),
          makeTestWebSearchFulfiller(providerB, "Provider B"),
        ],
      },
      resolvedCapabilities: [providerA],
    };

    const handle = await startSolver(config, solverDependencies);

    try {
      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_search_local_but_hidden",
        task_type: "web_search",
        capability: {
          task_type: "web_search",
          fulfillment_path: "api",
          provider_name: "provider-b",
          model_name: "search-b",
        },
        payload: { query: "hidden fulfiller" },
      });

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_error").some(
          (entry) => entry.task_id === "task_search_local_but_hidden",
        ),
      );

      expect(
        getMessagesByType(fakeWs.sent, "task_error").find(
          (entry) => entry.task_id === "task_search_local_but_hidden",
        ),
      ).toMatchObject({
        error:
          "Assigned capability 'provider-b/search-b/api' for task type 'web_search' is not available in the local solver runtime.",
      });
      expect(
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_search_local_but_hidden",
        ),
      ).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("sends resume when entering schedule window and defers pause until in-flight task completes", async () => {
    const fakeWs = new FakeWebSocketManager();
    let currentTime = new Date("2026-02-23T14:00:00.000Z");

    let fetchStarted = false;
    let resolveDeferredFetch: ((response: Response) => void) | null = null;
    const deferredFetch = new Promise<Response>((resolve) => {
      resolveDeferredFetch = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://slow.example.com") {
        fetchStarted = true;
        return deferredFetch;
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const handle = await startSolver(makeConfig(overnightSchedule()), {
      wsFactory: () => fakeWs,
      fetchImpl: fetchMock,
      now: () => currentTime,
      scheduleEvalIntervalMs: 15,
    });

    try {
      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "pause").some(
          (entry) => entry.reason === "schedule",
        ),
      );

      currentTime = new Date("2026-02-23T00:05:00.000Z");
      await waitFor(() => getMessagesByType(fakeWs.sent, "resume").length >= 1);

      fakeWs.emitMessage({
        type: "task_assignment",
        task_id: "task_slow_1",
        task_type: "proxy_fetch",
        payload: {
          url: "https://slow.example.com",
        },
      });

      await waitFor(() => fetchStarted);

      currentTime = new Date("2026-02-23T07:30:00.000Z");
      await sleep(35);

      const pausesBeforeComplete = getMessagesByType(
        fakeWs.sent,
        "pause",
      ).filter((entry) => entry.reason === "schedule");
      expect(pausesBeforeComplete.length).toBe(1);

      const resolver = resolveDeferredFetch as
        | ((response: Response) => void)
        | null;
      if (!resolver) {
        throw new Error("Deferred fetch resolver was not initialized.");
      }
      resolver(new Response("slow-ok", { status: 200 }));

      await waitFor(() =>
        getMessagesByType(fakeWs.sent, "task_complete").some(
          (entry) => entry.task_id === "task_slow_1",
        ),
      );

      await waitFor(() => {
        const pauses = getMessagesByType(fakeWs.sent, "pause").filter(
          (entry) => entry.reason === "schedule",
        );
        return pauses.length >= 2;
      });
    } finally {
      await handle.stop();
    }
  });
});

describe("solver capability registration", () => {
  it("keeps raw extensible capability injection off the public runtime dependency surface", () => {
    type HasCapabilities =
      "capabilities" extends keyof SolverRuntimeDependencies ? true : false;
    type HasFulfillers = "fulfillers" extends keyof SolverRuntimeDependencies
      ? true
      : false;

    const hasCapabilities: HasCapabilities = false;
    const hasFulfillers: HasFulfillers = false;

    expect(hasCapabilities).toBe(false);
    expect(hasFulfillers).toBe(false);
  });

  it("sends subscribe capabilities on start and on reconnect", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig(overnightSchedule());
    config.solver.taskTypes = ["llm_inference"];
    const expectedCapabilities = [
      {
        task_type: "llm_inference" as const,
        billing_type: "subscription" as const,
        fulfillment_path: "cli_codex" as const,
        provider_name: "openai-codex",
        model_name: "gpt-5.3-codex",
      },
    ];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      detectCapabilitiesImpl: async () =>
        makeDetectionResult([
          {
            name: "openai-codex",
            modelName: "gpt-5.3-codex",
            endpoint: "https://api.openai.com/v1",
            billingType: "subscription",
            fulfillmentPath: "cli_codex",
          },
        ]),
      now: () => new Date("2026-02-23T00:05:00.000Z"),
    });

    try {
      await waitFor(
        () => getMessagesByType(fakeWs.sent, "subscribe").length >= 1,
      );
      expect(getMessagesByType(fakeWs.sent, "subscribe")[0]).toEqual({
        type: "subscribe",
        capabilities: expectedCapabilities,
        domain_policy: "allowlist",
      });

      fakeWs.setConnected(false);
      fakeWs.setConnected(true);

      await waitFor(
        () => getMessagesByType(fakeWs.sent, "subscribe").length >= 2,
      );
    } finally {
      await handle.stop();
    }
  });

  it("uses HTTP fallback registration when subscribe send fails", async () => {
    const fakeWs = new ThrowingSubscribeWebSocketManager();
    const fallbackRegistrar = vi.fn(async () => undefined);
    const config = makeConfig(overnightSchedule());
    config.solver.taskTypes = ["llm_inference"];
    const expectedCapabilities = [
      {
        task_type: "llm_inference" as const,
        billing_type: "subscription" as const,
        fulfillment_path: "cli" as const,
        provider_name: "anthropic",
        model_name: "claude-opus-4-6",
      },
    ];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      capabilityFallbackRegistrar: fallbackRegistrar,
      detectCapabilitiesImpl: async () =>
        makeDetectionResult([
          {
            name: "anthropic",
            modelName: "claude-opus-4-6",
            endpoint: "https://api.anthropic.com",
            billingType: "subscription",
            fulfillmentPath: "cli",
          },
        ]),
      now: () => new Date("2026-02-23T00:05:00.000Z"),
    });

    try {
      await waitFor(() => fallbackRegistrar.mock.calls.length >= 1);
      const firstCall = fallbackRegistrar.mock.calls.at(0) as
        | unknown[]
        | undefined;
      if (!firstCall) {
        throw new Error("Fallback registrar was not invoked.");
      }
      const registeredConfig = firstCall[0];
      const registeredCapabilities = firstCall[1];
      expect(registeredConfig).toBeTruthy();
      expect(registeredCapabilities).toEqual(expectedCapabilities);
    } finally {
      await handle.stop();
    }
  });

  it("uses HTTP fallback registration when subscribe is rejected over websocket", async () => {
    const fakeWs = new FakeWebSocketManager();
    const fallbackRegistrar = vi.fn(async () => undefined);
    const config = makeConfig(overnightSchedule());
    config.solver.taskTypes = ["llm_inference"];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      capabilityFallbackRegistrar: fallbackRegistrar,
      detectCapabilitiesImpl: async () =>
        makeDetectionResult([
          {
            name: "openai-codex",
            modelName: "gpt-5.3-codex",
            endpoint: "https://api.openai.com/v1",
            billingType: "subscription",
            fulfillmentPath: "cli_codex",
          },
        ]),
      now: () => new Date("2026-02-23T00:05:00.000Z"),
    });

    try {
      await waitFor(
        () => getMessagesByType(fakeWs.sent, "subscribe").length >= 1,
      );
      fakeWs.emitMessage({ type: "error", error: "subscribe rejected" });
      await waitFor(() => fallbackRegistrar.mock.calls.length >= 1);
    } finally {
      await handle.stop();
    }
  });

  it("sends an authoritative empty subscribe payload when derived capabilities are empty", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig(overnightSchedule());
    config.solver.taskTypes = ["web_search"];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      now: () => new Date("2026-02-23T00:05:00.000Z"),
    });

    try {
      await waitFor(
        () => getMessagesByType(fakeWs.sent, "subscribe").length >= 1,
      );

      expect(getMessagesByType(fakeWs.sent, "subscribe")[0]).toEqual({
        type: "subscribe",
        capabilities: [],
        domain_policy: "allowlist",
      });
    } finally {
      await handle.stop();
    }
  });

  it("uses HTTP fallback registration with an authoritative empty capability snapshot", async () => {
    const fakeWs = new ThrowingSubscribeWebSocketManager();
    const fallbackRegistrar = vi.fn(async () => undefined);
    const config = makeConfig(overnightSchedule());
    config.solver.taskTypes = ["web_search"];

    const handle = await startSolver(config, {
      wsFactory: () => fakeWs,
      capabilityFallbackRegistrar: fallbackRegistrar,
      now: () => new Date("2026-02-23T00:05:00.000Z"),
    });

    try {
      await waitFor(() => fallbackRegistrar.mock.calls.length >= 1);
      const firstCall = fallbackRegistrar.mock.calls.at(0) as
        | unknown[]
        | undefined;
      if (!firstCall) {
        throw new Error("Fallback registrar was not invoked.");
      }
      expect(firstCall[1]).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it("registerCapabilitiesHttpFallback posts to solver capabilities endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ upserted: 1 }), { status: 200 }),
    );
    const config = makeConfig(overnightSchedule());
    const capabilities = [
      {
        task_type: "proxy_fetch" as const,
        billing_type: "local" as const,
        fulfillment_path: "api" as const,
        provider_name: "clawrma-browser",
        model_name: "proxy-fetch",
      },
    ];

    await registerCapabilitiesHttpFallback(
      config,
      capabilities,
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls.at(0) as unknown[] | undefined;
    if (!firstCall) {
      throw new Error("Fallback fetch mock was not called.");
    }
    const url = firstCall[0];
    const init = firstCall[1];
    expect(url).toBe("http://127.0.0.1:8000/v1/solver/capabilities");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer cr_sk_test",
        "x-api-key": "cr_sk_test",
      }),
    });
    const initRecord = init as Record<string, unknown>;
    const body = JSON.parse(String(initRecord.body ?? "[]")) as Array<
      Record<string, unknown>
    >;
    expect(body[0]?.tier).toBe("strong");
  });

  it("registerCapabilitiesHttpFallback posts authoritative empty snapshots", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ upserted: 0 }), { status: 200 }),
    );
    const config = makeConfig(overnightSchedule());

    await registerCapabilitiesHttpFallback(
      config,
      [],
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls.at(0) as unknown[] | undefined;
    if (!firstCall) {
      throw new Error("Fallback fetch mock was not called.");
    }
    const init = firstCall[1] as Record<string, unknown> | undefined;
    expect(JSON.parse(String(init?.body ?? "null"))).toEqual([]);
  });
});
