import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards.js";
import { setupLogger } from "../logging.js";
import {
  listConfiguredBuiltInSearchProviders,
  normalizeConfiguredString,
} from "../search/builtins.js";
import type { ScheduleWindow } from "../types.js";

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".clawdbot", "clawdbot.json");
const CLAWRMA_FALLBACK_ID = "clawrma/strong";
const CLAWRMA_PROVIDER_ID = "clawrma";
const CLAWRMA_SKILL_ID = "clawrma";
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const END_OF_DAY_MINUTES = 24 * 60;
const END_OF_DAY_RENDER = "23:59";
export interface ProviderInjectionResult {
  injected: boolean;
  fallbackPosition: number;
  fallbackTotal: number;
}

export interface LoadedOpenClawConfig {
  config: Record<string, unknown>;
  path: string;
}

export interface OpenClawProviderConfig {
  name: string;
  endpoint: string;
  apiKey: string;
  token: string;
  modelName: string;
}

export interface OpenClawConfig {
  path: string;
  raw: Record<string, unknown>;
  providers: OpenClawProviderConfig[];
  activeHours: ScheduleWindow[] | null;
  activeHoursTimezone: string | null;
  existingSearchConfig: boolean;
  existingFirecrawlConfig: boolean;
}

type DayName = (typeof DAY_ORDER)[number];

interface DayInterval {
  start: number;
  end: number;
}

interface RpcRequestPayload {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export async function readOpenClawConfig(): Promise<OpenClawConfig | null> {
  const path = await firstExistingPath([
    OPENCLAW_CONFIG_PATH,
    LEGACY_CONFIG_PATH,
  ]);
  if (!path) {
    return null;
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`OpenClaw config at ${path} is not a JSON object.`);
  }

  return {
    path,
    raw: parsed,
    providers: readProvidersFromConfig(parsed),
    activeHours: extractActiveHours(parsed),
    activeHoursTimezone: extractActiveHoursTimezone(parsed),
    existingSearchConfig: hasSearchConfig(parsed),
    existingFirecrawlConfig: hasFirecrawlConfig(parsed),
  };
}

export async function injectProvider(
  gatewayUrl: string,
  gatewayToken: string,
  apiKey: string,
  apiBaseUrl: string,
  preloaded?: LoadedOpenClawConfig,
): Promise<ProviderInjectionResult> {
  try {
    const current = await gatewayRpc(
      gatewayUrl,
      gatewayToken,
      "config.get",
      {},
    );
    const currentConfig = extractRpcConfig(current);
    const existingFallbacks = getFallbacks(currentConfig);
    const alreadyPresent = existingFallbacks.includes(CLAWRMA_FALLBACK_ID);
    const nextFallbacks = alreadyPresent
      ? existingFallbacks
      : [...existingFallbacks, CLAWRMA_FALLBACK_ID];

    const patch: Record<string, unknown> = {
      models: {
        providers: {
          [CLAWRMA_PROVIDER_ID]: buildClawrmaProvider(apiKey, apiBaseUrl),
        },
      },
      skills: {
        entries: {
          [CLAWRMA_SKILL_ID]: {
            env: {
              CLAWRMA_API_KEY: apiKey,
            },
          },
        },
      },
    };

    if (!alreadyPresent) {
      patch.agents = {
        defaults: {
          model: {
            fallbacks: nextFallbacks,
          },
        },
      };
    }

    const patchParams: Record<string, unknown> = {
      raw: JSON.stringify(patch),
    };
    const baseHash = extractRpcHash(current);
    if (baseHash) {
      patchParams.baseHash = baseHash;
    }

    const result = await gatewayRpc(
      gatewayUrl,
      gatewayToken,
      "config.patch",
      patchParams,
    );
    syncPreloadedConfigFromRpc(preloaded, result);
    const resultingFallbacks = getFallbacks(extractRpcConfig(result));
    const fallbackList =
      resultingFallbacks.length > 0 ? resultingFallbacks : nextFallbacks;

    setupLogger.info(
      {
        path: "config.patch",
        injected: !alreadyPresent,
        fallbackPosition: fallbackList.indexOf(CLAWRMA_FALLBACK_ID) + 1,
        fallbackTotal: fallbackList.length,
      },
      "Injected Clawrma provider through OpenClaw Gateway RPC",
    );

    return {
      injected: !alreadyPresent,
      fallbackPosition: fallbackList.indexOf(CLAWRMA_FALLBACK_ID) + 1,
      fallbackTotal: fallbackList.length,
    };
  } catch (error: unknown) {
    setupLogger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        path: "file-edit",
      },
      "OpenClaw Gateway RPC unavailable. Falling back to direct config file edit for provider injection.",
    );
    await refreshPreloadedConfig(preloaded);
    return injectProviderDirect(apiKey, apiBaseUrl, preloaded);
  }
}

