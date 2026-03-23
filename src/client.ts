import { DEFAULT_API_BASE_URL } from "./constants.js";
import { isRecord } from "./guards.js";
import { scanPrompt } from "./safety/scan.js";
import type { ScanFlag } from "./safety/scan.js";
import type {
  ApiError,
  SolverCapability,
  TaskPayloadMap,
  TaskResultMap,
  TaskType,
} from "./types.js";

export interface StatusResponse {
  balance: number;
  solverState: {
    activeTasks: number;
    tasksSolvedToday: number;
    tasksSolvedTotal: number;
    earningsToday: number;
    earningsTotal: number;
    paused: boolean | null;
    connected: boolean | null;
  };
  recentActivity: {
    tasksSolvedToday: number;
    earningsToday: number;
  };
  uptimeSeconds: number | null;
  capabilities: SolverCapability[];
}

export type SubmitTaskResultMap = TaskResultMap;

export type TaskResult<T extends TaskType = TaskType> = TaskResultMap[T];

/**
 * Chat message payload for the OpenAI-compatible inference endpoint.
 */
export interface InferenceChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Request body for the OpenAI-compatible inference endpoint.
 */
export interface InferenceChatRequest {
  model: string;
  stream: boolean;
  messages: InferenceChatMessage[];
}

/**
 * Request body for account settings updates.
 */
export interface AccountSettingsUpdate {
  prompt_safety_scan: boolean;
}

const AUTHORIZATION_HEADER = "Authorization";

/** Register a new account and receive an API key. */
export async function registerAccount(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
): Promise<{ accountId: string; apiKey: string }> {
  const data = await requestJson<Record<string, unknown>>(
    `${apiBaseUrl}/v1/register`,
    {
      method: "POST",
    },
  );

  const accountId = asString(data.account_id);
  const apiKey = asString(data.api_key);
  if (!accountId || !apiKey) {
    throw new Error(
      "Invalid register response: missing account_id or api_key.",
    );
  }
  return { accountId, apiKey };
}

/** Fetch the current account balance in points. */
export async function getBalance(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
  apiKey: string,
): Promise<{ balance: number }> {
  const data = await requestJson<Record<string, unknown>>(
    `${apiBaseUrl}/v1/balance`,
    {
      method: "GET",
      headers: withApiKey(apiKey),
    },
  );

  const balance = parseBalance(data);
  return { balance };
}

/** Fetch account balance, solver stats, and registered capabilities. */
export async function getStatus(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
  apiKey: string,
): Promise<StatusResponse> {
  const [balanceResponse, statsResponse, capabilities] = await Promise.all([
    getBalance(apiBaseUrl, apiKey),
    requestJson<Record<string, unknown>>(`${apiBaseUrl}/v1/solver/stats`, {
      method: "GET",
      headers: withApiKey(apiKey),
    }),
    getCapabilities(apiBaseUrl, apiKey),
  ]);

  const solverState = {
    activeTasks: parseNumber(statsResponse.active_tasks),
    tasksSolvedToday: parseNumber(statsResponse.tasks_solved_today),
    tasksSolvedTotal: parseNumber(statsResponse.tasks_solved_total),
    earningsToday: parseMoney(statsResponse.earnings_today),
    earningsTotal: parseMoney(statsResponse.earnings_total),
    paused: parseOptionalBoolean(
      statsResponse.paused ?? statsResponse.is_paused,
    ),
    connected: parseOptionalBoolean(
      statsResponse.connected ?? statsResponse.is_connected,
    ),
  };

  return {
    balance: balanceResponse.balance,
    solverState,
    recentActivity: {
      tasksSolvedToday: solverState.tasksSolvedToday,
      earningsToday: solverState.earningsToday,
    },
    uptimeSeconds: null,
    capabilities,
  };
}

