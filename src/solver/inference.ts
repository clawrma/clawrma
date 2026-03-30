import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CONFIG_DIR } from "../constants.js";
import { readOpenClawConfig } from "../integrations/openclaw.js";
import type { CliSandboxConfig, FrameworkType } from "../types.js";
import { asRecord } from "./assignments.js";
import type {
  InferenceAssistantMessage,
  InferenceChunk,
  InferenceExecutionResult,
  InferenceMessage,
  LlmTaskPayload,
  ProviderRuntimeConfig,
  TaskUsage,
  InferenceToolCall,
  InferenceToolCallDelta,
  InferenceToolCallFunction,
  InferenceToolCallFunctionDelta,
  InferenceTextContentPart,
} from "./contracts.js";
import { projectInferenceMessageContentText } from "./contracts.js";

class InferenceExecutionError extends Error {}

/**
 * Process spawner used by CLI-backed inference executors.
 */
export type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/**
 * Provider-config lookup used by API-backed inference execution.
 */
export type ProviderResolver = (
  providerName: string,
  framework: FrameworkType,
) => Promise<ProviderRuntimeConfig | null>;

/**
 * Shared execution inputs for API-backed inference.
 */
export interface ApiInferenceExecutionOptions {
  payload: LlmTaskPayload;
  providerName: string;
  modelName: string;
  framework: FrameworkType;
  providerResolver: ProviderResolver;
  fetchImpl: typeof fetch;
  fetchTimeoutMs: number;
  maxSpendPerRequest?: number | null;
  onChunk: (chunk: InferenceChunk) => void;
}

/**
 * Shared execution inputs for CLI-backed inference.
 */
export interface CliInferenceExecutionOptions {
  taskId: string;
  payload: LlmTaskPayload;
  modelName: string;
  spawnImpl: SpawnImpl;
  cliTimeoutMs: number;
  cliSandbox?: CliSandboxConfig;
  onChunk: (chunk: InferenceChunk) => void;
}

type CliCommand = "claude" | "codex";

interface CliExecutionContext {
  workspaceDir: string;
  childEnv: NodeJS.ProcessEnv;
  retainFailedWorkspaces: boolean;
}

const DEFAULT_CLI_WORKSPACE_ROOT = join(CONFIG_DIR, "solver-workspaces");

const BASE_CHILD_ENV_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
].map((entry) => entry.toUpperCase());

const CODEX_CHILD_ENV_KEYS = [
  "CODEX_HOME",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
].map((entry) => entry.toUpperCase());

const CLAUDE_CHILD_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
].map((entry) => entry.toUpperCase());

/**
 * Parses an untrusted messages payload into the normalized inference-message
 * list consumed by provider and CLI executors.
 */
export function parseInferenceMessages(
  value: unknown,
): InferenceMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const parsed: InferenceMessage[] = [];
  for (const message of value) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }

    const role = typeof record.role === "string" ? record.role : "";
    const content = normalizeInferenceMessageContent(record.content);
    if (!role || content === null) {
      continue;
    }

    parsed.push({
      ...record,
      role,
      content,
    });
  }

  return parsed.length > 0 ? parsed : null;
}

function normalizeInferenceMessageContent(
  value: unknown,
): InferenceMessage["content"] | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parts: Array<string | InferenceTextContentPart> = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }

    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const normalizedPart = normalizeInferenceTextContentPart(record);
    if (normalizedPart) {
      parts.push(normalizedPart);
    }
  }

  return parts.length > 0 ? parts : null;
}

function normalizeInferenceTextContentPart(
  value: Record<string, unknown>,
): InferenceTextContentPart | null {
  const normalizedPart: InferenceTextContentPart = {
    ...value,
  };
  let hasText = false;

  if (typeof normalizedPart.text === "string") {
    const text = normalizedPart.text.trim();
    if (text) {
      normalizedPart.text = text;
      hasText = true;
    } else {
      delete normalizedPart.text;
    }
  }

  if (typeof normalizedPart.input_text === "string") {
    const inputText = normalizedPart.input_text.trim();
    if (inputText) {
      normalizedPart.input_text = inputText;
      hasText = true;
    } else {
      delete normalizedPart.input_text;
    }
  }

  if (!hasText) {
    return null;
  }

  return normalizedPart;
}

/**
 * Resolves the effective per-request spend cap from payload and config inputs.
 */
export function resolveInferenceMaxSpendPoints(
  payloadCap: unknown,
  configCap: number | null | undefined,
): number | null {
  if (
    typeof payloadCap === "number" &&
    Number.isFinite(payloadCap) &&
    payloadCap > 0
  ) {
    return payloadCap;
  }
  if (
    typeof configCap === "number" &&
    Number.isFinite(configCap) &&
    configCap > 0
  ) {
    return configCap;
  }
  return null;
}

/**
 * Executes an OpenAI-compatible streaming API inference request.
 */
