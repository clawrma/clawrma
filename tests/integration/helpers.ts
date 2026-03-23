import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  getBalance,
  registerAccount,
  submitTask,
  type TaskResult,
} from "../../src/client.js";
import { DEFAULT_API_BASE_URL } from "../../src/constants.js";
import { isRecord } from "../../src/guards.js";
import type { TaskPayloadMap, TaskType } from "../../src/types.js";

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_WS_ACK_TIMEOUT_MS = 8_000;

export const LIVE_API_BASE_URL =
  process.env.CLAWRMA_LIVE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
export const RUN_LIVE_INTEGRATION =
  process.env.CLAWRMA_RUN_LIVE_INTEGRATION === "1";
export const CAN_RUN_LIVE_INTEGRATION =
  RUN_LIVE_INTEGRATION && process.platform !== "win32";

export interface LiveAccount {
  accountId: string;
  apiKey: string;
}

export interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface SubmitLiveTaskOptions extends RetryOptions {
  operationName?: string;
}

export interface SolverCapability {
  taskType: TaskType;
  tier?: string;
  billingType?: string;
  fulfillmentPath?: "api" | "cli" | "cli_codex";
  providerName?: string;
  modelName?: string;
  marginalCost?: number;
  minPricePoints?: number;
  maxConcurrent?: number;
}

export interface SolverTaskAssignment {
  taskId: string;
  taskType: string;
  payload: Record<string, unknown>;
  pricePoints: string;
}

export interface SolverTaskResolution {
  result?: Record<string, unknown>;
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
}

export type SolverTaskHandler = (
  assignment: SolverTaskAssignment,
) => Promise<SolverTaskResolution> | SolverTaskResolution;

export interface StartLiveSolverOptions {
  capabilities: readonly SolverCapability[];
  onTaskAssignment: SolverTaskHandler;
  isIdleOnPong?: boolean;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
}

export interface LiveSolverController {
  account: LiveAccount;
  pause(reason?: string): Promise<void>;
  resume(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
  assignmentCount(): number;
}

interface SolverConnectState {
  socket: WebSocket | null;
  subscriptions: Array<Record<string, unknown>>;
  assignmentCounter: number;
}

interface ErrorWithStatus extends Error {
  status?: number;
}

function isLocalhostApiBaseUrl(apiBaseUrl: string): boolean {
  try {
    const parsed = new URL(apiBaseUrl);
    return parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function extractErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const candidate = error as ErrorWithStatus;
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  return null;
}

function isTlsConfigurationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("self signed") ||
    message.includes("unable to verify") ||
    message.includes("certificate") ||
    message.includes("tls")
  );
}

function withDiagnostics(error: unknown, operationName: string): Error {
  const baseError = asError(error);
  const status = extractErrorStatus(baseError);
  const hints: string[] = [];

  if (status === 503 || baseError.message.includes("no_solvers_available")) {
    hints.push(
      "Solver appears unavailable. Ensure a solver is connected (run `./test.sh status`).",
    );
  }

  if (isTlsConfigurationError(baseError)) {
    hints.push(
      "TLS trust issue for test cert. Ensure NODE_TLS_REJECT_UNAUTHORIZED=0 is set.",
    );
  }

  if (hints.length === 0) {
    return baseError;
  }

  return new Error(
    `${operationName} failed: ${baseError.message}\nHint: ${hints.join(" ")}`,
    {
      cause: baseError,
    },
  );
}

function defaultRetryPredicate(error: unknown): boolean {
  const status = extractErrorStatus(error);
  if (status === null) {
    return true;
  }
  return status >= 500 || status === 429;
}

function toPayloadRecord(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) {
    return payload;
  }
  return {};
}

