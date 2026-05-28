import { spawn } from "node:child_process";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards.js";
import { setupLogger } from "../logging.js";
import {
  listConfiguredBuiltInSearchProviders,
  normalizeConfiguredString,
} from "../search/builtins.js";
import type { ScheduleWindow } from "../types.js";

const requireJson5 = createRequire(import.meta.url);
const JSON5 = requireJson5("json5") as typeof import("json5");
const CLAWRMA_FALLBACK_ID = "clawrma/strong";
const CLAWRMA_PROVIDER_ID = "clawrma";
const CLAWRMA_SKILL_ID = "clawrma";
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const END_OF_DAY_MINUTES = 24 * 60;
const END_OF_DAY_RENDER = "23:59";
const OPENCLAW_CLI_PATCH_TIMEOUT_MS = 5_000;

/** Environment variables that can affect OpenClaw config resolution. */
export interface OpenClawConfigResolverEnv {
  [key: string]: string | undefined;
  OPENCLAW_CONFIG_PATH?: string | undefined;
  OPENCLAW_STATE_DIR?: string | undefined;
  OPENCLAW_HOME?: string | undefined;
}

/** Source label for an OpenClaw config candidate. */
export type OpenClawConfigCandidateSource =
  | "OPENCLAW_CONFIG_PATH"
  | "OPENCLAW_STATE_DIR"
  | "OPENCLAW_HOME"
  | "default";

/** Candidate file path from OpenClaw config resolution order. */
export interface OpenClawConfigCandidate {
  path: string;
  source: OpenClawConfigCandidateSource;
  sourceValue: string;
  relativePath: string | null;
}

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

type OpenClawConfigWritePath =
  | "gateway-rpc"
  | "openclaw-cli"
  | "strict-json-file";

interface OpenClawConfigPatchPlan<TResult> {
  patch: Record<string, unknown>;
  result: TResult;
}

interface OpenClawConfigWriteFailure {
  path: OpenClawConfigWritePath;
  error: unknown;
}

interface OpenClawConfigWriteOptions<TResult> {
  gatewayUrl: string;
  gatewayToken: string;
  operation: string;
  preloaded?: LoadedOpenClawConfig;
  buildPatch: (
    currentConfig: Record<string, unknown>,
  ) => OpenClawConfigPatchPlan<TResult>;
  resultFromGateway?: (
    plan: OpenClawConfigPatchPlan<TResult>,
    rpcPayload: unknown,
  ) => TResult;
  logSuccess: (path: OpenClawConfigWritePath, result: TResult) => void;
}

/** Resolve OpenClaw config candidates without reading or writing the filesystem. */
export function resolveOpenClawConfigCandidates(
  env: OpenClawConfigResolverEnv = process.env,
  homeDir = homedir(),
): OpenClawConfigCandidate[] {
  const explicitConfigPath = readEnvPath(env.OPENCLAW_CONFIG_PATH);
  if (explicitConfigPath) {
    return [
      {
        path: explicitConfigPath,
        source: "OPENCLAW_CONFIG_PATH",
        sourceValue: explicitConfigPath,
        relativePath: null,
      },
    ];
  }

  const stateDir = readEnvPath(env.OPENCLAW_STATE_DIR);
  if (stateDir) {
    return [
      buildConfigCandidate(stateDir, "openclaw.json", "OPENCLAW_STATE_DIR"),
      buildConfigCandidate(stateDir, "clawdbot.json", "OPENCLAW_STATE_DIR"),
    ];
  }

  const openClawHome = readEnvPath(env.OPENCLAW_HOME);
  const configHome = openClawHome ?? homeDir;
  const source: OpenClawConfigCandidateSource = openClawHome
    ? "OPENCLAW_HOME"
    : "default";
  const candidates: OpenClawConfigCandidate[] = [];
  candidates.push(
    buildConfigCandidate(configHome, ".openclaw/openclaw.json", source),
    buildConfigCandidate(configHome, ".openclaw/clawdbot.json", source),
    buildConfigCandidate(configHome, ".clawdbot/openclaw.json", source),
    buildConfigCandidate(configHome, ".clawdbot/clawdbot.json", source),
  );

  return candidates;
}

