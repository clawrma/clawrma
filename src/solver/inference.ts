import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createInterface } from "node:readline";
import { readOpenClawConfig } from "../integrations/openclaw.js";
import type { FrameworkType } from "../types.js";
import { asRecord } from "./assignments.js";
import type {
  InferenceMessage,
  LlmTaskPayload,
  ProviderRuntimeConfig,
  TaskUsage,
} from "./contracts.js";

class InferenceExecutionError extends Error {}

/**
 * Normalized chunk content emitted by all inference executors.
 */
export interface InferenceChunk {
  content: string;
  finish_reason?: string;
}

/**
 * Final success payload returned by all inference executors.
 */
export interface InferenceExecutionResult {
  usage: TaskUsage;
}

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
  payload: LlmTaskPayload;
  modelName: string;
  spawnImpl: SpawnImpl;
  cliTimeoutMs: number;
  onChunk: (chunk: InferenceChunk) => void;
}

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
    const content = typeof record.content === "string" ? record.content : "";
    if (!role || !content) {
      continue;
    }

    parsed.push({ role, content });
  }

  return parsed.length > 0 ? parsed : null;
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

      const chunk = extractOpenAiChunk(parsed);
      if (!chunk) {
        continue;
      }

      options.onChunk(chunk);
    }

    if (usage === null) {
      throw expectedInferenceError(
        "Provider stream ended without usage metadata.",
      );
    }

    return { usage };
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

  const userPrompt = extractLastUserMessage(messages);
  if (!userPrompt) {
    throw expectedInferenceError(
      "Task payload did not include a user message.",
    );
  }

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
    const systemPrompt = extractSystemPrompt(messages);
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const process = options.spawnImpl("claude", args, {
      stdio: "pipe",
    });

    const stderrPromise = streamToString(process.stderr);

    process.stdin.write(userPrompt);
    process.stdin.end();

    let sawChunk = false;
    let streamError: string | null = null;
    let usage: TaskUsage | null = null;

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

      const chunk = convertClaudeChunk(parsed);
      if (!chunk) {
        const fallback = convertClaudeResultFallback(parsed);
        if (!fallback) {
          continue;
        }

        sawChunk = true;
        options.onChunk(fallback);
        continue;
      }

      sawChunk = true;
      options.onChunk(chunk);
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

    return { usage };
  } catch (error: unknown) {
    if (error instanceof InferenceExecutionError) {
      throw error;
    }

    throw wrapUnexpectedInferenceError("CLI fulfillment failed", error);
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

  const userPrompt = extractLastUserMessage(messages);
  if (!userPrompt) {
    throw expectedInferenceError(
      "Task payload did not include a user message.",
    );
  }

  const systemPrompt = extractSystemPrompt(messages);
  const prompt = systemPrompt
    ? `System instructions:\n${systemPrompt}\n\nUser request:\n${userPrompt}`
    : userPrompt;

  try {
    const startedAt = Date.now();
    const process = options.spawnImpl(
      "codex",
      [
        "exec",
        "--model",
        options.modelName,
        "--json",
        "--skip-git-repo-check",
        "-",
      ],
      {
        stdio: "pipe",
      },
    );

    process.stdin.write(prompt);
    process.stdin.end();

    const stderrPromise = streamToString(process.stderr);
    let sawChunk = false;
    let streamError: string | null = null;
    let usage: TaskUsage | null = null;

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

      const chunk = convertCodexChunk(parsed);
      if (!chunk) {
        continue;
      }

      sawChunk = true;
      options.onChunk(chunk);
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

    return { usage };
  } catch (error: unknown) {
    if (error instanceof InferenceExecutionError) {
      throw error;
    }

    throw wrapUnexpectedInferenceError("Codex CLI fulfillment failed", error);
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

function expectedInferenceError(message: string): InferenceExecutionError {
  return new InferenceExecutionError(message);
}

function extractSystemPrompt(messages: InferenceMessage[]): string | null {
  for (const message of messages) {
    if (message.role === "system" && message.content) {
      return message.content;
    }
  }

  return null;
}

function extractLastUserMessage(messages: InferenceMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user" && message.content) {
      return message.content;
    }
  }

  return null;
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

function extractOpenAiChunk(value: unknown): InferenceChunk | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
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
    return null;
  }

  const first = asRecord(choices[0]);
  if (!first) {
    return null;
  }

  const delta = asRecord(first.delta);
  const content = typeof delta?.content === "string" ? delta.content : "";
  if (!content) {
    return null;
  }

  const finishReason =
    typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  return {
    content,
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
}

function extractOpenAiUsage(value: unknown): TaskUsage | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  return usageFromRecord(asRecord(payload.usage));
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

function wrapUnexpectedInferenceError(prefix: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Error
    ? new Error(`${prefix}: ${message}`, { cause: error })
    : new Error(`${prefix}: ${message}`);
}

function convertClaudeChunk(value: unknown): InferenceChunk | null {
  const payload = asRecord(value);
  if (!payload || payload.type !== "assistant") {
    return null;
  }

  const content =
    extractTextContent(payload.content) ?? extractTextContent(payload.message);
  if (!content) {
    return null;
  }

  const message = asRecord(payload.message);
  const finishReason =
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
      : undefined);

  return {
    content,
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
}

function extractClaudeUsage(value: unknown): TaskUsage | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  return usageFromRecord(asRecord(payload.usage));
}

function convertClaudeResultFallback(value: unknown): InferenceChunk | null {
  const payload = asRecord(value);
  if (!payload || payload.type !== "result") {
    return null;
  }

  const content = extractTextContent(payload.result);
  if (!content) {
    return null;
  }

  return {
    content,
    finish_reason: "stop",
  };
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

function convertCodexChunk(value: unknown): InferenceChunk | null {
  const payload = asRecord(value);
  if (!payload || payload.type !== "item.completed") {
    return null;
  }

  const item = asRecord(payload.item);
  if (!item || item.type !== "agent_message") {
    return null;
  }

  const text = typeof item.text === "string" ? item.text : "";
  if (!text) {
    return null;
  }

  return {
    content: text,
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