/** Fetch the solver capabilities registered for this account. */
export async function getCapabilities(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
  apiKey: string,
): Promise<SolverCapability[]> {
  const endpoints = ["/v1/solver/capabilities", "/v1/capabilities"] as const;

  for (const endpoint of endpoints) {
    try {
      const payload = await requestJson<unknown>(`${apiBaseUrl}${endpoint}`, {
        method: "GET",
        headers: withApiKey(apiKey),
      });
      const capabilities = parseCapabilitiesPayload(payload);
      return capabilities;
    } catch (error: unknown) {
      if (isStatusError(error, 404) || isStatusError(error, 405)) {
        continue;
      }
      throw error;
    }
  }

  return [];
}

/** Update account-level settings such as prompt safety scanning. */
export async function updateAccountSettings(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
  apiKey: string,
  settings: AccountSettingsUpdate,
): Promise<AccountSettingsUpdate> {
  return requestJson<AccountSettingsUpdate>(
    `${apiBaseUrl}/v1/account/settings`,
    {
      method: "PATCH",
      headers: withApiKey(apiKey),
      body: JSON.stringify(settings),
    },
  );
}

/** Submit a task to the solver network and wait for the result. */
export async function submitTask<T extends TaskType>(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
  apiKey: string,
  taskType: T,
  payload: TaskPayloadMap[T],
  skipSafetyScan = false,
): Promise<TaskResult<T>> {
  validateTaskPayload(taskType, payload as Record<string, unknown>);
  if (!skipSafetyScan) {
    const flags = scanPayloadStrings(payload);
    if (flags.length > 0) {
      const labels = flags.map((flag) => flag.label).join(", ");
      throw new Error(
        `Sensitive content detected (${labels}). Task not submitted. Disable local scan with: npx clawrma config set promptSafetyScan false`,
      );
    }
  }
  const endpoint = taskEndpoint(taskType);
  const result = await requestJson<TaskResult<T>>(`${apiBaseUrl}${endpoint}`, {
    method: "POST",
    headers: withApiKey(apiKey),
    body: JSON.stringify(payload),
  });
  return result;
}

/**
 * Send an OpenAI-compatible chat completion request to the Clawrma inference endpoint.
 */
export async function requestChatCompletions(
  apiBaseUrl: string = DEFAULT_API_BASE_URL,
  apiKey: string,
  payload: InferenceChatRequest,
): Promise<Response> {
  return requestResponse(buildInferenceEndpoint(apiBaseUrl), {
    method: "POST",
    headers: withApiKey(apiKey),
    body: JSON.stringify(payload),
  });
}

/** Truncate an API key to a safe preview like `abcd…wxyz`. */
export function truncateKey(key: string): string {
  if (key.length <= 8) {
    return key;
  }
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function taskEndpoint(taskType: TaskType): string {
  const map: Record<TaskType, string> = {
    proxy_fetch: "/v1/fetch",
    screenshot: "/v1/screenshot",
    page_snapshot: "/v1/snapshot",
    web_search: "/v1/search",
    llm_inference: "/v1/inference",
  };
  return map[taskType];
}

function buildInferenceEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/v1/inference/chat/completions`;
}

function withApiKey(apiKey: string): HeadersInit {
  return {
    [AUTHORIZATION_HEADER]: `Bearer ${apiKey}`,
  };
}

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await requestResponse(url, init);
  const payload = (await response.json()) as T;
  return payload;
}

async function requestResponse(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    DEFAULT_FETCH_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `API request to ${url} timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw await buildApiError(response);
  }

  return response;
}

async function buildApiError(response: Response): Promise<Error> {
  const fallbackType = statusType(response.status);
  const fallbackMessage = `API request failed with status ${response.status}`;

  let apiError: ApiError = {
    error: {
      type: fallbackType,
      message: fallbackMessage,
    },
  };

  try {
    const raw = (await response.json()) as unknown;
    if (isApiErrorPayload(raw)) {
      apiError = raw;
    } else if (isStandardFailureEnvelope(raw)) {
      apiError = {
        status: raw.status,
        charged: raw.charged,
        elapsed_ms: raw.elapsed_ms,
        error: {
          type: raw.error.type,
          category: raw.error.category,
          message: raw.error.detail,
          detail: raw.error.detail,
        },
      };
    } else if (isRecord(raw) && typeof raw.detail === "string") {
      apiError = {
        error: {
          type: fallbackType,
          message: raw.detail,
        },
      };
    }
  } catch {
    // Keep fallback payload.
  }

  const error = new Error(apiError.error.message);
  (error as Error & { apiError: ApiError; status: number }).apiError = apiError;
  (error as Error & { apiError: ApiError; status: number }).status =
    response.status;
  return error;
}