export async function writeClawrmaApiKey(
  gatewayUrl: string,
  gatewayToken: string,
  apiKey: string,
): Promise<void> {
  try {
    const current = await gatewayRpc(
      gatewayUrl,
      gatewayToken,
      "config.get",
      {},
    );
    const patch: Record<string, unknown> = {
      skills: {
        entries: {
          [CLAWRMA_SKILL_ID]: {
            env: {
              CLAWRMA_API_KEY: apiKey,
            },
          },
        },
      },
    };

    const params: Record<string, unknown> = {
      raw: JSON.stringify(patch),
    };
    const baseHash = extractRpcHash(current);
    if (baseHash) {
      params.baseHash = baseHash;
    }

    await gatewayRpc(gatewayUrl, gatewayToken, "config.patch", params);
    setupLogger.info(
      { path: "config.patch" },
      "Wrote CLAWRMA_API_KEY to OpenClaw skill env",
    );
    return;
  } catch (error: unknown) {
    setupLogger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        path: "file-edit",
      },
      "OpenClaw Gateway RPC unavailable. Falling back to direct config file edit for CLAWRMA_API_KEY.",
    );
  }

  try {
    const loaded = await loadOpenClawConfigForWrite();
    const skills = ensureRecord(loaded.config, "skills");
    const entries = ensureRecord(skills, "entries");
    const clawrmaSkill = ensureRecord(entries, CLAWRMA_SKILL_ID);
    const env = ensureRecord(clawrmaSkill, "env");
    env.CLAWRMA_API_KEY = apiKey;

    await writeFile(
      loaded.path,
      `${JSON.stringify(loaded.config, null, 2)}\n`,
      "utf8",
    );
  } catch (error: unknown) {
    throw new Error(
      "Failed to write CLAWRMA_API_KEY via OpenClaw RPC and direct config file fallback.",
      { cause: error },
    );
  }
}

export async function injectFirecrawlConfig(
  _gatewayUrl: string,
  _gatewayToken: string,
  _apiKey: string,
  _preloaded?: LoadedOpenClawConfig,
): Promise<boolean> {
  setupLogger.info(
    { path: "disabled" },
    "Firecrawl config injection remains disabled here because Clawrma deferred it while OpenClaw was rejecting tools.web.fetch.firecrawl in schema validation (upstream issues #27833 and #22256); leaving OpenClaw config unchanged",
  );
  return false;
}

export function extractActiveHours(
  config: Record<string, unknown>,
): ScheduleWindow[] | null {
  const value = getNestedValue(config, [
    "agents",
    "defaults",
    "heartbeat",
    "activeHours",
  ]);
  if (!Array.isArray(value)) {
    return null;
  }

  const windows: ScheduleWindow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const start = typeof entry.start === "string" ? entry.start : "";
    const end = typeof entry.end === "string" ? entry.end : "";
    if (!isValidClockTime(start) || !isValidClockTime(end)) {
      continue;
    }

    const normalizedDays: DayName[] = [];
    if (Array.isArray(entry.days)) {
      for (const day of entry.days) {
        if (typeof day !== "string") {
          continue;
        }
        const normalized = normalizeDay(day);
        if (normalized && !normalizedDays.includes(normalized)) {
          normalizedDays.push(normalized);
        }
      }
    }

    if (normalizedDays.length === 0) {
      continue;
    }

    windows.push({
      days: normalizedDays,
      start,
      end,
    });
  }

  return windows.length > 0 ? windows : null;
}

