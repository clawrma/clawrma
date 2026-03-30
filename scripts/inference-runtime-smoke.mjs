#!/usr/bin/env node

import process from "node:process";

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function parseArgs(argv) {
  const options = {
    provider: "codex",
    mode: "plain",
    toolProfile: "openclaw",
    model: undefined,
    timeoutMs: 120_000,
    retainFailed: false,
    expectToolCall: false,
    workspaceRoot: process.env.CLAWRMA_SOLVER_WORKSPACE_ROOT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--provider") {
      options.provider = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--mode") {
      options.mode = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--tool-profile") {
      options.toolProfile = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--model") {
      options.model = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(String(argv[index + 1] || ""), 10);
      index += 1;
      continue;
    }
    if (value === "--workspace-root") {
      options.workspaceRoot = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--retain-failed") {
      options.retainFailed = true;
      continue;
    }
    if (value === "--expect-tool-call") {
      options.expectToolCall = true;
      continue;
    }
    if (value === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (options.provider !== "codex" && options.provider !== "claude") {
    throw new Error("--provider must be 'codex' or 'claude'.");
  }
  if (options.mode !== "plain" && options.mode !== "tools") {
    throw new Error("--mode must be 'plain' or 'tools'.");
  }
  if (options.toolProfile !== "openclaw" && options.toolProfile !== "generic") {
    throw new Error("--tool-profile must be 'openclaw' or 'generic'.");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  return options;
}

function parseBooleanEnv(name) {
  const value = process.env[name];
  return (
    typeof value === "string" &&
    BOOLEAN_TRUE_VALUES.has(value.trim().toLowerCase())
  );
}

function printHelp() {
  console.log(`Usage:
  node scripts/inference-runtime-smoke.mjs --provider codex --mode plain
  node scripts/inference-runtime-smoke.mjs --provider claude --mode tools --expect-tool-call

Options:
  --provider codex|claude
  --mode plain|tools
  --tool-profile openclaw|generic
  --model <name>
  --timeout-ms <milliseconds>
  --workspace-root <path>
  --retain-failed
  --expect-tool-call
`);
}

function buildToolPayload(toolProfile) {
  if (toolProfile === "generic") {
    return {
      messages: [
        {
          role: "system",
          content:
            "When a tool is available, use the provided tool name and argument schema exactly.",
        },
        {
          role: "user",
          content:
            "Call the exec tool exactly once with a JSON argument object that uses cmd=pwd. Do not answer in plain text.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "exec",
            description: "Run a shell command.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                cmd: {
                  type: "string",
                },
              },
              required: ["cmd"],
            },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
    };
  }

  return {
    messages: [
      {
        role: "system",
        content:
          "When a tool is available, use the provided tool name and argument schema exactly.",
      },
      {
        role: "user",
        content:
          "Call the exec tool exactly once with a JSON argument object that uses command='/bin/bash -lc pwd' and timeout=20. Do not answer in plain text.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "exec",
          description: "Run a shell command in the workspace.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: {
                type: "string",
              },
              timeout: {
                type: "integer",
                minimum: 1,
              },
            },
            required: ["command"],
          },
        },
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
}

function buildPayload(mode, toolProfile) {
  if (mode === "plain") {
    return {
      messages: [
        {
          role: "system",
          content: "Reply with a short confirmation sentence.",
        },
        {
          role: "user",
          content: "Say: manual runtime smoke ok.",
        },
      ],
    };
  }

  return buildToolPayload(toolProfile);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { defaultSpawn, fulfillViaClaudeCli, fulfillViaCodexCli } =
    await import("../dist/src/solver/inference.js");
  const model =
    options.model ||
    (options.provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL);
  const payload = buildPayload(options.mode, options.toolProfile);
  const chunks = [];

  const executionOptions = {
    taskId: `manual-smoke-${options.provider}-${Date.now()}`,
    payload,
    modelName: model,
    spawnImpl: defaultSpawn,
    cliTimeoutMs: options.timeoutMs,
    cliSandbox: {
      ...(options.workspaceRoot?.trim()
        ? { workspaceRoot: options.workspaceRoot.trim() }
        : {}),
      ...(options.retainFailed ||
      parseBooleanEnv("CLAWRMA_SOLVER_RETAIN_FAILED_WORKSPACES")
        ? { retainFailedWorkspaces: true }
        : {}),
    },
    onChunk: (chunk) => {
      chunks.push(chunk);
      console.log(JSON.stringify({ event: "chunk", chunk }));
    },
  };

  const result =
    options.provider === "codex"
      ? await fulfillViaCodexCli(executionOptions)
      : await fulfillViaClaudeCli(executionOptions);

  const toolCallCount = chunks.filter(
    (chunk) => chunk.type === "tool_call_delta",
  ).length;
  if (options.expectToolCall && toolCallCount === 0) {
    throw new Error(
      "Smoke run completed without a tool_call_delta chunk, but --expect-tool-call was set.",
    );
  }

  console.log(
    JSON.stringify(
      {
        event: "complete",
        provider: options.provider,
        mode: options.mode,
        toolProfile: options.toolProfile,
        model,
        chunkCount: chunks.length,
        toolCallChunkCount: toolCallCount,
        result,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