function statusType(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "invalid_payload";
    case 402:
      return "insufficient_balance";
    case 503:
      return "no_solver";
    case 504:
      return "timeout";
    default:
      return "request_failed";
  }
}

function parseBalance(payload: Record<string, unknown>): number {
  const value = payload.available ?? payload.balance;
  return parseMoney(value);
}

function parseMoney(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function isApiErrorPayload(value: unknown): value is ApiError {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.type === "string" &&
    typeof value.error.message === "string"
  );
}

function isStandardFailureEnvelope(value: unknown): value is {
  status: string;
  charged: boolean;
  elapsed_ms: number;
  error: {
    type: string;
    category: string;
    detail: string;
  };
} {
  return (
    isRecord(value) &&
    value.status === "FAILED" &&
    typeof value.charged === "boolean" &&
    typeof value.elapsed_ms === "number" &&
    isRecord(value.error) &&
    typeof value.error.type === "string" &&
    typeof value.error.category === "string" &&
    typeof value.error.detail === "string"
  );
}

function parseCapabilitiesPayload(value: unknown): SolverCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const capabilities: SolverCapability[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const taskType = entry.task_type;
    const billingType = entry.billing_type;
    const fulfillmentPath = entry.fulfillment_path;
    const providerName = entry.provider_name;
    const modelName = entry.model_name;

    if (
      typeof taskType === "string" &&
      typeof billingType === "string" &&
      typeof fulfillmentPath === "string" &&
      typeof providerName === "string" &&
      typeof modelName === "string" &&
      providerName.length > 0 &&
      modelName.length > 0
    ) {
      capabilities.push({
        task_type: taskType as TaskType,
        billing_type: billingType as SolverCapability["billing_type"],
        fulfillment_path:
          fulfillmentPath as SolverCapability["fulfillment_path"],
        provider_name: providerName,
        model_name: modelName,
      });
    }
  }

  return capabilities;
}

function isStatusError(error: unknown, status: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & { status?: unknown };
  return typeof candidate.status === "number" && candidate.status === status;
}

function validateTaskPayload(
  taskType: TaskType,
  payload: Record<string, unknown>,
): void {
  if (
    taskType !== "proxy_fetch" &&
    taskType !== "screenshot" &&
    taskType !== "page_snapshot"
  ) {
    return;
  }

  const rawUrl = payload.url;
  if (typeof rawUrl !== "string") {
    throw new Error(`Task '${taskType}' payload must include a URL string.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `Invalid URL '${rawUrl}'. Expected http:// or https:// URL.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL protocol '${parsed.protocol}'. Use http:// or https://.`,
    );
  }

  if (taskType === "proxy_fetch") {
    const rawHtml = payload.raw_html;
    if (rawHtml !== undefined && typeof rawHtml !== "boolean") {
      throw new Error(
        "Task 'proxy_fetch' payload field 'raw_html' must be a boolean when provided.",
      );
    }
  }
}

function scanPayloadStrings(value: unknown): ScanFlag[] {
  const flags: ScanFlag[] = [];
  const seenRuleIds = new Set<string>();

  collectScanFlags(value, flags, seenRuleIds);

  return flags;
}

function collectScanFlags(
  value: unknown,
  flags: ScanFlag[],
  seenRuleIds: Set<string>,
): void {
  if (typeof value === "string") {
    for (const flag of scanPrompt(value)) {
      if (!seenRuleIds.has(flag.ruleId)) {
        seenRuleIds.add(flag.ruleId);
        flags.push(flag);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectScanFlags(entry, flags, seenRuleIds);
    }
    return;
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectScanFlags(entry, flags, seenRuleIds);
    }
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