export async function fulfillViaApi(
  options: ApiInferenceExecutionOptions,
): Promise<InferenceExecutionResult> {
  const messages = parseInferenceMessages(options.payload.messages);
  if (!messages) {
    throw expectedInferenceError(
      "Task payload is missing a non-empty messages list.",
    );
  }

  const providerConfig = await options.providerResolver(
    options.providerName,
    options.framework,
  );
  if (!providerConfig || !providerConfig.endpoint) {
    throw expectedInferenceError(
      `API fulfillment missing provider endpoint for '${options.providerName || "unknown"}'.`,
    );
  }

  const requestBody: Record<string, unknown> = {
    model: options.modelName,
    messages,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };

  if (typeof options.payload.temperature === "number") {
    requestBody.temperature = options.payload.temperature;
  }
  if (typeof options.payload.max_tokens === "number") {
    requestBody.max_tokens = options.payload.max_tokens;
  }
  if (options.payload.tools !== undefined) {
    requestBody.tools = options.payload.tools;
  }
  if (options.payload.tool_choice !== undefined) {
    requestBody.tool_choice = options.payload.tool_choice;
  }
  if (options.payload.parallel_tool_calls !== undefined) {
    requestBody.parallel_tool_calls = options.payload.parallel_tool_calls;
  }

  const maxSpendPerRequest = resolveInferenceMaxSpendPoints(
    options.payload.max_spend_points,
    options.maxSpendPerRequest,
  );
  if (maxSpendPerRequest !== null) {
    requestBody.metadata = {
      ...(asRecord(requestBody.metadata) ?? {}),
      clawrma_max_spend_points: maxSpendPerRequest,
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (providerConfig.apiKey) {
    headers.authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.fetchTimeoutMs);

  let usage: TaskUsage | null = null;
  const assembledTextParts: string[] = [];
  const assembledToolCalls = new Map<number, InferenceToolCallDelta>();
  let finalAssistantMessage: InferenceAssistantMessage | null = null;
  try {
    const response = await options.fetchImpl(
      buildCompletionsUrl(providerConfig.endpoint),
      {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 400);
      throw expectedInferenceError(
        `Provider returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`,
      );
    }

    if (!response.body) {
      throw expectedInferenceError(
        "Provider response did not include a body stream.",
      );
    }

    for await (const line of iterateResponseLines(response.body)) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const dataPart = line.slice(6).trim();
      if (!dataPart) {
        continue;
      }
      if (dataPart === "[DONE]") {
        break;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(dataPart);
      } catch {
        continue;
      }

      const parsedUsage = extractOpenAiUsage(parsed);
      if (parsedUsage) {
        usage = parsedUsage;
      }

      const chunkState = extractOpenAiChunkState(parsed);
      for (const chunk of chunkState.chunks) {
        if (chunk.type === "text_delta") {
          assembledTextParts.push(chunk.text);
          options.onChunk(chunk);
          continue;
        }

        const mergedToolCall = mergeToolCallDelta(
          assembledToolCalls.get(chunk.tool_call.index),
          chunk.tool_call,
        );
        assembledToolCalls.set(chunk.tool_call.index, mergedToolCall);
        options.onChunk(chunk);
      }

      if (chunkState.finalAssistantMessage) {
        finalAssistantMessage = chunkState.finalAssistantMessage;
        emitMissingTerminalToolCallChunks(
          chunkState.finalAssistantMessage,
          assembledToolCalls,
          options.onChunk,
        );
      }
    }

    if (usage === null) {
      throw expectedInferenceError(
        "Provider stream ended without usage metadata.",
      );
    }

    return {
      usage,
      result: buildStructuredAssistantResult(
        finalAssistantMessage,
        assembledTextParts,
        assembledToolCalls,
      ),
    };
  } catch (error: unknown) {
    if (error instanceof InferenceExecutionError) {
      throw error;
    }

    throw wrapUnexpectedInferenceError("API fulfillment failed", error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Executes a Claude CLI inference request and streams assistant output chunks.
 */
export async function fulfillViaClaudeCli(
  options: CliInferenceExecutionOptions,
): Promise<InferenceExecutionResult> {
  const messages = parseInferenceMessages(options.payload.messages);
  if (!messages) {
    throw expectedInferenceError(
      "Task payload is missing a non-empty messages list.",
    );
  }

  const { prompt, systemPrompt } = buildCliConversationInput(messages);
  const context = await createCliExecutionContext({
    commandName: "claude",
    taskId: options.taskId,
    cliSandbox: options.cliSandbox,
  });

  try {
    const startedAt = Date.now();
    const args = [
      "--model",
      options.modelName,
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
    ];
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const process = options.spawnImpl("claude", args, {
      stdio: "pipe",
      cwd: context.workspaceDir,
      env: context.childEnv,
    });

    const stderrPromise = streamToString(process.stderr);

    process.stdin.write(prompt);
    process.stdin.end();

    let sawChunk = false;
    let streamError: string | null = null;
    let usage: TaskUsage | null = null;
    const assembledTextParts: string[] = [];
    const assembledToolCalls = new Map<number, InferenceToolCallDelta>();
    const toolCallIndexById = new Map<string, number>();
    let nextToolCallIndex = 0;
    let finalAssistantMessage: InferenceAssistantMessage | null = null;

    for await (const line of iterateNodeLinesWithTimeout(
      process,
      options.cliTimeoutMs,
      startedAt,
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (streamError === null) {
        streamError = extractClaudeStreamError(parsed);
      }
      const parsedUsage = extractClaudeUsage(parsed);
      if (parsedUsage) {
        usage = parsedUsage;
      }
      const parsedRecord = asRecord(parsed);
      const suppressTerminalTextDelta =
        parsedRecord?.type === "result" && assembledTextParts.length > 0;

      const chunkState = extractClaudeChunkState(
        parsed,
        toolCallIndexById,
        () => {
          const index = nextToolCallIndex;
          nextToolCallIndex += 1;
          return index;
        },
      );
      for (const chunk of chunkState.chunks) {
        if (chunk.type === "text_delta") {
          if (suppressTerminalTextDelta) {
            continue;
          }
          assembledTextParts.push(chunk.text);
          sawChunk = true;
          options.onChunk(chunk);
          continue;
        }

        if (shouldEmitStructuredToolCall(assembledToolCalls, chunk.tool_call)) {
          sawChunk = true;
          options.onChunk(chunk);
        }
      }

      if (chunkState.finalAssistantMessage) {
        finalAssistantMessage = chunkState.finalAssistantMessage;
        emitMissingTerminalToolCallChunks(
          chunkState.finalAssistantMessage,
          assembledToolCalls,
          options.onChunk,
        );
      }
    }

    const exitCode = await waitForProcessExit(
      process,
      remainingTimeoutMs(options.cliTimeoutMs, startedAt),
    );
    const stderrText = (await stderrPromise).trim();
    if (exitCode !== 0) {
      throw expectedInferenceError(
        stderrText || `Claude CLI exited with code ${exitCode}`,
      );
    }

    if (streamError) {
      throw expectedInferenceError(streamError);
    }

    if (!sawChunk) {
      throw expectedInferenceError("Claude CLI produced no assistant output.");
    }

    if (usage === null) {
      throw expectedInferenceError(
        "Claude CLI stream ended without usage metadata.",
      );
    }

    const result = {
      usage,
      result: buildStructuredAssistantResult(
        finalAssistantMessage,
        assembledTextParts,
        assembledToolCalls,
      ),
    };
    await cleanupCliExecutionContext(context);
    return result;
  } catch (error: unknown) {
    let retainedWorkspace: string | null;
    try {
      retainedWorkspace = await handleCliExecutionFailure(context);
    } catch (cleanupError: unknown) {
      throw wrapCliCleanupError(
        "CLI fulfillment failed",
        error,
        context.workspaceDir,
        cleanupError,
      );
    }
    throw normalizeCliExecutionError(
      "CLI fulfillment failed",
      error,
      retainedWorkspace,
    );
  }
}

/**
 * Executes a Codex CLI inference request and streams assistant output chunks.
 */
export async function fulfillViaCodexCli(
  options: CliInferenceExecutionOptions,
): Promise<InferenceExecutionResult> {
  const messages = parseInferenceMessages(options.payload.messages);
  if (!messages) {
    throw expectedInferenceError(
      "Task payload is missing a non-empty messages list.",
    );
  }

  const { prompt, systemPrompt } = buildCliConversationInput(messages);
  const codexPrompt = systemPrompt
    ? prompt.startsWith("Conversation history:")
      ? `System instructions:\n${systemPrompt}\n\n${prompt}`
      : `System instructions:\n${systemPrompt}\n\nUser request:\n${prompt}`
    : prompt;
  const context = await createCliExecutionContext({
    commandName: "codex",
    taskId: options.taskId,
    cliSandbox: options.cliSandbox,
  });

  try {
    const startedAt = Date.now();
    const process = options.spawnImpl(
      "codex",
      [
        "exec",
        "--model",
        options.modelName,
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        context.workspaceDir,
        "--skip-git-repo-check",
        "-",
      ],
      {
        stdio: "pipe",
        cwd: context.workspaceDir,
        env: context.childEnv,
      },
    );

    process.stdin.write(codexPrompt);
    process.stdin.end();

    const stderrPromise = streamToString(process.stderr);
    let sawChunk = false;
    let streamError: string | null = null;
    let usage: TaskUsage | null = null;
    const assembledTextParts: string[] = [];
    const assembledToolCalls = new Map<number, InferenceToolCallDelta>();
    const toolCallIndexById = new Map<string, number>();
    let nextToolCallIndex = 0;

    for await (const line of iterateNodeLinesWithTimeout(
      process,
      options.cliTimeoutMs,
      startedAt,
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (streamError === null) {
        streamError = extractCodexStreamError(parsed);
      }
      const parsedUsage = extractCodexUsage(parsed);
      if (parsedUsage) {
        usage = parsedUsage;
      }

      const chunkState = extractCodexChunkState(
        parsed,
        toolCallIndexById,
        () => {
          const index = nextToolCallIndex;
          nextToolCallIndex += 1;
          return index;
        },
      );
      for (const chunk of chunkState.chunks) {
        if (chunk.type === "text_delta") {
          assembledTextParts.push(chunk.text);
          sawChunk = true;
          options.onChunk(chunk);
          continue;
        }

        if (shouldEmitStructuredToolCall(assembledToolCalls, chunk.tool_call)) {
          sawChunk = true;
          options.onChunk(chunk);
        }
      }
    }

    const exitCode = await waitForProcessExit(
      process,
      remainingTimeoutMs(options.cliTimeoutMs, startedAt),
    );
    const stderrText = (await stderrPromise).trim();
    if (exitCode !== 0) {
      throw expectedInferenceError(
        stderrText || `Codex CLI exited with code ${exitCode}`,
      );
    }

    if (streamError) {
      throw expectedInferenceError(streamError);
    }

    if (!sawChunk) {
      throw expectedInferenceError("Codex CLI produced no assistant output.");
    }

    if (usage === null) {
      throw expectedInferenceError(
        "Codex CLI stream ended without usage metadata.",
      );
    }

    const result = {
      usage,
      result: buildStructuredAssistantResult(
        null,
        assembledTextParts,
        assembledToolCalls,
      ),
    };
    await cleanupCliExecutionContext(context);
    return result;
  } catch (error: unknown) {
    let retainedWorkspace: string | null;
    try {
      retainedWorkspace = await handleCliExecutionFailure(context);
    } catch (cleanupError: unknown) {
      throw wrapCliCleanupError(
        "Codex CLI fulfillment failed",
        error,
        context.workspaceDir,
        cleanupError,
      );
    }
    throw normalizeCliExecutionError(
      "Codex CLI fulfillment failed",
      error,
      retainedWorkspace,
    );
  }
}

/**
 * Resolves the provider endpoint and credentials used for API inference.
 */
export async function resolveProviderRuntimeConfig(
  providerName: string,
  framework: FrameworkType,
): Promise<ProviderRuntimeConfig | null> {
  if (framework !== "openclaw") {
    const localEndpoint = process.env.CLAWRMA_PROVIDER_BASE_URL ?? "";
    const apiKey = process.env.CLAWRMA_PROVIDER_API_KEY ?? null;
    if (!localEndpoint) {
      return null;
    }
    return {
      endpoint: localEndpoint,
      apiKey,
    };
  }

  const config = await readOpenClawConfig();
  if (!config || !providerName) {
    return null;
  }

  const provider = config.providers.find(
    (entry) => entry.name === providerName,
  );
  if (!provider?.endpoint) {
    return null;
  }

  const apiKey =
    provider.apiKey || provider.token || providerApiKeyFromEnv(providerName);

  return {
    endpoint: provider.endpoint,
    apiKey,
  };
}

/**
 * Resolves a provider API key from the conventional environment-variable names.
 */
export function providerApiKeyFromEnv(providerName: string): string | null {
  const normalized = providerName.toLowerCase();
  if (normalized === "openrouter") {
    return process.env.OPENROUTER_API_KEY ?? null;
  }
  if (normalized === "openai" || normalized === "openai-codex") {
    return process.env.OPENAI_API_KEY ?? null;
  }
  if (normalized === "anthropic" || normalized.includes("claude")) {
    return process.env.ANTHROPIC_API_KEY ?? null;
  }
  return null;
}

/**
 * Default child-process spawner used by CLI inference executors.
 */
export function defaultSpawn(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options);
}

async function createCliExecutionContext(options: {
  commandName: CliCommand;
  taskId: string;
  cliSandbox?: CliSandboxConfig;
}): Promise<CliExecutionContext> {
  const workspaceRoot = resolveCliWorkspaceRoot(options.cliSandbox);
  const commandRoot = join(workspaceRoot, options.commandName);
  const workspacePrefix = `${sanitizeWorkspacePathSegment(options.taskId)}-`;

  try {
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await chmod(workspaceRoot, 0o700);
    await mkdir(commandRoot, { recursive: true, mode: 0o700 });
    await chmod(commandRoot, 0o700);

    const workspaceDir = await mkdtemp(join(commandRoot, workspacePrefix));
    await chmod(workspaceDir, 0o700);

    return {
      workspaceDir,
      childEnv: buildCliChildEnv(options.commandName, workspaceDir),
      retainFailedWorkspaces:
        options.cliSandbox?.retainFailedWorkspaces === true,
    };
  } catch (error: unknown) {
    throw expectedInferenceError(
      `Failed to create CLI workspace under '${commandRoot}': ${describeUnknownError(error)}`,
    );
  }
}

async function cleanupCliExecutionContext(
  context: CliExecutionContext,
): Promise<void> {
  try {
    await rm(context.workspaceDir, { recursive: true, force: true });
  } catch (error: unknown) {
    throw expectedInferenceError(
      `Failed to clean up CLI workspace '${context.workspaceDir}': ${describeUnknownError(error)}`,
    );
  }
}

async function handleCliExecutionFailure(
  context: CliExecutionContext,
): Promise<string | null> {
  if (context.retainFailedWorkspaces) {
    return context.workspaceDir;
  }

  await cleanupCliExecutionContext(context);
  return null;
}

function resolveCliWorkspaceRoot(cliSandbox?: CliSandboxConfig): string {
  const configuredRoot = cliSandbox?.workspaceRoot?.trim();
  return configuredRoot ? resolve(configuredRoot) : DEFAULT_CLI_WORKSPACE_ROOT;
}

function sanitizeWorkspacePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "task";
}

function buildCliChildEnv(
  commandName: CliCommand,
  workspaceDir: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedKeys = new Set(BASE_CHILD_ENV_KEYS);
  const providerKeys =
    commandName === "codex" ? CODEX_CHILD_ENV_KEYS : CLAUDE_CHILD_ENV_KEYS;
  for (const key of providerKeys) {
    allowedKeys.add(key);
  }

  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    if (allowedKeys.has(key.toUpperCase())) {
      childEnv[key] = value;
    }
  }
  childEnv.PWD = workspaceDir;
  return childEnv;
}

function expectedInferenceError(message: string): InferenceExecutionError {
  return new InferenceExecutionError(message);
}

function buildCliConversationInput(messages: InferenceMessage[]): {
  prompt: string;
  systemPrompt: string | null;
} {
  const systemSections: string[] = [];
  const conversation: Array<{
    role: string;
    content: string;
  }> = [];

  for (const message of messages) {
    const content = projectInferenceMessageContentText(message.content);
    if (!content) {
      continue;
    }

    if (message.role === "system") {
      systemSections.push(content);
      continue;
    }

    if (message.role === "developer") {
      systemSections.push(`Developer instructions:\n${content}`);
      continue;
    }

    conversation.push({
      role: message.role,
      content,
    });
  }

  const hasUserMessage = conversation.some(
    (message) => message.role === "user",
  );
  if (!hasUserMessage) {
    throw expectedInferenceError(
      "Task payload did not include a user message.",
    );
  }

  const prompt =
    conversation.length === 1 && conversation[0]?.role === "user"
      ? conversation[0].content
      : [
          "Conversation history:",
          "",
          ...conversation.flatMap((message, index) => [
            `${formatCliConversationRole(message.role)}:\n${message.content}`,
            ...(index < conversation.length - 1 ? [""] : []),
          ]),
          "",
          "Respond to the latest user message using the full conversation above.",
        ].join("\n");

  return {
    prompt,
    systemPrompt:
      systemSections.length > 0 ? systemSections.join("\n\n") : null,
  };
}

function formatCliConversationRole(role: string): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "user":
      return "User";
    default:
      return role
        ? `${role.charAt(0).toUpperCase()}${role.slice(1)}`
        : "Message";
  }
}

function buildCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed.replace(/\/$/, "")}/chat/completions`;
}

async function* iterateResponseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
        }
      }
    }

    const finalLine = `${buffer}${decoder.decode()}`.trim();
    if (finalLine) {
      yield finalLine;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractOpenAiChunkState(value: unknown): {
  chunks: InferenceChunk[];
  finalAssistantMessage: InferenceAssistantMessage | null;
} {
  const payload = asRecord(value);
  if (!payload) {
    return { chunks: [], finalAssistantMessage: null };
  }

  if (payload.object === "error") {
    const errorRecord = asRecord(payload.error);
    const message =
      typeof errorRecord?.message === "string"
        ? errorRecord.message
        : "Provider returned an error chunk.";
    throw new Error(message);
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { chunks: [], finalAssistantMessage: null };
  }

  const first = asRecord(choices[0]);
  if (!first) {
    return { chunks: [], finalAssistantMessage: null };
  }

  const finishReason =
    typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  const chunks: InferenceChunk[] = [];
  const delta = asRecord(first.delta);

  if (typeof delta?.content === "string" && delta.content.length > 0) {
    chunks.push({
      type: "text_delta",
      text: delta.content,
      ...(finishReason ? { finish_reason: finishReason } : {}),
    });
  }

  if (delta && Object.hasOwn(delta, "tool_calls")) {
    const toolCallDeltas = normalizeToolCallDeltaList(delta.tool_calls);
    for (const toolCall of toolCallDeltas) {
      chunks.push({
        type: "tool_call_delta",
        tool_call: toolCall,
        ...(finishReason ? { finish_reason: finishReason } : {}),
      });
    }
  }

  const finalAssistantMessage = extractTerminalAssistantMessage(first);
  return {
    chunks,
    finalAssistantMessage,
  };
}

function extractOpenAiUsage(value: unknown): TaskUsage | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  return usageFromRecord(asRecord(payload.usage));
}

function extractTerminalAssistantMessage(
  choice: Record<string, unknown>,
): InferenceAssistantMessage | null {
  const message = asRecord(choice.message);
  if (!message || message.role !== "assistant") {
    return null;
  }

  const toolCalls = Object.hasOwn(message, "tool_calls")
    ? normalizeTerminalToolCalls(message.tool_calls)
    : undefined;
  const content = normalizeTerminalAssistantContent(message.content);

  if (toolCalls === undefined && content === null) {
    return null;
  }

  return {
    role: "assistant",
    ...(content !== null ? { content } : {}),
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
  };
}

function normalizeTerminalAssistantContent(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }

  const extracted = extractTextContent(value);
  return extracted ?? null;
}

function normalizeToolCallDeltaList(value: unknown): InferenceToolCallDelta[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw expectedInferenceError(
      "Provider emitted malformed tool_calls delta: expected an array.",
    );
  }

  return value.map((toolCall, index) =>
    normalizeToolCallDelta(toolCall, `delta.tool_calls[${index}]`),
  );
}

function normalizeToolCallDelta(
  value: unknown,
  path: string,
): InferenceToolCallDelta {
  const record = asRecord(value);
  if (!record) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: expected an object.`,
    );
  }

  const index = toolCallIndexOrThrow(record.index, path);
  const id = optionalNonEmptyString(record.id);
  const type = optionalNonEmptyString(record.type);
  const hasFunctionKey = Object.hasOwn(record, "function");
  const functionValue = hasFunctionKey
    ? normalizeToolCallFunctionDelta(record.function, `${path}.function`)
    : undefined;

  if (!id && !type && !functionValue) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: missing id, type, or function content.`,
    );
  }

  return {
    index,
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
    ...(functionValue ? { function: functionValue } : {}),
  };
}

function normalizeToolCallFunctionDelta(
  value: unknown,
  path: string,
): InferenceToolCallFunctionDelta {
  const record = asRecord(value);
  if (!record) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: expected an object.`,
    );
  }

  const name = optionalNonEmptyString(record.name);
  const argumentsText = optionalNonEmptyString(record.arguments);
  if (!name && !argumentsText) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: missing name or arguments.`,
    );
  }

  return {
    ...(name ? { name } : {}),
    ...(argumentsText ? { arguments: argumentsText } : {}),
  };
}

function normalizeTerminalToolCalls(
  value: unknown,
): InferenceToolCall[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw expectedInferenceError(
      "Provider emitted malformed terminal assistant tool_calls: expected an array.",
    );
  }

  return value.map((toolCall, index) =>
    normalizeTerminalToolCall(toolCall, `message.tool_calls[${index}]`),
  );
}

function normalizeTerminalToolCall(
  value: unknown,
  path: string,
): InferenceToolCall {
  const record = asRecord(value);
  if (!record) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: expected an object.`,
    );
  }

  const id = optionalNonEmptyString(record.id);
  const type = optionalNonEmptyString(record.type);
  const hasFunctionKey = Object.hasOwn(record, "function");
  const functionValue = hasFunctionKey
    ? normalizeTerminalToolCallFunction(record.function, `${path}.function`)
    : undefined;

  if (!id && !type && !functionValue) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: missing id, type, or function content.`,
    );
  }

  return {
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
    ...(functionValue ? { function: functionValue } : {}),
  };
}

function normalizeTerminalToolCallFunction(
  value: unknown,
  path: string,
): InferenceToolCallFunction {
  const record = asRecord(value);
  if (!record) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: expected an object.`,
    );
  }

  const name = optionalNonEmptyString(record.name);
  const argumentsText = optionalNonEmptyString(record.arguments);
  if (!name && !argumentsText) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: missing name or arguments.`,
    );
  }

  return {
    ...(name ? { name } : {}),
    ...(argumentsText ? { arguments: argumentsText } : {}),
  };
}

function buildStructuredAssistantResult(
  finalAssistantMessage: InferenceAssistantMessage | null,
  assembledTextParts: string[],
  assembledToolCalls: Map<number, InferenceToolCallDelta>,
): InferenceAssistantMessage | undefined {
  if (finalAssistantMessage?.tool_calls?.length) {
    return {
      role: "assistant",
      content: finalAssistantMessage.content ?? assembledTextParts.join(""),
      tool_calls: finalAssistantMessage.tool_calls,
    };
  }

  if (assembledToolCalls.size === 0) {
    return undefined;
  }

  return {
    role: "assistant",
    content: finalAssistantMessage?.content ?? assembledTextParts.join(""),
    tool_calls: Array.from(assembledToolCalls.entries())
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCallDeltaToToolCall(toolCall)),
  };
}

function mergeToolCallDelta(
  existing: InferenceToolCallDelta | undefined,
  incoming: InferenceToolCallDelta,
): InferenceToolCallDelta {
  const mergedFunction = mergeToolCallFunctionDelta(
    existing?.function,
    incoming.function,
  );

  return {
    index: incoming.index,
    ...((incoming.id ?? existing?.id)
      ? { id: incoming.id ?? existing?.id }
      : {}),
    ...((incoming.type ?? existing?.type)
      ? { type: incoming.type ?? existing?.type }
      : {}),
    ...(mergedFunction ? { function: mergedFunction } : {}),
  };
}

function mergeToolCallFunctionDelta(
  existing: InferenceToolCallFunctionDelta | undefined,
  incoming: InferenceToolCallFunctionDelta | undefined,
): InferenceToolCallFunctionDelta | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  return {
    ...((incoming.name ?? existing.name)
      ? { name: incoming.name ?? existing.name }
      : {}),
    ...((incoming.arguments ?? existing.arguments)
      ? {
          arguments: `${existing.arguments ?? ""}${incoming.arguments ?? ""}`,
        }
      : {}),
  };
}

function toolCallDeltaToToolCall(
  toolCall: InferenceToolCallDelta,
): InferenceToolCall {
  return {
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.type ? { type: toolCall.type } : {}),
    ...(toolCall.function ? { function: toolCall.function } : {}),
  };
}

function toolCallToDelta(
  toolCall: InferenceToolCall,
  index: number,
): InferenceToolCallDelta {
  return {
    index,
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.type ? { type: toolCall.type } : {}),
    ...(toolCall.function ? { function: toolCall.function } : {}),
  };
}

function shouldEmitStructuredToolCall(
  assembledToolCalls: Map<number, InferenceToolCallDelta>,
  incoming: InferenceToolCallDelta,
): boolean {
  const existing = assembledToolCalls.get(incoming.index);
  if (existing && JSON.stringify(existing) === JSON.stringify(incoming)) {
    return false;
  }

  assembledToolCalls.set(incoming.index, incoming);
  return true;
}

function emitMissingTerminalToolCallChunks(
  finalAssistantMessage: InferenceAssistantMessage,
  assembledToolCalls: Map<number, InferenceToolCallDelta>,
  onChunk: (chunk: InferenceChunk) => void,
): void {
  if (!finalAssistantMessage.tool_calls?.length) {
    return;
  }

  finalAssistantMessage.tool_calls.forEach((toolCall, index) => {
    if (assembledToolCalls.has(index)) {
      return;
    }

    const delta = toolCallToDelta(toolCall, index);
    assembledToolCalls.set(index, delta);
    onChunk({
      type: "tool_call_delta",
      tool_call: delta,
    });
  });
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolCallIndexOrThrow(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw expectedInferenceError(
      `Provider emitted malformed ${path}: missing non-negative index.`,
    );
  }
  return value;
}

async function* iterateNodeLines(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      const normalized = line.trim();
      if (normalized.length > 0) {
        yield normalized;
      }
    }
  } finally {
    reader.close();
  }
}

async function* iterateNodeLinesWithTimeout(
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  startedAt: number,
): AsyncGenerator<string> {
  const iterator = iterateNodeLines(process.stdout)[Symbol.asyncIterator]();

  while (true) {
    const result = await waitForNextNodeLine(
      iterator,
      process,
      timeoutMs,
      startedAt,
    );
    if (result.done) {
      return;
    }
    yield result.value;
  }
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    output += String(chunk);
  }
  return output;
}

async function waitForProcessExit(
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number> {
  if (typeof process.exitCode === "number") {
    return process.exitCode;
  }

  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortProcess(process);
      reject(new Error(`Process timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    process.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    process.once("close", (code) => {
      clearTimeout(timer);
      resolve(typeof code === "number" ? code : 0);
    });
  });
}

