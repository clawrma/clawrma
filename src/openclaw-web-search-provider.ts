import {
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

import { DEFAULT_API_BASE_URL } from "./constants.js";
import { isRecord } from "./guards.js";

const CLAWRMA_PROVIDER_ID = "clawrma";
const CLAWRMA_CREDENTIAL_PATH =
  "plugins.entries.clawrma.config.webSearch.apiKey";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const ClawrmaWebSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string.",
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as unknown as WebSearchProviderToolDefinition["parameters"];

interface ClawrmaWebSearchConfig {
  apiBaseUrl: string;
  apiKey: string | null;
  count: number;
  timeoutSeconds: number | null;
}

interface ParsedSearchArgs {
  query: string;
  count: number;
}

interface ClawrmaSearchResultPayload {
  title: string;
  url: string;
  snippet?: string;
  description?: string;
  siteName?: string;
  published?: string;
  content?: string;
}

/**
 * OpenClaw-facing normalized Clawrma search result.
 */
export interface ClawrmaOpenClawSearchResult {
  [key: string]: unknown;
  title: string;
  url: string;
  description: string;
  siteName?: string;
  published?: string;
  content?: string;
}

/**
 * Firecrawl-style result envelope returned to OpenClaw managed web_search.
 */
export interface ClawrmaOpenClawSearchEnvelope {
  [key: string]: unknown;
  query: string;
  provider: "clawrma";
  count: number;
  tookMs: number;
  externalContent: {
    untrusted: true;
    source: "web_search";
    provider: "clawrma";
    wrapped: true;
  };
  results: ClawrmaOpenClawSearchResult[];
}

/**
 * Create the Clawrma OpenClaw managed web_search provider.
 */
export function createClawrmaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: CLAWRMA_PROVIDER_ID,
    label: "Clawrma Search",
    hint: "Search the web through the Clawrma solver network",
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    credentialLabel: "Clawrma API key",
    envVars: [],
    placeholder: "cr_...",
    signupUrl: "https://github.com/clawrma/clawrma",
    docsUrl: "https://github.com/clawrma/clawrma#readme",
    credentialPath: CLAWRMA_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: CLAWRMA_CREDENTIAL_PATH,
      searchCredential: {
        type: "scoped",
        scopeId: CLAWRMA_PROVIDER_ID,
      },
      configuredCredential: {
        pluginId: CLAWRMA_PROVIDER_ID,
      },
      selectionPluginId: CLAWRMA_PROVIDER_ID,
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using Clawrma. Returns titles, URLs, and descriptions from Clawrma /v1/search.",
      parameters: ClawrmaWebSearchSchema,
      execute: async (args, executionContext) => {
        const config = readClawrmaWebSearchConfig(ctx.config);
        if (!config.apiKey) {
          throw new Error(
            `Clawrma web_search requires ${CLAWRMA_CREDENTIAL_PATH}.`,
          );
        }

        const parsedArgs = parseSearchArgs(args, config.count);
        return await runClawrmaSearch({
          apiBaseUrl: config.apiBaseUrl,
          apiKey: config.apiKey,
          query: parsedArgs.query,
          count: parsedArgs.count,
          timeoutSeconds: config.timeoutSeconds,
          signal: executionContext?.signal,
        });
      },
    }),
  };
}