export function extractActiveHoursTimezone(
  config: Record<string, unknown>,
): string | null {
  const fromHeartbeat = getNestedValue(config, [
    "agents",
    "defaults",
    "heartbeat",
    "timezone",
  ]);
  if (typeof fromHeartbeat === "string" && fromHeartbeat.length > 0) {
    return fromHeartbeat;
  }

  const fromAgents = getNestedValue(config, ["agents", "defaults", "timezone"]);
  if (typeof fromAgents === "string" && fromAgents.length > 0) {
    return fromAgents;
  }

  return null;
}

export function invertActiveHoursToSolverWindows(
  activeHours: ScheduleWindow[],
): ScheduleWindow[] {
  if (activeHours.length === 0) {
    return [{ days: [...DAY_ORDER], start: "00:00", end: END_OF_DAY_RENDER }];
  }

  const activeIntervalsByDay = new Map<DayName, DayInterval[]>(
    DAY_ORDER.map((day) => [day, [] as DayInterval[]]),
  );

  for (const window of activeHours) {
    const start = parseClockTime(window.start);
    const end = parseClockTime(window.end);
    if (start === null || end === null) {
      continue;
    }

    for (const day of window.days) {
      const normalizedDay = normalizeDay(day);
      if (!normalizedDay) {
        continue;
      }

      const dayIntervals = activeIntervalsByDay.get(normalizedDay);
      if (!dayIntervals) {
        continue;
      }

      const dayIndex = DAY_ORDER.indexOf(normalizedDay);
      if (dayIndex < 0) {
        continue;
      }

      if (start === end) {
        dayIntervals.push({ start: 0, end: END_OF_DAY_MINUTES });
        continue;
      }

      if (start < end) {
        dayIntervals.push({ start, end });
        continue;
      }

      dayIntervals.push({ start, end: END_OF_DAY_MINUTES });
      const nextDayIndex = (dayIndex + 1) % DAY_ORDER.length;
      const nextDay = DAY_ORDER[nextDayIndex];
      if (!nextDay) {
        continue;
      }
      const nextIntervals = activeIntervalsByDay.get(nextDay);
      if (!nextIntervals) {
        continue;
      }
      nextIntervals.push({ start: 0, end });
    }
  }

  const groupedWindows = new Map<string, DayName[]>();
  const windowOrder: string[] = [];

  for (const day of DAY_ORDER) {
    const active = mergeIntervals(activeIntervalsByDay.get(day) ?? []);
    const available = invertIntervals(active);
    const condensed = condenseForMidnightCrossing(available);

    for (const interval of condensed) {
      const start = renderMinutes(interval.start);
      const end = renderMinutes(interval.end);
      const key = `${start}|${end}`;
      if (!groupedWindows.has(key)) {
        groupedWindows.set(key, []);
        windowOrder.push(key);
      }
      groupedWindows.get(key)?.push(day);
    }
  }

  return windowOrder.map((key) => {
    const [start = "00:00", end = END_OF_DAY_RENDER] = key.split("|");
    return {
      days: groupedWindows.get(key) ?? [],
      start,
      end,
    };
  });
}

async function injectProviderDirect(
  apiKey: string,
  apiBaseUrl: string,
  preloaded?: LoadedOpenClawConfig,
): Promise<ProviderInjectionResult> {
  const loaded = preloaded ?? (await loadOpenClawConfigForWrite());

  const models = ensureRecord(loaded.config, "models");
  const providers = ensureRecord(models, "providers");
  providers[CLAWRMA_PROVIDER_ID] = buildClawrmaProvider(apiKey, apiBaseUrl);

  const existingFallbacks = getFallbacks(loaded.config);
  const alreadyPresent = existingFallbacks.includes(CLAWRMA_FALLBACK_ID);
  const nextFallbacks = alreadyPresent
    ? existingFallbacks
    : [...existingFallbacks, CLAWRMA_FALLBACK_ID];

  const agents = ensureRecord(loaded.config, "agents");
  const defaults = ensureRecord(agents, "defaults");
  const model = ensureRecord(defaults, "model");
  model.fallbacks = nextFallbacks;

  const skills = ensureRecord(loaded.config, "skills");
  const entries = ensureRecord(skills, "entries");
  const clawrmaSkill = ensureRecord(entries, CLAWRMA_SKILL_ID);
  const env = ensureRecord(clawrmaSkill, "env");
  env.CLAWRMA_API_KEY = apiKey;

  await writeFile(
    loaded.path,
    `${JSON.stringify(loaded.config, null, 2)}\n`,
    "utf8",
  );

  setupLogger.info(
    {
      path: loaded.path,
      injected: !alreadyPresent,
      fallbackPosition: nextFallbacks.indexOf(CLAWRMA_FALLBACK_ID) + 1,
      fallbackTotal: nextFallbacks.length,
    },
    "Injected Clawrma provider through direct OpenClaw config file edit",
  );

  return {
    injected: !alreadyPresent,
    fallbackPosition: nextFallbacks.indexOf(CLAWRMA_FALLBACK_ID) + 1,
    fallbackTotal: nextFallbacks.length,
  };
}