export async function readOpenClawConfig(): Promise<OpenClawConfig | null> {
  const candidate = await firstExistingConfigCandidate(
    resolveOpenClawConfigCandidates(),
  );
  if (!candidate) {
    return null;
  }

  const parsed = await readOpenClawConfigObject(candidate.path);

  return {
    path: candidate.path,
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
  return writeOpenClawConfigPatch({
    gatewayUrl,
    gatewayToken,
    operation: "inject Clawrma provider into OpenClaw config",
    preloaded,
    buildPatch: (currentConfig) =>
      buildProviderInjectionPatch(currentConfig, apiKey, apiBaseUrl),
    resultFromGateway: (plan, rpcPayload) => {
      const resultingFallbacks = getFallbacks(extractRpcConfig(rpcPayload));
      if (resultingFallbacks.length === 0) {
        return plan.result;
      }
      return buildProviderInjectionResult(
        plan.result.injected,
        resultingFallbacks,
      );
    },
    logSuccess: (path, result) => {
      setupLogger.info(
        {
          path,
          injected: result.injected,
          fallbackPosition: result.fallbackPosition,
          fallbackTotal: result.fallbackTotal,
        },
        "Injected Clawrma provider into OpenClaw config",
      );
    },
  });
}

export async function writeClawrmaApiKey(
  gatewayUrl: string,
  gatewayToken: string,
  apiKey: string,
): Promise<void> {
  await writeOpenClawConfigPatch({
    gatewayUrl,
    gatewayToken,
    operation: "write CLAWRMA_API_KEY to OpenClaw config",
    buildPatch: () => ({
      patch: buildClawrmaApiKeyPatch(apiKey),
      result: undefined,
    }),
    logSuccess: (path) => {
      setupLogger.info({ path }, "Wrote CLAWRMA_API_KEY to OpenClaw skill env");
    },
  });
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

function buildProviderInjectionPatch(
  currentConfig: Record<string, unknown>,
  apiKey: string,
  apiBaseUrl: string,
): OpenClawConfigPatchPlan<ProviderInjectionResult> {
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

  return {
    patch,
    result: buildProviderInjectionResult(!alreadyPresent, nextFallbacks),
  };
}

function buildProviderInjectionResult(
  injected: boolean,
  fallbackList: string[],
): ProviderInjectionResult {
  return {
    injected,
    fallbackPosition: fallbackList.indexOf(CLAWRMA_FALLBACK_ID) + 1,
    fallbackTotal: fallbackList.length,
  };
}

function buildClawrmaApiKeyPatch(apiKey: string): Record<string, unknown> {
  return {
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
}

async function writeOpenClawConfigPatch<TResult>(
  options: OpenClawConfigWriteOptions<TResult>,
): Promise<TResult> {
  const failures: OpenClawConfigWriteFailure[] = [];

  try {
    const current = await gatewayRpc(
      options.gatewayUrl,
      options.gatewayToken,
      "config.get",
      {},
    );
    const plan = options.buildPatch(extractRpcConfig(current));
    const params: Record<string, unknown> = {
      raw: JSON.stringify(plan.patch),
    };
    const baseHash = extractRpcHash(current);
    if (baseHash) {
      params.baseHash = baseHash;
    }

    const rpcResult = await gatewayRpc(
      options.gatewayUrl,
      options.gatewayToken,
      "config.patch",
      params,
    );
    syncPreloadedConfigFromRpc(options.preloaded, rpcResult);
    const result = options.resultFromGateway
      ? options.resultFromGateway(plan, rpcResult)
      : plan.result;
    options.logSuccess("gateway-rpc", result);
    return result;
  } catch (error: unknown) {
    failures.push({ path: "gateway-rpc", error });
    setupLogger.warn(
      {
        path: "gateway-rpc",
        error: formatErrorMessage(error),
      },
      "OpenClaw Gateway RPC config write unavailable. Trying OpenClaw CLI.",
    );
  }

  try {
    const currentConfig = await loadOpenClawConfigForPatch(options.preloaded);
    const plan = options.buildPatch(currentConfig);
    await patchOpenClawConfigWithCli(plan.patch);
    syncPreloadedConfigFromPatch(options.preloaded, plan.patch);
    options.logSuccess("openclaw-cli", plan.result);
    return plan.result;
  } catch (error: unknown) {
    failures.push({ path: "openclaw-cli", error });
    setupLogger.warn(
      {
        path: "openclaw-cli",
        error: formatErrorMessage(error),
      },
      "OpenClaw CLI config patch unavailable. Trying strict JSON file fallback.",
    );
  }

  try {
    const loaded = await loadStrictOpenClawConfigForDirectWrite();
    const plan = options.buildPatch(loaded.config);
    applyConfigPatch(loaded.config, plan.patch);
    await writeFile(
      loaded.path,
      `${JSON.stringify(loaded.config, null, 2)}\n`,
      "utf8",
    );
    syncPreloadedConfigFromPatch(options.preloaded, plan.patch);
    options.logSuccess("strict-json-file", plan.result);
    return plan.result;
  } catch (error: unknown) {
    failures.push({ path: "strict-json-file", error });
    throw buildOpenClawConfigWriteError(options.operation, failures);
  }
}

export async function loadOpenClawConfigForWrite(): Promise<LoadedOpenClawConfig> {
  const candidates = resolveOpenClawConfigCandidates();
  const candidate = await firstExistingConfigCandidate(candidates);
  if (!candidate) {
    throw new Error(
      `OpenClaw config not found. Checked: ${formatConfigCandidateList(candidates)}.`,
    );
  }

  const parsed = await readOpenClawConfigObject(candidate.path);

  return { config: parsed, path: candidate.path };
}

async function loadOpenClawConfigForPatch(
  preloaded?: LoadedOpenClawConfig,
): Promise<Record<string, unknown>> {
  if (preloaded) {
    await refreshPreloadedConfig(preloaded);
    return preloaded.config;
  }

  const candidate = await firstExistingConfigCandidate(
    resolveOpenClawConfigCandidates(),
  );
  if (!candidate) {
    return {};
  }

  return readOpenClawConfigObject(candidate.path);
}

async function loadStrictOpenClawConfigForDirectWrite(): Promise<LoadedOpenClawConfig> {
  const candidates = resolveOpenClawConfigCandidates();
  for (const candidate of candidates) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(candidate.path);
    } catch (error: unknown) {
      if (
        isNodeErrorCode(error, "ENOENT") ||
        isNodeErrorCode(error, "ENOTDIR")
      ) {
        continue;
      }
      throw new Error(
        `Failed to inspect OpenClaw config at ${candidate.path}.`,
        { cause: error },
      );
    }

    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing direct OpenClaw config file edit at ${candidate.path} because it is a symlink. Start the OpenClaw Gateway or ensure the openclaw CLI is on PATH.`,
      );
    }
    if (stats.isDirectory()) {
      throw new Error(
        `Refusing direct OpenClaw config file edit at ${candidate.path} because it is a directory.`,
      );
    }
    if (!stats.isFile()) {
      throw new Error(
        `Refusing direct OpenClaw config file edit at ${candidate.path} because it is not a regular file.`,
      );
    }

    const raw = await readFile(candidate.path, "utf8");
    return {
      config: parseStrictOpenClawConfigForDirectWrite(raw, candidate.path),
      path: candidate.path,
    };
  }

  throw new Error(
    `OpenClaw config not found. Checked: ${formatConfigCandidateList(candidates)}.`,
  );
}

async function refreshPreloadedConfig(
  preloaded?: LoadedOpenClawConfig,
): Promise<void> {
  if (!preloaded) {
    return;
  }

  try {
    preloaded.config = await readOpenClawConfigObject(preloaded.path);
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

async function patchOpenClawConfigWithCli(
  patch: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("openclaw", ["config", "patch", "--stdin"], {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;

    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const timeout = setTimeout(() => {
      child.kill();
      settle(
        new Error(
          `OpenClaw CLI config patch timed out after ${OPENCLAW_CLI_PATCH_TIMEOUT_MS}ms.`,
        ),
      );
    }, OPENCLAW_CLI_PATCH_TIMEOUT_MS);

    child.stderr.on("data", (chunk: unknown) => {
      stderr += chunkToString(chunk);
    });

    child.on("error", (error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) {
        settle(
          new Error("OpenClaw CLI unavailable: openclaw not found on PATH.", {
            cause: error,
          }),
        );
        return;
      }
      settle(new Error("Failed to start OpenClaw CLI.", { cause: error }));
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      const exitDetails =
        code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
      const stderrDetails = stderr.trim();
      settle(
        new Error(
          stderrDetails
            ? `OpenClaw CLI config patch failed with ${exitDetails}: ${stderrDetails}`
            : `OpenClaw CLI config patch failed with ${exitDetails}.`,
        ),
      );
    });

    child.stdin.end(`${JSON.stringify(patch, null, 2)}\n`, "utf8");
  });
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

async function firstExistingConfigCandidate(
  candidates: OpenClawConfigCandidate[],
): Promise<OpenClawConfigCandidate | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate.path);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

async function readOpenClawConfigObject(
  path: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  return parseOpenClawConfig(raw, path);
}

function parseOpenClawConfig(
  raw: string,
  path: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse OpenClaw config at ${path}: ${message}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error(`OpenClaw config at ${path} is not a JSON object.`);
  }

  return parsed;
}

function parseStrictOpenClawConfigForDirectWrite(
  raw: string,
  path: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    if (canParseOpenClawJson5(raw)) {
      throw new Error(
        `OpenClaw config at ${path} uses JSON5 syntax. Direct file edits are only supported for strict JSON. Start the OpenClaw Gateway or ensure the openclaw CLI is on PATH.`,
        { cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse OpenClaw config at ${path} as strict JSON for direct file edit: ${message}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`OpenClaw config at ${path} is not a JSON object.`);
  }

  return parsed;
}

function canParseOpenClawJson5(raw: string): boolean {
  try {
    JSON5.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function applyConfigPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key];
    if (isRecord(existing) && isRecord(value)) {
      applyConfigPatch(existing, value);
      continue;
    }
    target[key] = cloneConfigValue(value);
  }
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry));
  }
  if (isRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      cloned[key] = cloneConfigValue(nestedValue);
    }
    return cloned;
  }
  return value;
}

function syncPreloadedConfigFromPatch(
  preloaded: LoadedOpenClawConfig | undefined,
  patch: Record<string, unknown>,
): void {
  if (!preloaded) {
    return;
  }
  applyConfigPatch(preloaded.config, patch);
}

function buildOpenClawConfigWriteError(
  operation: string,
  failures: OpenClawConfigWriteFailure[],
): Error {
  const aggregateCause = new AggregateError(
    failures.map((failure) => toError(failure.error)),
    `OpenClaw config ${operation} attempts failed.`,
  );
  return new Error(
    `Failed to ${operation}. Attempted paths: ${failures
      .map((failure) => `${failure.path}: ${formatErrorMessage(failure.error)}`)
      .join("; ")}.`,
    { cause: aggregateCause },
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
}

function readEnvPath(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildConfigCandidate(
  root: string,
  relativePath: string,
  source: OpenClawConfigCandidateSource,
): OpenClawConfigCandidate {
  return {
    path: join(root, ...relativePath.split("/")),
    source,
    sourceValue: root,
    relativePath,
  };
}

function formatConfigCandidateList(
  candidates: OpenClawConfigCandidate[],
): string {
  return candidates
    .map((candidate) => {
      const relativePath = candidate.relativePath
        ? `/${candidate.relativePath}`
        : "";
      return `${candidate.path} (${candidate.source}${relativePath})`;
    })
    .join(", ");
}