function waitForNextNodeLine(
  iterator: AsyncIterator<string>,
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  startedAt: number,
): Promise<IteratorResult<string>> {
  const remainingMs = remainingTimeoutMs(timeoutMs, startedAt);

  return new Promise<IteratorResult<string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortProcess(process);
      reject(new Error(`Process timed out after ${timeoutMs}ms.`));
    }, remainingMs);

    void iterator.next().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function remainingTimeoutMs(timeoutMs: number, startedAt: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

function abortProcess(process: ChildProcessWithoutNullStreams): void {
  process.kill("SIGTERM");
  process.stdin.end();
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCliExecutionError(
  prefix: string,
  error: unknown,
  retainedWorkspace: string | null,
): Error {
  const normalized =
    error instanceof InferenceExecutionError
      ? error
      : wrapUnexpectedInferenceError(prefix, error);
  if (!retainedWorkspace) {
    return normalized;
  }

  return expectedInferenceError(
    `${normalized.message} Workspace retained at '${retainedWorkspace}'.`,
  );
}

function wrapCliCleanupError(
  prefix: string,
  originalError: unknown,
  workspaceDir: string,
  cleanupError: unknown,
): Error {
  const normalizedOriginal =
    originalError instanceof InferenceExecutionError
      ? originalError
      : wrapUnexpectedInferenceError(prefix, originalError);
  return expectedInferenceError(
    `${normalizedOriginal.message} Cleanup failed for workspace '${workspaceDir}': ${describeUnknownError(cleanupError)}`,
  );
}

function wrapUnexpectedInferenceError(prefix: string, error: unknown): Error {
  const message = describeUnknownError(error);
  return error instanceof Error
    ? new Error(`${prefix}: ${message}`, { cause: error })
    : new Error(`${prefix}: ${message}`);
}

function extractClaudeUsage(value: unknown): TaskUsage | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  return usageFromRecord(asRecord(payload.usage));
}

function extractCliAssistantChunkState(
  source: unknown,
  toolCallIndexById: Map<string, number>,
  allocateIndex: () => number,
  finishReason: string | undefined,
  finalAssistantMessage: InferenceAssistantMessage | null,
): {
  chunks: InferenceChunk[];
  finalAssistantMessage: InferenceAssistantMessage | null;
} {
  const assistantMessage =
    finalAssistantMessage ?? extractCliAssistantSummary(source);
  if (!assistantMessage) {
    return { chunks: [], finalAssistantMessage: null };
  }

  const chunks: InferenceChunk[] = [];
  if (
    typeof assistantMessage.content === "string" &&
    assistantMessage.content
  ) {
    chunks.push({
      type: "text_delta",
      text: assistantMessage.content,
      ...(finishReason ? { finish_reason: finishReason } : {}),
    });
  }

  if (assistantMessage.tool_calls?.length) {
    for (const toolCall of assistantMessage.tool_calls) {
      chunks.push({
        type: "tool_call_delta",
        tool_call: indexedToolCallDelta(
          toolCall,
          toolCallIndexById,
          allocateIndex,
        ),
        ...(finishReason ? { finish_reason: finishReason } : {}),
      });
    }
  }

  return {
    chunks,
    finalAssistantMessage,
  };
}

function indexedToolCallDelta(
  toolCall: InferenceToolCall,
  toolCallIndexById: Map<string, number>,
  allocateIndex: () => number,
): InferenceToolCallDelta {
  const id = optionalNonEmptyString(toolCall.id);
  const index = resolveToolCallIndex(id, toolCallIndexById, allocateIndex);

  return {
    index,
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.type ? { type: toolCall.type } : {}),
    ...(toolCall.function ? { function: toolCall.function } : {}),
  };
}

