import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  parseInferenceMessages,
  resolveProviderRuntimeConfig,
} from "./inference.js";
import {
  projectInferenceMessageContentText,
  type InferenceChunk,
} from "./contracts.js";

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

async function makeWorkspaceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clawrma-inference-workspaces-"));
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
        tools: [
          {
            type: "function",
            function: {
              name: "exec",
              parameters: { type: "object" },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "exec" },
        },
        parallel_tool_calls: false,
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

    expect(chunks).toEqual([{ type: "text_delta", text: "hello" }]);
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
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "exec" },
    });
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("preserves structured tool-call chunks and terminal assistant tool_calls", async () => {
    const streamedBody = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"exec","arguments":"{\\"cmd\\":\\"ls"}}]}}]}',
      'data: {"object":"chat.completion.chunk","choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_123","type":"function","function":{"name":"exec","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}',
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}',
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
        messages: [{ role: "user", content: "Run ls" }],
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
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      {
        type: "tool_call_delta",
        tool_call: {
          index: 0,
          id: "call_123",
          type: "function",
          function: {
            name: "exec",
            arguments: '{"cmd":"ls',
          },
        },
      },
    ]);
    expect(result).toEqual({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
      },
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
    });
  });

  it("rejects malformed structured tool-call chunks instead of dropping them", async () => {
    const streamedBody = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"id":"call_123","type":"function"}]}}]}',
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}',
      "data: [DONE]",
    ].join("\n");

    await expect(
      fulfillViaApi({
        payload: {
          messages: [{ role: "user", content: "Run ls" }],
        },
        providerName: "openrouter",
        modelName: "openai/gpt-4o-mini",
        framework: "none",
        providerResolver: async () => ({
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
        }),
        fetchImpl: vi.fn(
          async () =>
            new Response(streamedBody, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
        ) as unknown as typeof fetch,
        fetchTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow(
      "Provider emitted malformed delta.tool_calls[0]: missing non-negative index.",
    );
  });

  it("projects preserved OpenAI-compatible message content for CLI execution", () => {
    const messages = parseInferenceMessages([
      {
        role: "system",
        content: [
          { type: "text", text: " Follow the rules. " },
          { type: "input_text", input_text: "Stay concise." },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: " Say hello. " }],
      },
    ]);

    expect(messages).not.toBeNull();
    expect(messages?.[0]?.content).toEqual([
      { type: "text", text: "Follow the rules." },
      { type: "input_text", input_text: "Stay concise." },
    ]);
    const firstMessage = messages?.[0];
    expect(
      firstMessage
        ? projectInferenceMessageContentText(firstMessage.content)
        : null,
    ).toBe("Follow the rules.\nStay concise.");
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
      taskId: "task_claude_basic",
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
        type: "text_delta",
        text: "hello from claude",
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

  it("preserves full CLI conversation history for Claude execution", async () => {
    let stdinText = "";
    const spawnImpl = vi.fn((_command: string, args: string[]) => {
      const process = makeMockProcess([
        '{"type":"result","result":"ok","usage":{"input_tokens":12,"output_tokens":3}}',
      ]);
      process.stdin.on("data", (chunk: Buffer | string) => {
        stdinText += chunk.toString();
      });
      expect(args).toContain("--system-prompt");
      expect(args[args.indexOf("--system-prompt") + 1]).toBe(
        "Be concise.\n\nDeveloper instructions:\nUse bash output.",
      );
      return process;
    });

    await fulfillViaClaudeCli({
      taskId: "task_claude_history",
      payload: {
        messages: [
          { role: "system", content: "Be concise." },
          { role: "developer", content: "Use bash output." },
          { role: "user", content: "First request" },
          { role: "assistant", content: "Done" },
          { role: "user", content: "Second request" },
        ],
      },
      modelName: "claude-opus-4-6",
      spawnImpl,
      cliTimeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(stdinText).toBe(
      "Conversation history:\n\nUser:\nFirst request\n\nAssistant:\nDone\n\nUser:\nSecond request\n\nRespond to the latest user message using the full conversation above.",
    );
  });

  it("normalizes structured Claude CLI tool output into chunks and terminal assistant state", async () => {
    const chunks: InferenceChunk[] = [];

    const result = await fulfillViaClaudeCli({
      taskId: "task_claude_tools",
      payload: {
        messages: [{ role: "user", content: "Run ls" }],
      },
      modelName: "claude-opus-4-6",
      spawnImpl: vi.fn(() =>
        makeMockProcess([
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_123","name":"exec","input":{"cmd":"ls"}}]}}',
          '{"type":"result","result":{"content":[{"type":"tool_use","id":"call_123","name":"exec","input":{"cmd":"ls"}}]},"usage":{"input_tokens":2200,"output_tokens":440}}',
        ]),
      ),
      cliTimeoutMs: 1_000,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      {
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
      },
    ]);
    expect(result).toEqual({
      usage: {
        input_tokens: 2200,
        output_tokens: 440,
      },
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
    });
  });

  it("rejects malformed structured Claude CLI tool output loudly", async () => {
    await expect(
      fulfillViaClaudeCli({
        taskId: "task_claude_malformed_tool",
        payload: {
          messages: [{ role: "user", content: "Run ls" }],
        },
        modelName: "claude-opus-4-6",
        spawnImpl: vi.fn(() =>
          makeMockProcess([
            '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_123","input":{"cmd":"ls"}}]}}',
          ]),
        ),
        cliTimeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow(
      "CLI emitted malformed assistant.content[0]: missing tool name.",
    );
  });

  it("rejects Claude CLI execution when no user message or assistant output is available", async () => {
    await expect(
      fulfillViaClaudeCli({
        taskId: "task_claude_missing_user",
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
        taskId: "task_claude_no_output",
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
        taskId: "task_claude_timeout",
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

  it("runs Claude from a dedicated task workspace with a scrubbed child env", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    let spawnedCwd = "";
    let workspaceModePromise: Promise<number> | null = null;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("UNRELATED_SECRET", "do-not-pass");

    try {
      await fulfillViaClaudeCli({
        taskId: "task_claude_workspace",
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        modelName: "claude-opus-4-6",
        spawnImpl: vi.fn((_command, _args, spawnOptions) => {
          spawnedCwd = String(spawnOptions.cwd ?? "");
          workspaceModePromise = stat(spawnedCwd).then((stats) => stats.mode);
          capturedEnv = spawnOptions.env;
          return makeMockProcess([
            '{"type":"result","result":"ok","usage":{"input_tokens":12,"output_tokens":3}}',
          ]);
        }),
        cliTimeoutMs: 1_000,
        cliSandbox: {
          workspaceRoot,
        },
        onChunk: () => undefined,
      });

      expect(spawnedCwd).toContain(
        join(workspaceRoot, "claude", "task_claude_workspace-"),
      );
      if (!workspaceModePromise) {
        throw new Error("Claude workspace mode promise was not captured.");
      }
      const workspaceMode = await workspaceModePromise;
      expect(workspaceMode & 0o777).toBe(0o700);
      expect(capturedEnv?.ANTHROPIC_API_KEY).toBe("anthropic-test-key");
      expect(capturedEnv?.PWD).toBe(spawnedCwd);
      expect(capturedEnv).not.toHaveProperty("UNRELATED_SECRET");
      await expect(stat(spawnedCwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("cleans up failed Claude task workspaces by default", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    let spawnedCwd = "";

    try {
      await expect(
        fulfillViaClaudeCli({
          taskId: "task_claude_failed_workspace",
          payload: {
            messages: [{ role: "user", content: "Say hello" }],
          },
          modelName: "claude-opus-4-6",
          spawnImpl: vi.fn((_command, _args, spawnOptions) => {
            spawnedCwd = String(spawnOptions.cwd ?? "");
            return makeMockProcess([], 1, "claude exploded");
          }),
          cliTimeoutMs: 1_000,
          cliSandbox: {
            workspaceRoot,
          },
          onChunk: () => undefined,
        }),
      ).rejects.toThrow("claude exploded");

      await expect(stat(spawnedCwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("parses Codex CLI JSON streams and usage", async () => {
    let stdinText = "";

    const result = await fulfillViaCodexCli({
      taskId: "task_codex_basic",
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

  it("runs Codex from a dedicated task workspace with explicit sandbox flags and a scrubbed child env", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    let spawnedCwd = "";
    let capturedArgs: string[] = [];
    let workspaceModePromise: Promise<number> | null = null;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("UNRELATED_SECRET", "do-not-pass");

    try {
      await fulfillViaCodexCli({
        taskId: "task_codex_workspace",
        payload: {
          messages: [{ role: "user", content: "Say hello" }],
        },
        modelName: "gpt-5.3-codex",
        spawnImpl: vi.fn((_command, args, spawnOptions) => {
          capturedArgs = args;
          spawnedCwd = String(spawnOptions.cwd ?? "");
          workspaceModePromise = stat(spawnedCwd).then((stats) => stats.mode);
          capturedEnv = spawnOptions.env;
          return makeMockProcess([
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
            '{"type":"turn.completed","usage":{"input_tokens":14,"output_tokens":2}}',
          ]);
        }),
        cliTimeoutMs: 1_000,
        cliSandbox: {
          workspaceRoot,
        },
        onChunk: () => undefined,
      });

      expect(spawnedCwd).toContain(
        join(workspaceRoot, "codex", "task_codex_workspace-"),
      );
      expect(capturedArgs).toContain("--sandbox");
      expect(capturedArgs[capturedArgs.indexOf("--sandbox") + 1]).toBe(
        "workspace-write",
      );
      expect(capturedArgs).toContain("--cd");
      expect(capturedArgs[capturedArgs.indexOf("--cd") + 1]).toBe(spawnedCwd);
      expect(capturedEnv?.OPENAI_API_KEY).toBe("openai-test-key");
      expect(capturedEnv?.PWD).toBe(spawnedCwd);
      expect(capturedEnv).not.toHaveProperty("UNRELATED_SECRET");
      if (!workspaceModePromise) {
        throw new Error("Codex workspace mode promise was not captured.");
      }
      const workspaceMode = await workspaceModePromise;
      expect(workspaceMode & 0o777).toBe(0o700);
      await expect(stat(spawnedCwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves full CLI conversation history for Codex execution", async () => {
    let stdinText = "";

    await fulfillViaCodexCli({
      taskId: "task_codex_history",
      payload: {
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "First request" },
          { role: "assistant", content: "Done" },
          { role: "user", content: "Second request" },
        ],
      },
      modelName: "gpt-5.3-codex",
      spawnImpl: vi.fn(() => {
        const process = makeMockProcess([
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
          '{"type":"turn.completed","usage":{"input_tokens":14,"output_tokens":2}}',
        ]);
        process.stdin.on("data", (chunk: Buffer | string) => {
          stdinText += chunk.toString();
        });
        return process;
      }),
      cliTimeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(stdinText).toBe(
      "System instructions:\nBe concise\n\nConversation history:\n\nUser:\nFirst request\n\nAssistant:\nDone\n\nUser:\nSecond request\n\nRespond to the latest user message using the full conversation above.",
    );
  });

  it("normalizes structured Codex CLI tool output into chunks and terminal assistant state", async () => {
    const chunks: InferenceChunk[] = [];

    const result = await fulfillViaCodexCli({
      taskId: "task_codex_tools",
      payload: {
        messages: [{ role: "user", content: "Run ls" }],
      },
      modelName: "gpt-5.3-codex",
      spawnImpl: vi.fn(() =>
        makeMockProcess([
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Running"}}',
          '{"type":"item.completed","item":{"id":"call_123","type":"mcp_tool_call","server":"workspace","tool":"exec","arguments":{"cmd":"ls"}}}',
          '{"type":"turn.completed","usage":{"input_tokens":3000,"output_tokens":700}}',
        ]),
      ),
      cliTimeoutMs: 1_000,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      {
        type: "text_delta",
        text: "Running",
      },
      {
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
    ]);
    expect(result).toEqual({
      usage: {
        input_tokens: 3000,
        output_tokens: 700,
      },
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
    });
  });

  it("rejects Codex CLI when the stream produces no assistant output", async () => {
    await expect(
      fulfillViaCodexCli({
        taskId: "task_codex_no_output",
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

  it("retains failed Codex task workspaces when debug retention is enabled", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    let spawnedCwd = "";

    try {
      await expect(
        fulfillViaCodexCli({
          taskId: "task_codex_failed_workspace",
          payload: {
            messages: [{ role: "user", content: "Say hello" }],
          },
          modelName: "gpt-5.3-codex",
          spawnImpl: vi.fn((_command, _args, spawnOptions) => {
            spawnedCwd = String(spawnOptions.cwd ?? "");
            throw new Error("sandbox unavailable");
          }),
          cliTimeoutMs: 1_000,
          cliSandbox: {
            workspaceRoot,
            retainFailedWorkspaces: true,
          },
          onChunk: () => undefined,
        }),
      ).rejects.toThrow(
        /Codex CLI fulfillment failed: sandbox unavailable Workspace retained at '.+'/,
      );

      await expect(stat(spawnedCwd)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
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