async function runClawrmaSearch(params: {
  apiBaseUrl: string;
  apiKey: string;
  query: string;
  count: number;
  timeoutSeconds: number | null;
  signal?: AbortSignal;
}): Promise<ClawrmaOpenClawSearchEnvelope> {
  const startedAt = Date.now();
  const abort = buildAbortControls(params.signal, params.timeoutSeconds);

  try {
    const response = await fetch(buildSearchUrl(params.apiBaseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: params.query,
        count: params.count,
      }),
      signal: abort.signal,
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 400);
      throw new Error(
        `Clawrma web_search returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`,
      );
    }

    const payload = await readJsonResponse(response);
    const tookMs = resolveTookMs(payload, Date.now() - startedAt);
    return normalizeClawrmaSearchResponse(payload, {
      query: params.query,
      tookMs,
    });
  } catch (error: unknown) {
    if (abort.timedOut()) {
      throw new Error(
        `Clawrma web_search timed out after ${params.timeoutSeconds} seconds.`,
        { cause: error },
      );
    }

    if (isAbortError(error)) {
      throw new Error("Clawrma web_search was aborted.", { cause: error });
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Clawrma web_search failed: ${String(error)}`, {
      cause: error,
    });
  } finally {
    abort.cleanup();
  }
}

function readClawrmaWebSearchConfig(config: unknown): ClawrmaWebSearchConfig {
  const webSearch = resolvePluginWebSearchConfig(config);

  return {
    apiBaseUrl:
      readOptionalString(webSearch?.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    apiKey: readOptionalString(webSearch?.apiKey) ?? null,
    count: readOptionalCount(webSearch?.count) ?? DEFAULT_SEARCH_COUNT,
    timeoutSeconds: readOptionalTimeoutSeconds(webSearch?.timeoutSeconds),
  };
}

function resolvePluginWebSearchConfig(
  config: unknown,
): Record<string, unknown> | null {
  if (!isRecord(config)) {
    return null;
  }

  const plugins = isRecord(config.plugins) ? config.plugins : null;
  const entries = isRecord(plugins?.entries) ? plugins.entries : null;
  const clawrma = isRecord(entries?.clawrma) ? entries.clawrma : null;
  const pluginConfig = isRecord(clawrma?.config) ? clawrma.config : null;
  return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : null;
}

function parseSearchArgs(
  args: Record<string, unknown>,
  fallbackCount: number,
): ParsedSearchArgs {
  const query = readRequiredString(args.query, "query");
  const count =
    args.count === undefined ? fallbackCount : readRequiredCount(args.count);

  return {
    query,
    count,
  };
}

function normalizeClawrmaSearchResponse(
  value: unknown,
  params: {
    query: string;
    tookMs: number;
  },
): ClawrmaOpenClawSearchEnvelope {
  const payload = requireRecord(value, "Clawrma web_search response");
  const errorMessage = readApiErrorEnvelope(payload);
  if (errorMessage) {
    throw new Error(`Clawrma web_search API error: ${errorMessage}`);
  }

  if (!Array.isArray(payload.results)) {
    throw new Error("Clawrma web_search response missing results array.");
  }

  const results = payload.results.map((item, index) =>
    normalizeSearchResult(item, index),
  );

  return {
    query: params.query,
    provider: CLAWRMA_PROVIDER_ID,
    count: results.length,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: CLAWRMA_PROVIDER_ID,
      wrapped: true,
    },
    results,
  };
}

function normalizeSearchResult(
  value: unknown,
  index: number,
): ClawrmaOpenClawSearchResult {
  const item = requireRecord(value, `Clawrma web_search result ${index}`);
  const payload = readSearchResultPayload(item, index);
  const description = payload.snippet ?? payload.description ?? "";

  return {
    title: wrapWebContent(payload.title, "web_search"),
    url: payload.url,
    description: description ? wrapWebContent(description, "web_search") : "",
    ...(payload.siteName ? { siteName: payload.siteName } : {}),
    ...(payload.published ? { published: payload.published } : {}),
    ...(payload.content
      ? { content: wrapWebContent(payload.content, "web_search") }
      : {}),
  };
}

function readSearchResultPayload(
  item: Record<string, unknown>,
  index: number,
): ClawrmaSearchResultPayload {
  const title = readRequiredString(item.title, `results[${index}].title`);
  const url = readRequiredHttpUrl(item.url, `results[${index}].url`);
  const snippet = readOptionalString(item.snippet);
  const description = readOptionalString(item.description);
  const siteName = readOptionalString(item.siteName);
  const published = readOptionalString(item.published);
  const content = readOptionalString(item.content);

  return {
    title,
    url,
    ...(snippet !== undefined ? { snippet } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(siteName !== undefined ? { siteName } : {}),
    ...(published !== undefined ? { published } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Clawrma web_search returned invalid JSON.");
  }
}

function resolveTookMs(payload: unknown, measuredTookMs: number): number {
  if (!isRecord(payload)) {
    return measuredTookMs;
  }

  return typeof payload.elapsed_ms === "number" &&
    Number.isFinite(payload.elapsed_ms) &&
    payload.elapsed_ms >= 0
    ? payload.elapsed_ms
    : measuredTookMs;
}

function readApiErrorEnvelope(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  if (isRecord(payload.error)) {
    const type = readOptionalString(payload.error.type);
    const message = readOptionalString(payload.error.message);
    if (type && message) {
      return `${type}: ${message}`;
    }
    return message ?? type ?? "unknown_error";
  }

  if (payload.object === "error") {
    return readOptionalString(payload.message) ?? "unknown_error";
  }

  return null;
}

function buildSearchUrl(apiBaseUrl: string): string {
  try {
    return new URL("/v1/search", normalizeApiBaseUrl(apiBaseUrl)).toString();
  } catch {
    throw new Error(
      "plugins.entries.clawrma.config.webSearch.apiBaseUrl must be a valid URL.",
    );
  }
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function buildAbortControls(
  upstreamSignal: AbortSignal | undefined,
  timeoutSeconds: number | null,
): {
  signal?: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  if (!upstreamSignal && timeoutSeconds === null) {
    return {
      signal: undefined,
      cleanup: () => {},
      timedOut: () => false,
    };
  }

  if (timeoutSeconds === null) {
    return {
      signal: upstreamSignal,
      cleanup: () => {},
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1000);

  const abortFromUpstream = (): void => {
    controller.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, {
      once: true,
    });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    },
    timedOut: () => timedOut,
  };
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readRequiredString(value: unknown, path: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new Error(`Clawrma web_search requires ${path} to be a string.`);
  }
  return text;
}

function readRequiredCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Clawrma web_search count must be an integer.");
  }

  if (value < 1 || value > MAX_SEARCH_COUNT) {
    throw new Error(
      `Clawrma web_search count must be between 1 and ${MAX_SEARCH_COUNT}.`,
    );
  }

  return value;
}

function readOptionalCount(value: unknown): number | undefined {
  return value === undefined ? undefined : readRequiredCount(value);
}

function readOptionalTimeoutSeconds(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      "Clawrma web_search timeoutSeconds must be a positive number.",
    );
  }

  return value;
}

function readRequiredHttpUrl(value: unknown, path: string): string {
  const text = readRequiredString(value, path);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Clawrma web_search requires ${path} to be an HTTP URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Clawrma web_search requires ${path} to be an HTTP URL.`);
  }

  return url.toString();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