function resolveToolCallIndex(
  id: string | undefined,
  toolCallIndexById: Map<string, number>,
  allocateIndex: () => number,
): number {
  if (id) {
    const existing = toolCallIndexById.get(id);
    if (existing !== undefined) {
      return existing;
    }
  }

  const index = allocateIndex();
  if (id) {
    toolCallIndexById.set(id, index);
  }
  return index;
}

function extractCliAssistantSummary(
  value: unknown,
): InferenceAssistantMessage | null {
  const content = extractTextContent(value);
  const toolCalls = extractCliToolCalls(value);
  if (content === null && toolCalls.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    ...(content !== null ? { content } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function extractCliToolCalls(value: unknown): InferenceToolCall[] {
  const toolCalls: InferenceToolCall[] = [];

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }

    const record = asRecord(node);
    if (!record) {
      return;
    }

    const type = typeof record.type === "string" ? record.type : "";
    if (isClaudeToolUseType(type)) {
      toolCalls.push(normalizeClaudeToolCall(record, path));
      return;
    }

    if (record.content !== undefined) {
      visit(record.content, `${path}.content`);
      return;
    }

    if (record.message !== undefined) {
      visit(record.message, `${path}.message`);
      return;
    }

    if (record.result !== undefined) {
      visit(record.result, `${path}.result`);
    }
  };

  visit(value, "assistant");
  return toolCalls;
}

function isClaudeToolUseType(value: string): boolean {
  return (
    value === "tool_use" ||
    value === "server_tool_use" ||
    value === "mcp_tool_use"
  );
}

function normalizeClaudeToolCall(
  record: Record<string, unknown>,
  path: string,
): InferenceToolCall {
  const id =
    optionalNonEmptyString(record.id) ??
    optionalNonEmptyString(record.tool_use_id);
  const toolName = extractStructuredToolName(record, path);
  const argumentsText = serializeToolArguments(
    record.input ?? record.arguments ?? record.parameters,
    `${path}.input`,
  );

  return {
    ...(id ? { id } : {}),
    type: "function",
    function: {
      name: toolName,
      ...(argumentsText ? { arguments: argumentsText } : {}),
    },
  };
}

function extractFinishReason(
  payload: Record<string, unknown>,
): string | undefined {
  const message = asRecord(payload.message);
  return (
    (typeof payload.stop_reason === "string"
      ? payload.stop_reason
      : undefined) ??
    (typeof payload.finish_reason === "string"
      ? payload.finish_reason
      : undefined) ??
    (typeof message?.stop_reason === "string"
      ? message.stop_reason
      : undefined) ??
    (typeof message?.finish_reason === "string"
      ? message.finish_reason
      : undefined)
  );
}

function isCodexAgentMessageItem(value: unknown): boolean {
  return value === "agent_message" || value === "agentMessage";
}

function isCodexToolItem(value: unknown): boolean {
  return (
    value === "command_execution" ||
    value === "commandExecution" ||
    value === "mcp_tool_call" ||
    value === "mcpToolCall" ||
    value === "dynamic_tool_call" ||
    value === "dynamicToolCall" ||
    value === "custom_tool_call" ||
    value === "customToolCall" ||
    value === "collab_tool_call" ||
    value === "collabToolCall"
  );
}

function normalizeCodexToolCallDelta(
  item: Record<string, unknown>,
  toolCallIndexById: Map<string, number>,
  allocateIndex: () => number,
  path: string,
): InferenceToolCallDelta {
  const id = optionalNonEmptyString(item.id);
  const itemType = typeof item.type === "string" ? item.type : "";
  const toolName =
    itemType === "command_execution" || itemType === "commandExecution"
      ? "exec"
      : extractStructuredToolName(item, path);
  const argumentsValue =
    itemType === "command_execution" || itemType === "commandExecution"
      ? {
          command: item.command,
          ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        }
      : (item.arguments ?? item.input ?? item.parameters ?? item.prompt);
  const argumentsText = serializeToolArguments(
    argumentsValue,
    `${path}.arguments`,
  );

  return {
    index: resolveToolCallIndex(id, toolCallIndexById, allocateIndex),
    ...(id ? { id } : {}),
    type: "function",
    function: {
      name: toolName,
      ...(argumentsText ? { arguments: argumentsText } : {}),
    },
  };
}

function extractStructuredToolName(
  record: Record<string, unknown>,
  path: string,
): string {
  const directName = optionalNonEmptyString(record.name);
  if (directName) {
    return directName;
  }

  const tool = optionalNonEmptyString(record.tool);
  if (tool) {
    const server =
      optionalNonEmptyString(record.server) ??
      optionalNonEmptyString(record.server_name);
    return server ? `${server}.${tool}` : tool;
  }

  throw expectedInferenceError(
    `CLI emitted malformed ${path}: missing tool name.`,
  );
}

function serializeToolArguments(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new Error("not serializable");
    }
    return serialized;
  } catch {
    throw expectedInferenceError(
      `CLI emitted malformed ${path}: tool arguments were not serializable.`,
    );
  }
}