function parseRawSocketMessage(
  rawData: RawData,
): Record<string, unknown> | null {
  const rawText =
    typeof rawData === "string"
      ? rawData
      : Buffer.isBuffer(rawData)
        ? rawData.toString("utf8")
        : Array.isArray(rawData)
          ? Buffer.concat(rawData).toString("utf8")
          : Buffer.from(rawData).toString("utf8");

  try {
    const parsed: unknown = JSON.parse(rawText);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildSolverWebSocketUrl(
  apiBaseUrl: string = LIVE_API_BASE_URL,
): string {
  const parsed = new URL(apiBaseUrl);
  const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${parsed.host}/v1/solver/connect`;
}

function buildSocketOptions(apiKey: string): ClientOptions {
  const options: ClientOptions = {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };

  if (
    isLocalhostApiBaseUrl(LIVE_API_BASE_URL) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  ) {
    options.rejectUnauthorized = false;
  }

  return options;
}

async function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting ${timeoutMs}ms for solver websocket open.`,
        ),
      );
    }, timeoutMs);

    const onOpen = (): void => {
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      reject(
        new Error(
          `Solver websocket closed before open (code=${code}, reason=${reason.toString("utf8") || "<empty>"}).`,
        ),
      );
    };

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function waitForSocketMessage(
  socket: WebSocket,
  matcher: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for ${label}.`));
    }, timeoutMs);

    const onMessage = (rawData: RawData): void => {
      const parsed = parseRawSocketMessage(rawData);
      if (!parsed) {
        return;
      }

      try {
        if (!matcher(parsed)) {
          return;
        }
      } catch (error: unknown) {
        cleanup();
        reject(asError(error));
        return;
      }

      cleanup();
      resolve(parsed);
    };

    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      reject(
        new Error(
          `Solver websocket closed while waiting for ${label} (code=${code}, reason=${reason.toString("utf8") || "<empty>"}).`,
        ),
      );
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

async function closeSocket(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeoutId = setTimeout(() => {
      socket.terminate();
      resolve();
    }, timeoutMs);

    socket.once("close", () => {
      clearTimeout(timeoutId);
      resolve();
    });

    socket.close();
  });
}

function createSubscribePayload(
  capability: SolverCapability,
  index: number,
): Record<string, unknown> {
  const providerSuffix = randomUUID().slice(0, 8);
  return {
    task_type: capability.taskType,
    tier: capability.tier ?? "strong",
    billing_type: capability.billingType ?? "subscription",
    fulfillment_path: capability.fulfillmentPath ?? "api",
    provider_name:
      capability.providerName ??
      `integration-${capability.taskType}-${index + 1}-${providerSuffix}`,
    model_name: capability.modelName ?? `integration-${capability.taskType}`,
    marginal_cost: capability.marginalCost ?? 0,
    min_price_points: capability.minPricePoints ?? 0,
    max_concurrent: capability.maxConcurrent ?? 1,
  };
}

function parseTaskAssignmentMessage(
  message: Record<string, unknown>,
): SolverTaskAssignment | null {
  if (message.type !== "task_assignment") {
    return null;
  }

  const taskId = message.task_id;
  const taskType = message.task_type;
  const payload = message.payload;
  const pricePoints = message.price_points;

  if (typeof taskId !== "string" || typeof taskType !== "string") {
    return null;
  }

  return {
    taskId,
    taskType,
    payload: toPayloadRecord(payload),
    pricePoints: typeof pricePoints === "string" ? pricePoints : "",
  };
}

function parseSocketErrorMessage(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "error") {
    return null;
  }
  const error = message.error;
  return typeof error === "string" && error ? error : "socket_error";
}

async function sendJsonMessage(
  socket: WebSocket,
  payload: Record<string, unknown>,
): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Solver websocket is not open.");
  }

  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(payload), (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sendAndWaitForAck(
  socket: WebSocket,
  payload: Record<string, unknown>,
  expectedAckType: string,
  timeoutMs: number,
  operationName: string,
): Promise<void> {
  const waitPromise = waitForSocketMessage(
    socket,
    (message) => {
      const socketError = parseSocketErrorMessage(message);
      if (socketError) {
        throw new Error(`${operationName} rejected by API: ${socketError}`);
      }
      return message.type === expectedAckType;
    },
    timeoutMs,
    `${operationName} ack (${expectedAckType})`,
  );

  await sendJsonMessage(socket, payload);
  await waitPromise;
}

async function openSolverSocket(
  apiKey: string,
  connectTimeoutMs: number,
): Promise<WebSocket> {
  const socket = new WebSocket(
    buildSolverWebSocketUrl(),
    buildSocketOptions(apiKey),
  );
  await waitForSocketOpen(socket, connectTimeoutMs);
  return socket;
}

function startSocketMessageLoop(
  state: SolverConnectState,
  onTaskAssignment: SolverTaskHandler,
  isIdleOnPong: boolean,
): void {
  const socket = state.socket;
  if (!socket) {
    return;
  }

  socket.on("message", (rawData: RawData) => {
    const parsed = parseRawSocketMessage(rawData);
    if (!parsed) {
      return;
    }

    if (parsed.type === "ping") {
      void sendJsonMessage(socket, {
        type: "pong",
        is_idle: isIdleOnPong,
      }).catch(() => {
        // Ignore ping-pong failures; reconnect tests intentionally close sockets.
      });
      return;
    }

    const assignment = parseTaskAssignmentMessage(parsed);
    if (!assignment) {
      return;
    }

    state.assignmentCounter += 1;

    void Promise.resolve(onTaskAssignment(assignment))
      .then(async (resolution) => {
        if (resolution.error) {
          await sendJsonMessage(socket, {
            type: "task_error",
            task_id: assignment.taskId,
            error: resolution.error,
          });
          return;
        }

        await sendJsonMessage(socket, {
          type: "task_complete",
          task_id: assignment.taskId,
          result: resolution.result ?? {},
          ...(assignment.taskType === "llm_inference"
            ? {
                usage: resolution.usage ?? {
                  input_tokens: 1200,
                  output_tokens: 340,
                },
              }
            : {}),
        });
      })
      .catch(async (error: unknown) => {
        await sendJsonMessage(socket, {
          type: "task_error",
          task_id: assignment.taskId,
          error: asError(error).message,
        });
      });
  });
}

async function connectSolver(
  account: LiveAccount,
  state: SolverConnectState,
  options: StartLiveSolverOptions,
): Promise<void> {
  state.socket = await openSolverSocket(
    account.apiKey,
    options.connectTimeoutMs ?? DEFAULT_WS_CONNECT_TIMEOUT_MS,
  );

  startSocketMessageLoop(
    state,
    options.onTaskAssignment,
    options.isIdleOnPong ?? true,
  );

  await sendAndWaitForAck(
    state.socket,
    {
      type: "subscribe",
      capabilities: state.subscriptions,
    },
    "subscribe_ack",
    options.ackTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS,
    "subscribe",
  );
}

export async function retryWithBackoff<T>(
  operationName: string,
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const shouldRetry = options.shouldRetry ?? defaultRetryPredicate;

  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < attempts) {
    try {
      return await operation();
    } catch (error: unknown) {
      const diagnosticError = withDiagnostics(error, operationName);
      lastError = diagnosticError;
      attempt += 1;

      if (attempt >= attempts || !shouldRetry(error)) {
        throw diagnosticError;
      }

      const backoffMs = initialDelayMs * 2 ** (attempt - 1);
      await delay(backoffMs);
    }
  }

  throw (
    lastError ?? new Error(`${operationName} failed without an explicit error.`)
  );
}

export async function pollUntil<T>(
  operationName: string,
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  let lastValue: T | null = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const value = await probe();
      lastValue = value;
      if (predicate(value)) {
        return value;
      }
    } catch (error: unknown) {
      throw withDiagnostics(error, operationName);
    }
    await delay(intervalMs);
  }

  throw new Error(
    `${operationName} timed out after ${timeoutMs}ms. Last probe value: ${JSON.stringify(lastValue)}`,
  );
}

export function isNoSolverAvailableError(error: unknown): boolean {
  const status = extractErrorStatus(error);
  if (status === 503) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("no_solvers_available");
}

export async function createLiveAccount(
  options: RetryOptions = {},
): Promise<LiveAccount> {
  return retryWithBackoff(
    "register_account",
    async () => registerAccount(LIVE_API_BASE_URL),
    options,
  );
}

export async function bootstrapLiveAccounts(
  count: number,
  options: RetryOptions = {},
): Promise<LiveAccount[]> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(
      `bootstrapLiveAccounts requires a positive integer count (received ${count}).`,
    );
  }

  const accounts: LiveAccount[] = [];
  for (let index = 0; index < count; index += 1) {
    accounts.push(await createLiveAccount(options));
  }
  return accounts;
}

export async function getLiveBalanceValue(apiKey: string): Promise<number> {
  return retryWithBackoff("get_balance", async () => {
    const balance = await getBalance(LIVE_API_BASE_URL, apiKey);
    return balance.balance;
  });
}

export async function waitForBalanceDrop(
  apiKey: string,
  initialBalance: number,
  minimumDrop: number,
  options: PollOptions = {},
): Promise<number> {
  if (minimumDrop <= 0) {
    throw new Error(
      `minimumDrop must be greater than 0 (received ${minimumDrop}).`,
    );
  }

  return pollUntil(
    "wait_for_balance_drop",
    () => getLiveBalanceValue(apiKey),
    (balance) => initialBalance - balance >= minimumDrop - 1e-9,
    options,
  );
}

export async function submitLiveTask<T extends TaskType>(
  apiKey: string,
  taskType: T,
  payload: TaskPayloadMap[T],
  options: SubmitLiveTaskOptions = {},
): Promise<TaskResult<T>> {
  const operationName = options.operationName ?? `submit_${taskType}`;

  return retryWithBackoff(
    operationName,
    async () => {
      const result = await submitTask(
        LIVE_API_BASE_URL,
        apiKey,
        taskType,
        payload as Record<string, unknown>,
      );
      return result;
    },
    {
      attempts: options.attempts,
      initialDelayMs: options.initialDelayMs,
      shouldRetry: options.shouldRetry,
    },
  );
}

export async function startLiveSolver(
  options: StartLiveSolverOptions,
): Promise<LiveSolverController> {
  if (options.capabilities.length === 0) {
    throw new Error("startLiveSolver requires at least one capability.");
  }

  const account = await createLiveAccount();
  const state: SolverConnectState = {
    socket: null,
    subscriptions: options.capabilities.map((capability, index) =>
      createSubscribePayload(capability, index),
    ),
    assignmentCounter: 0,
  };

  const connect = async (): Promise<void> => {
    await connectSolver(account, state, options);
  };

  const ensureSocket = (): WebSocket => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Solver websocket is not connected.");
    }
    return state.socket;
  };

  await connect();

  return {
    account,
    pause: async (reason?: string): Promise<void> => {
      await sendAndWaitForAck(
        ensureSocket(),
        {
          type: "pause",
          ...(reason ? { reason } : {}),
        },
        "pause_ack",
        options.ackTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS,
        "pause",
      );
    },
    resume: async (): Promise<void> => {
      await sendAndWaitForAck(
        ensureSocket(),
        { type: "resume" },
        "resume_ack",
        options.ackTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS,
        "resume",
      );
    },
    disconnect: async (): Promise<void> => {
      if (!state.socket) {
        return;
      }
      const socket = state.socket;
      state.socket = null;
      await closeSocket(
        socket,
        options.ackTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS,
      );
    },
    reconnect: async (): Promise<void> => {
      if (state.socket) {
        await closeSocket(
          state.socket,
          options.ackTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS,
        );
        state.socket = null;
      }
      await connect();
    },
    close: async (): Promise<void> => {
      if (!state.socket) {
        return;
      }
      const socket = state.socket;
      state.socket = null;
      await closeSocket(
        socket,
        options.ackTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS,
      );
    },
    assignmentCount: (): number => state.assignmentCounter,
  };
}

export async function withLiveSolver<T>(
  options: StartLiveSolverOptions,
  run: (controller: LiveSolverController) => Promise<T>,
): Promise<T> {
  const solver = await startLiveSolver(options);
  try {
    return await run(solver);
  } finally {
    await solver.close();
  }
}