export async function loadOpenClawConfigForWrite(): Promise<LoadedOpenClawConfig> {
  const path = await firstExistingPath([
    OPENCLAW_CONFIG_PATH,
    LEGACY_CONFIG_PATH,
  ]);
  if (!path) {
    throw new Error(
      "OpenClaw config not found at ~/.openclaw/openclaw.json or ~/.clawdbot/clawdbot.json",
    );
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`OpenClaw config at ${path} is not a JSON object.`);
  }

  return { config: parsed, path };
}

async function refreshPreloadedConfig(
  preloaded?: LoadedOpenClawConfig,
): Promise<void> {
  if (!preloaded) {
    return;
  }

  try {
    const raw = await readFile(preloaded.path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      preloaded.config = parsed;
    }
  } catch {
    // Keep existing preloaded config snapshot if refresh fails.
  }
}

function syncPreloadedConfigFromRpc(
  preloaded: LoadedOpenClawConfig | undefined,
  rpcPayload: unknown,
): void {
  if (!preloaded) {
    return;
  }
  const config = extractRpcConfig(rpcPayload);
  if (Object.keys(config).length > 0) {
    preloaded.config = config;
  }
}

function buildClawrmaProvider(
  apiKey: string,
  apiBaseUrl: string,
): Record<string, unknown> {
  return {
    baseUrl: buildProviderBaseUrl(apiBaseUrl),
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: "strong",
        name: "Clawrma Strong",
        cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
}

function buildProviderBaseUrl(apiBaseUrl: string): string {
  return new URL("/v1", normalizeApiBaseUrl(apiBaseUrl)).toString();
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

function readProvidersFromConfig(
  config: Record<string, unknown>,
): OpenClawProviderConfig[] {
  const providersRecord = getNestedValue(config, ["models", "providers"]);
  if (!isRecord(providersRecord)) {
    return [];
  }

  const providers: OpenClawProviderConfig[] = [];
  for (const [name, rawProvider] of Object.entries(providersRecord)) {
    if (!isRecord(rawProvider)) {
      continue;
    }

    providers.push({
      name,
      endpoint: pickFirstString(rawProvider, [
        "baseUrl",
        "endpoint",
        "url",
        "host",
      ]),
      apiKey: pickFirstString(rawProvider, ["apiKey", "key"]),
      token: pickFirstString(rawProvider, [
        "token",
        "accessToken",
        "oauthToken",
      ]),
      modelName: resolveProviderModelName(rawProvider),
    });
  }

  return providers;
}

function hasSearchConfig(config: Record<string, unknown>): boolean {
  const fromConfig = normalizeConfiguredString(
    getNestedValue(config, ["tools", "web", "search", "apiKey"]),
  );
  if (fromConfig) {
    return true;
  }

  return listConfiguredBuiltInSearchProviders().length > 0;
}

function hasFirecrawlConfig(config: Record<string, unknown>): boolean {
  return (
    getNestedValue(config, [
      "tools",
      "web",
      "fetch",
      "firecrawl",
      "enabled",
    ]) === true
  );
}

function getFallbacks(config: Record<string, unknown>): string[] {
  const rawFallbacks = getNestedValue(config, [
    "agents",
    "defaults",
    "model",
    "fallbacks",
  ]);
  if (!Array.isArray(rawFallbacks)) {
    return [];
  }
  return rawFallbacks.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function extractRpcConfig(rpcPayload: unknown): Record<string, unknown> {
  if (!isRecord(rpcPayload)) {
    return {};
  }

  const config = rpcPayload.config;
  if (isRecord(config)) {
    return config;
  }

  return {};
}

function extractRpcHash(rpcPayload: unknown): string | null {
  if (!isRecord(rpcPayload)) {
    return null;
  }

  return typeof rpcPayload.hash === "string" && rpcPayload.hash.length > 0
    ? rpcPayload.hash
    : null;
}

async function gatewayRpc(
  gatewayUrl: string,
  gatewayToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!gatewayUrl || !gatewayToken) {
    throw new Error(
      "Gateway URL and token are required for OpenClaw config RPC.",
    );
  }

  const body: RpcRequestPayload = {
    jsonrpc: "2.0",
    id: `clawrma-${Date.now()}`,
    method,
    params,
  };

  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `OpenClaw Gateway RPC ${method} failed with status ${response.status}.`,
    );
  }

  const payload = (await response.json()) as unknown;
  if (!isRecord(payload)) {
    throw new Error(
      `OpenClaw Gateway RPC ${method} returned a non-object response.`,
    );
  }

  if (payload.error !== undefined) {
    const message =
      isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : JSON.stringify(payload.error);
    throw new Error(
      `OpenClaw Gateway RPC ${method} returned error: ${message}`,
    );
  }

  if (payload.result !== undefined) {
    return payload.result;
  }

  return payload;
}