function extractClaudeChunkState(
  value: unknown,
  toolCallIndexById: Map<string, number>,
  allocateIndex: () => number,
): {
  chunks: InferenceChunk[];
  finalAssistantMessage: InferenceAssistantMessage | null;
} {
  const payload = asRecord(value);
  if (!payload) {
    return { chunks: [], finalAssistantMessage: null };
  }

  if (payload.type === "assistant") {
    const source = payload.content ?? payload.message;
    return extractCliAssistantChunkState(
      source,
      toolCallIndexById,
      allocateIndex,
      extractFinishReason(payload),
      null,
    );
  }

  if (payload.type !== "result") {
    return { chunks: [], finalAssistantMessage: null };
  }

  return extractCliAssistantChunkState(
    payload.result,
    toolCallIndexById,
    allocateIndex,
    "stop",
    extractCliAssistantSummary(payload.result),
  );
}

function extractClaudeStreamError(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload || payload.type !== "error") {
    return null;
  }

  if (typeof payload.message === "string" && payload.message) {
    return payload.message;
  }

  return (
    extractTextContent(payload.message) ?? "Claude CLI emitted stream error"
  );
}

function extractCodexChunkState(
  value: unknown,
  toolCallIndexById: Map<string, number>,
  allocateIndex: () => number,
): {
  chunks: InferenceChunk[];
} {
  const payload = asRecord(value);
  if (!payload) {
    return { chunks: [] };
  }

  if (payload.type !== "item.completed" && payload.type !== "item.started") {
    return { chunks: [] };
  }

  const item = asRecord(payload.item);
  if (!item) {
    return { chunks: [] };
  }

  if (isCodexAgentMessageItem(item.type)) {
    const text = typeof item.text === "string" ? item.text : "";
    return text
      ? {
          chunks: [
            {
              type: "text_delta",
              text,
            },
          ],
        }
      : { chunks: [] };
  }

  if (!isCodexToolItem(item.type)) {
    return { chunks: [] };
  }

  return {
    chunks: [
      {
        type: "tool_call_delta",
        tool_call: normalizeCodexToolCallDelta(
          item,
          toolCallIndexById,
          allocateIndex,
          "item",
        ),
      },
    ],
  };
}

