import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OpenClawConfig } from "../integrations/openclaw.js";

const readOpenClawConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../integrations/openclaw.js", () => ({
  readOpenClawConfig: readOpenClawConfigMock,
}));

import {
  fulfillViaApi,
  fulfillViaClaudeCli,
  fulfillViaCodexCli,
  resolveProviderRuntimeConfig,
  type InferenceChunk,
} from "./inference.js";

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

function makeHangingProcess(): ChildProcessWithoutNullStreams {
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

  return process;
}

function makeAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function makeOpenClawConfig(
  providers: OpenClawConfig["providers"],
): OpenClawConfig {
  return {
    path: "/tmp/openclaw.json",
    raw: {},
    providers,
    activeHours: null,
    activeHoursTimezone: null,
    existingSearchConfig: false,
    existingFirecrawlConfig: false,
  };
}

beforeEach(() => {
  readOpenClawConfigMock.mockReset();
  readOpenClawConfigMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("solver inference executors", () => {
  it("parses OpenAI-compatible API streams into chunks and usage", async () => {
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
    const chunks: InferenceChunk[] = [];

    const result = await fulfillViaApi({
      payload: {
        messages: [{ role: "user", content: "Say hello" }],
        temperature: 0.2,
      },
      providerName: "openrouter",
      modelName: "openai/gpt-4o-mini",
      framework: "none",
      providerResolver: async () => ({
        endpoint: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
      }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      fetchTimeoutMs: 1_000,
      maxSpendPerRequest: 0.5,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([{ content: "hello" }]);
    expect(result).toEqual({
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cached_input_tokens: 20,
      },
    });

    const firstCall = fetchMock.mock.calls.at(0) as unknown[] | undefined;
    if (!firstCall) {
      throw new Error("API executor fetch mock was not called.");
    }
    expect(firstCall[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(firstCall[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer sk-or-test",
      }),
    });

    const init = firstCall[1] as Record<string, unknown>;
    const body = JSON.parse(String(init.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(body.metadata).toEqual({ clawrma_max_spend_points: 0.5 });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("rejects API execution after runtime-boundary validation when messages or provider config are invalid", async () => {
    await expect(
      fulfillViaApi({
        payload: {},
        providerName: "openrouter",
        modelName: "openai/gpt-4o-mini",
        framework: "none",
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        fetchImpl: fetch,
        fetchTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("Task payload is missing a non-empty messages list.");

    await expect(
      fulfillViaApi({
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        providerName: "openrouter",
        modelName: "openai/gpt-4o-mini",
        framework: "none",
        providerResolver: async () => null,
        fetchImpl: fetch,
        fetchTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow(
      "API fulfillment missing provider endpoint for 'openrouter'.",
    );
  });

  it("wraps API timeouts with the current fulfillment wording", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(makeAbortError());
          });
        }),
    );

    await expect(
      fulfillViaApi({
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        providerName: "openrouter",
        modelName: "openai/gpt-4o-mini",
        framework: "none",
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        fetchImpl: fetchMock as unknown as typeof fetch,
        fetchTimeoutMs: 5,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("API fulfillment failed: This operation was aborted");
  });

  it("parses Claude CLI fallback results and usage", async () => {
    const chunks: InferenceChunk[] = [];

    const result = await fulfillViaClaudeCli({
      payload: {
        messages: [{ role: "user", content: "Say hello" }],
      },
      modelName: "claude-opus-4-6",
      spawnImpl: vi.fn(() =>
        makeMockProcess([
          '{"type":"result","result":"hello from claude","usage":{"input_tokens":2200,"output_tokens":440,"cached_input_tokens":33}}',
        ]),
      ),
      cliTimeoutMs: 1_000,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      {
        content: "hello from claude",
        finish_reason: "stop",
      },
    ]);
    expect(result).toEqual({
      usage: {
        input_tokens: 2200,
        output_tokens: 440,
        cached_input_tokens: 33,
      },
    });
  });

  it("rejects Claude CLI execution when no user message or assistant output is available", async () => {
    await expect(
      fulfillViaClaudeCli({
        payload: {
          messages: [{ role: "system", content: "Only system" }],
        },
        modelName: "claude-opus-4-6",
        spawnImpl: vi.fn(() => makeMockProcess([])),
        cliTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("Task payload did not include a user message.");

    await expect(
      fulfillViaClaudeCli({
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        modelName: "claude-opus-4-6",
        spawnImpl: vi.fn(() =>
          makeMockProcess([
            '{"type":"result","usage":{"input_tokens":2200,"output_tokens":440}}',
          ]),
        ),
        cliTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("Claude CLI produced no assistant output.");
  });

  it("wraps Claude CLI timeouts with the current fulfillment wording", async () => {
    const process = makeHangingProcess();

    await expect(
      fulfillViaClaudeCli({
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        modelName: "claude-opus-4-6",
        spawnImpl: vi.fn(() => process),
        cliTimeoutMs: 5,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("CLI fulfillment failed: Process timed out after 5ms.");

    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("parses Codex CLI JSON streams and usage", async () => {
    let stdinText = "";

    const result = await fulfillViaCodexCli({
      payload: {
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Say hello" },
        ],
      },
      modelName: "gpt-5.3-codex",
      spawnImpl: vi.fn(() => {
        const process = makeMockProcess([
          '{"type":"thread.started","thread_id":"thread_1"}',
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello from codex"}}',
          '{"type":"turn.completed","usage":{"input_tokens":3000,"cached_input_tokens":120,"output_tokens":700}}',
        ]);
        process.stdin.on("data", (chunk: Buffer | string) => {
          stdinText += chunk.toString();
        });
        return process;
      }),
      cliTimeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(result).toEqual({
      usage: {
        input_tokens: 3000,
        output_tokens: 700,
        cached_input_tokens: 120,
      },
    });
    expect(stdinText).toBe(
      "System instructions:\nBe concise\n\nUser request:\nSay hello",
    );
  });

  it("rejects Codex CLI when the stream produces no assistant output", async () => {
    await expect(
      fulfillViaCodexCli({
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        modelName: "gpt-5.3-codex",
        spawnImpl: vi.fn(() =>
          makeMockProcess([
            '{"type":"turn.completed","usage":{"input_tokens":3000,"output_tokens":700}}',
          ]),
        ),
        cliTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("Codex CLI produced no assistant output.");
  });
});

describe("solver inference provider resolution", () => {
  it("resolves local provider config from CLAWRMA env overrides", async () => {
    vi.stubEnv("CLAWRMA_PROVIDER_BASE_URL", "https://localhost:11434/v1");
    vi.stubEnv("CLAWRMA_PROVIDER_API_KEY", "local-test-key");

    await expect(
      resolveProviderRuntimeConfig("openrouter", "none"),
    ).resolves.toEqual({
      endpoint: "https://localhost:11434/v1",
      apiKey: "local-test-key",
    });
  });

  it("falls back to standard provider API-key env vars for OpenClaw providers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    readOpenClawConfigMock.mockResolvedValue(
      makeOpenClawConfig([
        {
          name: "anthropic",
          endpoint: "https://api.anthropic.com",
          apiKey: "",
          token: "",
          modelName: "claude-opus-4-6",
        },
      ]),
    );

    await expect(
      resolveProviderRuntimeConfig("anthropic", "openclaw"),
    ).resolves.toEqual({
      endpoint: "https://api.anthropic.com",
      apiKey: "anthropic-test-key",
    });
  });
});