function mergeIntervals(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) {
    return [];
  }
  const merged: DayInterval[] = [{ start: first.start, end: first.end }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ start: interval.start, end: interval.end });
      continue;
    }
    if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ start: interval.start, end: interval.end });
  }

  return merged;
}

function invertIntervals(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length === 0) {
    return [{ start: 0, end: END_OF_DAY_MINUTES }];
  }

  const inverted: DayInterval[] = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start > cursor) {
      inverted.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
  }

  if (cursor < END_OF_DAY_MINUTES) {
    inverted.push({ start: cursor, end: END_OF_DAY_MINUTES });
  }

  return inverted;
}

function condenseForMidnightCrossing(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length !== 2) {
    return intervals;
  }

  const [first, second] = intervals;
  if (!first || !second) {
    return intervals;
  }
  if (first.start === 0 && second.end === END_OF_DAY_MINUTES) {
    return [{ start: second.start, end: first.end }];
  }

  return intervals;
}

function parseClockTime(value: string): number | null {
  if (!isValidClockTime(value)) {
    return null;
  }

  const [hoursRaw, minutesRaw] = value.split(":");
  if (!hoursRaw || !minutesRaw) {
    return null;
  }
  const hours = Number.parseInt(hoursRaw, 10);
  const minutes = Number.parseInt(minutesRaw, 10);
  return hours * 60 + minutes;
}

function renderMinutes(minutes: number): string {
  if (minutes >= END_OF_DAY_MINUTES) {
    return END_OF_DAY_RENDER;
  }
  const normalized =
    ((minutes % END_OF_DAY_MINUTES) + END_OF_DAY_MINUTES) % END_OF_DAY_MINUTES;
  const hours = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${hours.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function normalizeDay(value: string): DayName | null {
  const normalized = value.trim().toLowerCase().slice(0, 3);
  if ((DAY_ORDER as readonly string[]).includes(normalized)) {
    return normalized as DayName;
  }
  return null;
}

function isValidClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let cursor: unknown = value;
  for (const segment of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function pickFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function resolveProviderModelName(provider: Record<string, unknown>): string {
  const topLevelModel = pickFirstString(provider, ["model"]);
  if (topLevelModel) {
    return topLevelModel;
  }

  const rawModels = provider.models;
  if (!Array.isArray(rawModels)) {
    return "";
  }

  for (const rawModel of rawModels) {
    if (!isRecord(rawModel)) {
      continue;
    }
    const modelId = pickFirstString(rawModel, ["id"]);
    if (modelId) {
      return modelId;
    }
  }

  return "";
}

async function firstExistingPath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

function ensureRecord(
  container: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = container[key];
  if (isRecord(value)) {
    return value;
  }

  const created: Record<string, unknown> = {};
  container[key] = created;
  return created;
}