function extractCodexStreamError(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  if (payload.type === "error") {
    return typeof payload.message === "string" && payload.message
      ? payload.message
      : "Codex CLI emitted stream error";
  }

  if (payload.type === "turn.failed") {
    const errorPayload = asRecord(payload.error);
    if (typeof errorPayload?.message === "string" && errorPayload.message) {
      return errorPayload.message;
    }

    return "Codex turn failed";
  }

  return null;
}

function extractCodexUsage(value: unknown): TaskUsage | null {
  const payload = asRecord(value);
  if (!payload || payload.type !== "turn.completed") {
    return null;
  }
  return usageFromRecord(asRecord(payload.usage));
}

function usageFromRecord(
  value: Record<string, unknown> | null,
): TaskUsage | null {
  if (!value) {
    return null;
  }

  const explicitInput = tokenCountOrNull(value.input_tokens);
  const explicitOutput = tokenCountOrNull(value.output_tokens);
  const explicitCachedInput = tokenCountOrNull(value.cached_input_tokens);
  if (explicitInput !== null && explicitOutput !== null) {
    return {
      input_tokens: explicitInput,
      output_tokens: explicitOutput,
      ...(explicitCachedInput !== null
        ? { cached_input_tokens: explicitCachedInput }
        : {}),
    };
  }

  const promptTokens = tokenCountOrNull(value.prompt_tokens);
  const completionTokens = tokenCountOrNull(value.completion_tokens);
  if (promptTokens !== null && completionTokens !== null) {
    const promptTokenDetails = asRecord(value.prompt_tokens_details);
    const cachedTokens = tokenCountOrNull(promptTokenDetails?.cached_tokens);
    return {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      ...(cachedTokens !== null ? { cached_input_tokens: cachedTokens } : {}),
    };
  }

  return null;
}

function tokenCountOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function extractTextContent(value: unknown): string | null {
  const parts: string[] = [];

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.length > 0) {
        parts.push(node);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    const record = asRecord(node);
    if (!record) {
      return;
    }

    const nodeType = typeof record.type === "string" ? record.type : "";
    if (
      nodeType === "tool_use" ||
      nodeType === "tool_result" ||
      nodeType === "thinking" ||
      nodeType === "redacted_thinking"
    ) {
      return;
    }

    if (record.content !== undefined) {
      visit(record.content);
      return;
    }

    if (record.message !== undefined) {
      visit(record.message);
      return;
    }

    if (typeof record.text === "string" && record.text.length > 0) {
      parts.push(record.text);
    }
  };

  visit(value);
  if (parts.length === 0) {
    return null;
  }

  return parts.join("");
}
