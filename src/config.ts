import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  BILLING_TYPES,
  CONFIG_DIR,
  CONFIG_PATH,
  DOMAIN_POLICIES,
  SCHEDULE_PRESETS,
  SCHEMA_PATH,
  TASK_TYPES,
} from "./constants.js";
import { isRecord } from "./guards.js";
import type {
  ClawrmaConfig,
  BillingType,
  FrameworkType,
  TaskType,
} from "./types.js";
const FRAMEWORK_TYPES: FrameworkType[] = ["openclaw", "none"];
const SCHEDULE_SOURCES = ["openclaw-heartbeat", "manual", "unknown"] as const;

const CLAWRMA_CONFIG_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ClawrmaConfig",
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "accountId",
    "apiKey",
    "apiBaseUrl",
    "framework",
    "solver",
    "webFetchFallback",
    "notifications",
    "welcomeCredit",
    "installedAt",
  ],
  properties: {
    version: { type: "number" },
    accountId: { type: "string" },
    apiKey: { type: "string" },
    apiBaseUrl: { type: "string" },
    framework: { type: "string", enum: FRAMEWORK_TYPES },
    solver: {
      type: "object",
      additionalProperties: false,
      required: [
        "enabled",
        "schedule",
        "taskTypes",
        "excludedBillingTypes",
        "domainPolicy",
      ],
      properties: {
        enabled: { type: "boolean" },
        schedule: {
          type: "object",
          additionalProperties: false,
          required: ["preset", "source", "timezone", "windows"],
          properties: {
            preset: { type: "string", enum: SCHEDULE_PRESETS },
            source: { type: "string", enum: SCHEDULE_SOURCES },
            timezone: { type: "string" },
            windows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["days", "start", "end"],
                properties: {
                  days: { type: "array", items: { type: "string" } },
                  start: { type: "string" },
                  end: { type: "string" },
                },
              },
            },
          },
        },
        taskTypes: {
          type: "array",
          items: { type: "string", enum: TASK_TYPES },
        },
        excludedBillingTypes: {
          type: "array",
          items: { type: "string", enum: BILLING_TYPES },
        },
        domainPolicy: { type: "string", enum: DOMAIN_POLICIES },
      },
    },
    inference: {
      type: "object",
      additionalProperties: false,
      required: ["maxSpendPerRequest"],
      properties: {
        maxSpendPerRequest: { type: ["number", "null"] },
      },
    },
    promptSafetyScan: { type: "boolean" },
    webFetchFallback: {
      type: "object",
      additionalProperties: false,
      required: ["injected", "method"],
      properties: {
        injected: { type: "boolean" },
        method: { type: "string" },
      },
    },
    notifications: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "target", "earningsThreshold", "dailySummary"],
      properties: {
        channel: { type: ["string", "null"] },
        target: { type: "string" },
        earningsThreshold: { type: "number" },
        dailySummary: { type: "boolean" },
      },
    },
    welcomeCredit: { type: "number" },
    installedAt: { type: "string" },
  },
};

export async function writeConfig(config: ClawrmaConfig): Promise<void> {
  if (!isClawrmaConfig(config)) {
    throw new Error("writeConfig received invalid ClawrmaConfig.");
  }

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    SCHEMA_PATH,
    `${JSON.stringify(CLAWRMA_CONFIG_SCHEMA, null, 2)}\n`,
    0o644,
  );
  await writeFileAtomic(
    CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    0o600,
  );
}

export async function readConfig(): Promise<ClawrmaConfig | null> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Config at ${CONFIG_PATH} is not valid JSON.`, {
      cause: error,
    });
  }

  if (!isClawrmaConfig(parsed)) {
    throw new Error(
      `Config at ${CONFIG_PATH} does not match ClawrmaConfig schema.`,
    );
  }

  return parsed;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

async function writeFileAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, contents, { encoding: "utf8", mode });
    await rename(tempPath, path);
    await chmod(path, mode);
  } catch (error: unknown) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isClawrmaConfig(value: unknown): value is ClawrmaConfig {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isNumber(value.version) ||
    !isString(value.accountId) ||
    !isString(value.apiKey) ||
    !isString(value.apiBaseUrl) ||
    !isOneOf(value.framework, FRAMEWORK_TYPES) ||
    !isNumber(value.welcomeCredit) ||
    !isString(value.installedAt)
  ) {
    return false;
  }

  if (!isRecord(value.solver)) {
    return false;
  }

  if (
    !isBoolean(value.solver.enabled) ||
    !isSolverSchedule(value.solver.schedule) ||
    !isTaskTypeArray(value.solver.taskTypes) ||
    !isBillingTypeArray(value.solver.excludedBillingTypes) ||
    !isOneOf(value.solver.domainPolicy, DOMAIN_POLICIES)
  ) {
    return false;
  }

  if (value.inference !== undefined) {
    if (!isRecord(value.inference)) {
      return false;
    }
    const maxSpendPerRequest = value.inference.maxSpendPerRequest;
    if (maxSpendPerRequest !== null && !isNumber(maxSpendPerRequest)) {
      return false;
    }
  }

  if (
    value.promptSafetyScan !== undefined &&
    !isBoolean(value.promptSafetyScan)
  ) {
    return false;
  }

  if (!isRecord(value.webFetchFallback)) {
    return false;
  }

  if (
    !isBoolean(value.webFetchFallback.injected) ||
    !isString(value.webFetchFallback.method)
  ) {
    return false;
  }

  if (!isRecord(value.notifications)) {
    return false;
  }

  return (
    (value.notifications.channel === null ||
      isString(value.notifications.channel)) &&
    isString(value.notifications.target) &&
    isNumber(value.notifications.earningsThreshold) &&
    isBoolean(value.notifications.dailySummary)
  );
}

function isSolverSchedule(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isOneOf(value.preset, SCHEDULE_PRESETS) ||
    !isOneOf(value.source, SCHEDULE_SOURCES) ||
    !isString(value.timezone) ||
    !Array.isArray(value.windows)
  ) {
    return false;
  }

  for (const window of value.windows) {
    if (!isRecord(window)) {
      return false;
    }
    if (
      !isStringArray(window.days) ||
      !isString(window.start) ||
      !isString(window.end)
    ) {
      return false;
    }
  }

  return true;
}

function isTaskTypeArray(value: unknown): value is TaskType[] {
  return (
    Array.isArray(value) && value.every((entry) => isOneOf(entry, TASK_TYPES))
  );
}

function isBillingTypeArray(value: unknown): value is BillingType[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isOneOf(entry, BILLING_TYPES))
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof error.code === "string";
}
