import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  ALL_SCHEDULE_DAYS,
  ALWAYS_ON_SCHEDULE_WINDOW,
  DEFAULT_API_BASE_URL,
  LOCAL_SOLVER_TASK_TYPES,
} from "./constants.js";
import { getStatus, registerAccount, truncateKey } from "./client.js";
import { readConfig, writeConfig } from "./config.js";
import { detectCapabilities } from "./detect.js";
import {
  invertActiveHoursToSolverWindows,
  readOpenClawConfig,
  writeClawrmaApiKey,
} from "./integrations/openclaw.js";
import type {
  ClawrmaConfig,
  DetectionResult,
  FrameworkType,
  ScheduleWindow,
} from "./types.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_BRIGHT_CYAN = "\u001b[96m";
const ANSI_BRIGHT_BLUE = "\u001b[94m";
const ANSI_BRIGHT_YELLOW = "\u001b[93m";
const ANSI_BRIGHT_GREEN = "\u001b[92m";
const ANSI_BRIGHT_WHITE = "\u001b[97m";
const ANSI_BRIGHT_MAGENTA = "\u001b[95m";
const DEFAULT_WELCOME_CREDIT_POINTS = 200;
const DEFAULT_EARNINGS_THRESHOLD_POINTS = 1.0;

export interface SetupOptions {
  framework: FrameworkType;
  interactive?: boolean;
  solver?: "on" | "off";
  schedule?:
    | "outside-active-hours"
    | "overnight"
    | "idle-always"
    | "custom"
    | "off";
  webFetchFallback?: "yes" | "no";
  apiBaseUrl?: string;
}

type AskPrompt = (question: string) => Promise<string>;

function formatBlock(tag: string, message: string, color: string): string {
  if (process.stdout.isTTY) {
    return `${color}[${tag}]${ANSI_RESET} ${message}`;
  }
  return `[${tag}] ${message}`;
}

function emit(tag: string, message: string, color: string): void {
  console.log(formatBlock(tag, message, color));
}

export function emitDetected(message: string): void {
  emit("DETECTED", message, ANSI_BRIGHT_CYAN);
}

export function emitAccount(message: string): void {
  emit("ACCOUNT", message, ANSI_BRIGHT_BLUE);
}

export function emitAsk(question: string): void {
  emit("ASK THE USER", question, ANSI_BRIGHT_YELLOW);
}

export function emitNotice(message: string): void {
  emit("NOTICE", message, ANSI_BRIGHT_MAGENTA);
}

export function emitResult(message: string): void {
  emit("RESULT", `✓ ${message}`, ANSI_BRIGHT_GREEN);
}

export function emitTell(message: string): void {
  emit("TELL THE USER", message, ANSI_BRIGHT_WHITE);
}

export function emitNext(suggestion: string): void {
  emit("NEXT", suggestion, ANSI_BRIGHT_GREEN);
}

function createPromptSession(interactive: boolean): {
  ask: AskPrompt;
  close: () => void;
} {
  let promptInterface: ReturnType<typeof createInterface> | null = null;

  return {
    ask: async (question: string): Promise<string> => {
      if (!interactive) {
        return "";
      }
      emitAsk(question);

      if (!promptInterface) {
        promptInterface = createInterface({ input, output });
      }

      return (await promptInterface.question("> ")).trim();
    },
    close: (): void => {
      promptInterface?.close();
      promptInterface = null;
    },
  };
}

export async function runSetup(options: SetupOptions): Promise<void> {
  let prompts: { ask: AskPrompt; close: () => void } | null = null;
  try {
    if (process.platform === "win32") {
      throw new Error(
        "Clawrma is not supported on Windows. Use WSL or a Linux/macOS environment.",
      );
    }

    const interactive =
      options.interactive ??
      (process.stdin.isTTY === true &&
        process.env.CI !== "true" &&
        process.env.CI !== "1");
    prompts = createPromptSession(interactive);
    const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const existingAccount = await resolveExistingAccount(apiBaseUrl);

    if (!interactive) {
      const missing: string[] = [];
      if (options.solver === undefined) missing.push("--solver <on|off>");
      if (options.solver === "on" && options.schedule === undefined) {
        missing.push("--schedule <preset>");
      }
      if (missing.length > 0) {
        throw new Error(
          `Non-interactive setup requires these flags: ${missing.join(", ")}`,
        );
      }
    }

    const solverEnabled = await resolveSolverEnabled(
      interactive,
      options.solver,
      prompts.ask,
    );
    const openClawConfig =
      options.framework === "openclaw" ? await readOpenClawConfig() : null;
    let detection: DetectionResult | null = null;
    if (solverEnabled) {
      const shouldSkipCapabilityDetection =
        !interactive && options.framework === "none";
      if (shouldSkipCapabilityDetection) {
        emitNotice(
          "Skipping capability detection for --framework none in non-interactive setup; using defaults.",
        );
        detection = {
          providers: [],
          browserAvailable: false,
          notificationChannels: [],
          activeHours: null,
          existingSearchConfig: false,
          existingFirecrawlConfig: false,
        };
      } else {
        detection = await detectCapabilities(options.framework, {
          includeNotificationChannels: false,
        });
      }

      for (const provider of detection.providers) {
        emitDetected(
          `${provider.name} (${provider.billingType}, ${provider.fulfillmentPath}) ${provider.endpoint}`,
        );
      }
      emitNotice(
        "Sandboxed or containerized agents may have restricted behavior. Review your environment manually before enabling deeper framework integration.",
      );
    }
    const schedule = solverEnabled
      ? await resolveSchedule(
          options.framework,
          interactive,
          prompts.ask,
          options.schedule,
          detection?.activeHours ?? null,
          openClawConfig?.activeHoursTimezone ?? null,
        )
      : buildDisabledSolverSchedule(
          openClawConfig?.activeHoursTimezone ?? null,
        );

    if (
      detection?.providers.some(
        (provider) => provider.billingType === "per_token",
      )
    ) {
      emitNotice(
        "Per-token providers are excluded from inference solving by default to avoid unexpected API costs.",
      );
    }

    const notifications = defaultNotifications();

    const gatewayConfig = resolveGatewayConfig();
    const { accountId, apiKey } =
      existingAccount ?? (await registerNewAccount(apiBaseUrl));

    if (options.framework === "openclaw") {
      await writeClawrmaApiKey(gatewayConfig.url, gatewayConfig.token, apiKey);
    }

    if (
      solverEnabled &&
      options.framework === "openclaw" &&
      options.webFetchFallback === "yes"
    ) {
      emitNotice(
        "Firecrawl web_fetch fallback setup is disabled in this launch phase; OpenClaw config was not changed.",
      );
    }

    const config: ClawrmaConfig = {
      version: 1,
      accountId,
      apiKey,
      apiBaseUrl,
      framework: options.framework,
      solver: {
        enabled: solverEnabled,
        schedule,
        taskTypes: [...LOCAL_SOLVER_TASK_TYPES],
        excludedBillingTypes: ["per_token"],
        domainPolicy: "allowlist",
      },
      inference: {
        maxSpendPerRequest: null,
      },
      webFetchFallback: {
        injected: false,
        method: "none",
      },
      notifications,
      welcomeCredit: DEFAULT_WELCOME_CREDIT_POINTS,
      installedAt: new Date().toISOString(),
    };

    await writeConfig(config);

    let statusBalance = DEFAULT_WELCOME_CREDIT_POINTS;
    try {
      const status = await getStatus(apiBaseUrl, apiKey);
      statusBalance = status.balance;
    } catch {
      // Status is best effort for setup summary.
    }

    emitTell("⚡ Clawrma");
    emitTell(`  ✓ Registered            ${truncateKey(apiKey)}`);
    if (solverEnabled && detection) {
      emitTell(
        `  ✓ Capabilities          ${detection.providers.map((p) => p.name).join(", ") || "none"}`,
      );
      emitTell(
        "  ✓ Integration note      review sandbox/container limits before deeper framework integration",
      );
      emitTell(
        `  ✓ Solver scope          ${LOCAL_SOLVER_TASK_TYPES.join(", ")}`,
      );
      emitTell("  ✓ Solver configured     enabled");
      emitTell(
        "  ✓ Domain policy        popular sites only (change: npx clawrma solver domains open)",
      );
    }
    emitTell(
      `  Balance     ${statusBalance.toFixed(2)} points (welcome credit)`,
    );
    if (solverEnabled) {
      emitNext("Run: npx clawrma solver run");
    }
    emitNext("Try it now: npx clawrma fetch https://news.ycombinator.com");
  } finally {
    prompts?.close();
  }
}

async function resolveExistingAccount(
  apiBaseUrl: string,
): Promise<{ accountId: string; apiKey: string; isExisting: true } | null> {
  try {
    const existingConfig = await readConfig();
    if (!existingConfig) {
      return null;
    }

    if (existingConfig.apiBaseUrl !== apiBaseUrl) {
      emitNotice(
        `Existing config targets ${existingConfig.apiBaseUrl}; setup will register a new account for ${apiBaseUrl}.`,
      );
      return null;
    }

    emitAccount(
      `Reusing ${truncateKey(existingConfig.apiKey)} (${existingConfig.accountId}) from existing config`,
    );
    return {
      accountId: existingConfig.accountId,
      apiKey: existingConfig.apiKey,
      isExisting: true,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    emitNotice(
      `Existing Clawrma config is invalid and will be replaced: ${detail}`,
    );
    return null;
  }
}

async function registerNewAccount(
  apiBaseUrl: string,
): Promise<{ accountId: string; apiKey: string; isExisting: false }> {
  const { accountId, apiKey } = await registerAccount(apiBaseUrl);
  emitAccount(`Registered ${truncateKey(apiKey)} (${accountId})`);
  emitAccount("200.00 points welcome credit applied");
  return { accountId, apiKey, isExisting: false };
}

async function resolveSolverEnabled(
  interactive: boolean,
  solverFlag: SetupOptions["solver"],
  askPrompt: AskPrompt,
): Promise<boolean> {
  if (solverFlag === "on") {
    return true;
  }
  if (solverFlag === "off") {
    return false;
  }

  const answer = (
    await askPrompt(
      "Enable solver mode? Proxy fetch / web search tasks earn ~1.2 points each. Inference tasks earn ~15 points avg (per-token settlement). Earnings depend on solver network demand - rates may vary. (y/n)",
    )
  ).toLowerCase();

  if (!interactive) {
    return true;
  }

  return answer === "y" || answer === "yes" || answer === "";
}

async function resolveSchedule(
  framework: FrameworkType,
  interactive: boolean,
  askPrompt: AskPrompt,
  scheduleFlag: SetupOptions["schedule"],
  activeHours: ScheduleWindow[] | null,
  activeHoursTimezone: string | null,
): Promise<ClawrmaConfig["solver"]["schedule"]> {
  const timezone =
    activeHoursTimezone ??
    (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const hasActiveHours =
    framework === "openclaw" &&
    Array.isArray(activeHours) &&
    activeHours.length > 0;

  const defaultPreset = hasActiveHours ? "outside-active-hours" : "overnight";
  const preset =
    scheduleFlag ??
    (await askSchedulePreset(
      interactive,
      askPrompt,
      hasActiveHours,
      defaultPreset,
    ));

  return {
    preset,
    source:
      hasActiveHours && preset === "outside-active-hours"
        ? "openclaw-heartbeat"
        : "manual",
    timezone,
    windows: buildScheduleFromPreset(preset, activeHours),
  };
}

function buildDisabledSolverSchedule(
  activeHoursTimezone: string | null,
): ClawrmaConfig["solver"]["schedule"] {
  const timezone =
    activeHoursTimezone ??
    (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return {
    preset: "overnight",
    source: "manual",
    timezone,
    windows: buildScheduleFromPreset("overnight", null),
  };
}

async function askSchedulePreset(
  interactive: boolean,
  askPrompt: AskPrompt,
  hasActiveHours: boolean,
  defaultPreset: "outside-active-hours" | "overnight",
): Promise<
  "outside-active-hours" | "overnight" | "idle-always" | "custom" | "off"
> {
  const withActive =
    "outside-active-hours, overnight, idle-always, custom, off";
  const withoutActive = "overnight, idle-always, custom, off";

  const answer = await askPrompt(
    `Choose schedule preset (${hasActiveHours ? withActive : withoutActive}). Default: ${defaultPreset}`,
  );

  if (!interactive || !answer) {
    return defaultPreset;
  }

  if (
    answer === "outside-active-hours" ||
    answer === "overnight" ||
    answer === "idle-always" ||
    answer === "custom" ||
    answer === "off"
  ) {
    return answer;
  }

  return defaultPreset;
}

function buildScheduleFromPreset(
  preset:
    | "outside-active-hours"
    | "overnight"
    | "idle-always"
    | "custom"
    | "off",
  activeHours: ScheduleWindow[] | null,
): ScheduleWindow[] {
  if (
    preset === "outside-active-hours" &&
    activeHours &&
    activeHours.length > 0
  ) {
    return invertActiveHoursToSolverWindows(activeHours);
  }

  if (preset === "idle-always") {
    return [{ ...ALWAYS_ON_SCHEDULE_WINDOW }];
  }

  if (preset === "off") {
    return [];
  }

  if (preset === "custom") {
    return [{ days: [...ALL_SCHEDULE_DAYS], start: "01:00", end: "05:00" }];
  }

  return [{ days: [...ALL_SCHEDULE_DAYS], start: "00:00", end: "06:00" }];
}

function resolveGatewayConfig(): { url: string; token: string } {
  const url =
    firstDefined([
      process.env.OPENCLAW_GATEWAY_URL,
      process.env.OPENCLAW_GATEWAY_RPC_URL,
    ]) ?? "";
  const token =
    firstDefined([
      process.env.OPENCLAW_GATEWAY_TOKEN,
      process.env.OPENCLAW_RPC_TOKEN,
    ]) ?? "";

  return { url, token };
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function defaultNotifications(): ClawrmaConfig["notifications"] {
  return {
    channel: null,
    target: "",
    earningsThreshold: DEFAULT_EARNINGS_THRESHOLD_POINTS,
    dailySummary: true,
  };
}
