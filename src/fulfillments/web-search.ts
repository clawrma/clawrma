import { solverLogger } from "../logging.js";
import {
  BUILT_IN_SEARCH_PROVIDERS,
  readNormalizedEnv,
} from "../search/builtins.js";
import type { SolverCapability, TaskType } from "../types.js";

const BRAVE_API_KEY_ENV_VAR = "BRAVE_API_KEY";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_WEB_SEARCH_RESULT_COUNT = 5;
const MAX_WEB_SEARCH_RESULT_COUNT = 10;

interface WebSearchTaskPayload {
  query?: unknown;
  count?: unknown;
}

interface ParsedWebSearchPayload {
  query: string;
  count: number;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const BRAVE_SEARCH_PROVIDER = BUILT_IN_SEARCH_PROVIDERS.find((provider) =>
  provider.envVarNames.includes(BRAVE_API_KEY_ENV_VAR),
);

if (!BRAVE_SEARCH_PROVIDER) {
  throw new Error("Built-in Brave Search provider metadata is missing.");
}

/**
 * Context used to detect whether a local web-search fulfiller is runnable.
 */
export interface WebSearchDetectContext {
  taskTypes: readonly TaskType[];
}

/**
 * Context used to fulfill a web-search task.
 */
export interface WebSearchFulfillContext {
  fetchImpl: typeof fetch;
  fetchTimeoutMs: number;
}

/**
 * Runtime-owned outward error categories surfaced from a web-search fulfiller.
 */
export type WebSearchErrorCategory = "timeout";

/**
 * Typed error thrown by web-search fulfillers so the solver runtime can map
 * outward task errors without reimplementing provider-specific logic.
 */
export class WebSearchFulfillmentError extends Error {
  public readonly category: WebSearchErrorCategory | null;

  constructor(
    message: string,
    options: { category?: WebSearchErrorCategory } = {},
  ) {
    super(message);
    this.name = "WebSearchFulfillmentError";
    this.category = options.category ?? null;
  }
}

/**
 * Contract for a concrete web-search fulfiller implementation.
 */
export interface WebSearchFulfiller {
  detect(context: WebSearchDetectContext): SolverCapability | null;
  fulfill(
    payload: unknown,
    context: WebSearchFulfillContext,
  ): Promise<{ query: string; results: WebSearchResult[] }>;
}

/**
 * Built-in Brave Search fulfiller used by the local solver runtime.
 */
export const braveSearchFulfiller: WebSearchFulfiller = {
  detect(context) {
    if (!context.taskTypes.includes("web_search")) {
      return null;
    }

    const braveApiKey = readNormalizedEnv(BRAVE_API_KEY_ENV_VAR);
    if (!braveApiKey) {
      solverLogger.info(
        {
          taskTypes: context.taskTypes,
        },
        "solver_web_search_capability_omitted_missing_brave_api_key",
      );
      return null;
    }

    return {
      task_type: "web_search",
      billing_type: BRAVE_SEARCH_PROVIDER.billingType,
      fulfillment_path: BRAVE_SEARCH_PROVIDER.fulfillmentPath,
      provider_name: BRAVE_SEARCH_PROVIDER.providerName,
      model_name: BRAVE_SEARCH_PROVIDER.modelName,
    };
  },

  async fulfill(payload, context) {
    const braveApiKey = readNormalizedEnv(BRAVE_API_KEY_ENV_VAR);
    if (!braveApiKey) {
      throw new WebSearchFulfillmentError(
        "web_search is unavailable because BRAVE_API_KEY is not configured.",
      );
    }

    const parsedPayload = parseWebSearchPayload(payload);
    const requestUrl = new URL(BRAVE_SEARCH_URL);
    requestUrl.searchParams.set("q", parsedPayload.query);
    requestUrl.searchParams.set("count", String(parsedPayload.count));

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      context.fetchTimeoutMs,
    );

    try {
      const response = await context.fetchImpl(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": braveApiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = (await response.text()).slice(0, 400);
        throw new WebSearchFulfillmentError(
          `Brave Search returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`,
        );
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        throw new WebSearchFulfillmentError(
          "Brave Search returned invalid JSON.",
        );
      }

      return normalizeBraveSearchResponse(
        responseBody,
        parsedPayload.query,
        parsedPayload.count,
      );
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new WebSearchFulfillmentError(
          `web_search timed out after ${context.fetchTimeoutMs}ms.`,
          {
            category: "timeout",
          },
        );
      }

      if (error instanceof WebSearchFulfillmentError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new WebSearchFulfillmentError(`web_search failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  },
};

/**
 * Default runnable web-search fulfillers shipped in the package.
 */
export const defaultWebSearchFulfillers: WebSearchFulfiller[] = [
  braveSearchFulfiller,
];

function parseWebSearchPayload(value: unknown): ParsedWebSearchPayload {
  const payload = asRecord(value) as WebSearchTaskPayload | null;
  if (!payload) {
    throw new WebSearchFulfillmentError(
      "web_search payload must be an object.",
    );
  }

  const query = typeof payload.query === "string" ? payload.query.trim() : "";
  if (!query) {
    throw new WebSearchFulfillmentError(
      "web_search payload must include a non-empty query.",
    );
  }

  const countValue = payload.count ?? DEFAULT_WEB_SEARCH_RESULT_COUNT;
  if (typeof countValue !== "number" || !Number.isInteger(countValue)) {
    throw new WebSearchFulfillmentError(
      "web_search payload count must be an integer.",
    );
  }

  if (countValue < 1 || countValue > MAX_WEB_SEARCH_RESULT_COUNT) {
    throw new WebSearchFulfillmentError(
      `web_search payload count must be between 1 and ${MAX_WEB_SEARCH_RESULT_COUNT}.`,
    );
  }

  return {
    query,
    count: countValue,
  };
}

function normalizeBraveSearchResponse(
  value: unknown,
  query: string,
  count: number,
): { query: string; results: WebSearchResult[] } {
  const payload = asRecord(value);
  if (!payload) {
    throw new WebSearchFulfillmentError(
      "Brave Search response was not a JSON object.",
    );
  }

  const webData = asRecord(payload.web);
  const results = Array.isArray(webData?.results) ? webData.results : [];
  const normalized: WebSearchResult[] = [];

  for (const item of results) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    normalized.push({
      title: typeof record.title === "string" ? record.title : "",
      url: typeof record.url === "string" ? record.url : "",
      snippet: typeof record.description === "string" ? record.description : "",
    });

    if (normalized.length >= count) {
      break;
    }
  }

  return {
    query,
    results: normalized,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
