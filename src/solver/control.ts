import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import {
  BILLING_TYPES,
  LOCAL_SOLVER_TASK_TYPES,
  SCHEDULE_PRESETS,
  TASK_TYPES,
} from "../constants.js";
import { writeConfig } from "../config.js";
import type { BillingType, ClawrmaConfig, TaskType } from "../types.js";
import {
  createWebSocket,
  sendPause,
  sendResume,
  type WebSocketManager,
} from "../ws.js";
import {
  buildScheduleForPreset,
  parseDayList,
  parseSchedulePreset,
  validateClockTime,
} from "./schedule.js";

const DEFAULT_CONTROL_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Configures how solver pause/resume control commands connect and persist state.
 */
export interface SolverControlOptions {
  wsFactory?: (config: ClawrmaConfig) => WebSocketManager;
  connectionTimeoutMs?: number;
  persistConfig?: boolean;
}

/**
 * Collects interactive answers for solver reconfiguration prompts.
 */
export interface SolverConfigPrompter {
  ask(prompt: string): Promise<string>;
  close(): void;
}

/**
 * Configures how solver reconfiguration prompts are presented and persisted.
 */
export interface SolverConfigOptions {
  persistConfig?: boolean;
  prompter?: SolverConfigPrompter;
}

/**
 * Resumes solver intake and optionally persists the enabled flag change.
 */
export async function startSolverIntake(
  config: ClawrmaConfig,
  options: SolverControlOptions = {},
): Promise<ClawrmaConfig> {
  await sendSolverControlSignal(config, "resume", options);

  const updated: ClawrmaConfig = {
    ...config,
    solver: {
      ...config.solver,
      enabled: true,
    },
  };

  if (options.persistConfig ?? true) {
    await writeConfig(updated);
  }

  return updated;
}

/**
 * Pauses solver intake and optionally persists the disabled flag change.
 */
export async function stopSolverIntake(
  config: ClawrmaConfig,
  options: SolverControlOptions = {},
): Promise<ClawrmaConfig> {
  await sendSolverControlSignal(config, "pause", options);

  const updated: ClawrmaConfig = {
    ...config,
    solver: {
      ...config.solver,
      enabled: false,
    },
  };

  if (options.persistConfig ?? true) {
    await writeConfig(updated);
  }

  return updated;
}

/**
 * Interactively updates solver schedule, task scope, and notification settings.
 */
export async function reconfigureSolver(
  config: ClawrmaConfig,
  options: SolverConfigOptions = {},
): Promise<ClawrmaConfig> {
  const prompter = options.prompter ?? createDefaultPrompter();
  try {
    const presetInput = await prompter.ask(
      `Schedule preset (${SCHEDULE_PRESETS.join(", ")}) [${config.solver.schedule.preset}]: `,
    );
    const preset = parseSchedulePreset(
      presetInput,
      config.solver.schedule.preset,
    );

    let schedule = buildScheduleForPreset(preset, config.solver.schedule);
    if (preset === "custom") {
      const currentDays =
        schedule.windows[0]?.days.join(",") ?? "mon,tue,wed,thu,fri,sat,sun";
      const currentStart = schedule.windows[0]?.start ?? "00:00";
      const currentEnd = schedule.windows[0]?.end ?? "06:00";

      const daysInput = await prompter.ask(
        `Custom days CSV [${currentDays}]: `,
      );
      const startInput = await prompter.ask(
        `Custom start HH:MM [${currentStart}]: `,
      );
      const endInput = await prompter.ask(`Custom end HH:MM [${currentEnd}]: `);

      const days = parseDayList(daysInput, currentDays.split(","));
      const start = validateClockTime(startInput || currentStart);
      const end = validateClockTime(endInput || currentEnd);
      schedule = {
        ...schedule,
        windows: [{ days, start, end }],
      };
    }

    const defaultTaskTypes = resolveDefaultLocalSolverTaskTypes(
      config.solver.taskTypes,
    );
    const taskTypesInput = await prompter.ask(
      `Task types CSV (${LOCAL_SOLVER_TASK_TYPES.join(", ")}) [${defaultTaskTypes.join(",")}]: `,
    );
    const taskTypes = parseTaskTypeList(taskTypesInput, defaultTaskTypes);

    const excludedInput = await prompter.ask(
      `Excluded billing types CSV (${BILLING_TYPES.join(", ")}) [${config.solver.excludedBillingTypes.join(",")}]: `,
    );
    const excludedBillingTypes = parseBillingTypeList(
      excludedInput,
      config.solver.excludedBillingTypes,
    );

    const notificationChannelInput = await prompter.ask(
      `Notification channel [${config.notifications.channel}]: `,
    );
    const notificationTargetInput = await prompter.ask(
      `Notification target [${config.notifications.target}]: `,
    );
    const thresholdInput = await prompter.ask(
      `Earnings threshold [${config.notifications.earningsThreshold}]: `,
    );
    const dailySummaryInput = await prompter.ask(
      `Daily summary (yes/no) [${config.notifications.dailySummary ? "yes" : "no"}]: `,
    );

    const earningsThreshold = parseNumberInput(
      thresholdInput,
      config.notifications.earningsThreshold,
    );
    const dailySummary = parseBooleanInput(
      dailySummaryInput,
      config.notifications.dailySummary,
    );

    const updated: ClawrmaConfig = {
      ...config,
      solver: {
        ...config.solver,
        schedule,
        taskTypes,
        excludedBillingTypes,
      },
      notifications: {
        ...config.notifications,
        channel: notificationChannelInput || config.notifications.channel,
        target: notificationTargetInput || config.notifications.target,
        earningsThreshold,
        dailySummary,
      },
    };

    if (options.persistConfig ?? true) {
      await writeConfig(updated);
    }

    return updated;
  } finally {
    prompter.close();
  }
}

/**
 * Chooses the local-runtime task types that should be offered as prompt defaults.
 */
export function resolveDefaultLocalSolverTaskTypes(
  taskTypes: TaskType[],
): TaskType[] {
  const localTaskTypeSet = new Set<string>(LOCAL_SOLVER_TASK_TYPES);
  const filtered = taskTypes.filter((taskType) =>
    localTaskTypeSet.has(taskType),
  );
  return filtered.length > 0 ? filtered : [...LOCAL_SOLVER_TASK_TYPES];
}

/**
 * Connects to the solver WebSocket and sends a pause or resume control message.
 */
export async function sendSolverControlSignal(
  config: ClawrmaConfig,
  signal: "resume" | "pause",
  options: SolverControlOptions = {},
): Promise<void> {
  const wsFactory = options.wsFactory ?? createWebSocket;
  const ws = wsFactory(config);
  const timeoutMs =
    options.connectionTimeoutMs ?? DEFAULT_CONTROL_CONNECTION_TIMEOUT_MS;

  try {
    await waitForWsConnection(ws, timeoutMs);
    if (signal === "resume") {
      sendResume(ws);
      return;
    }
    sendPause(ws, "user");
  } finally {
    ws.close();
  }
}

/**
 * Waits for a solver control WebSocket to become connected before sending.
 */
export async function waitForWsConnection(
  ws: WebSocketManager,
  timeoutMs: number,
): Promise<void> {
  if (ws.isConnected()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for solver connection after ${timeoutMs}ms. Start the solver first with: npx clawrma solver run`,
        ),
      );
    }, timeoutMs);

    const unsubscribe = ws.onConnectionChange((connected) => {
      if (!connected) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Creates the default interactive readline-based solver configuration prompter.
 */
export function createDefaultPrompter(): SolverConfigPrompter {
  const rl = createPromptInterface({
    input: processStdin,
    output: processStdout,
  });

  return {
    ask(prompt: string): Promise<string> {
      return rl.question(prompt).then((answer) => answer.trim());
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Parses a CSV list of task types, preserving the fallback when blank.
 */
export function parseTaskTypeList(
  input: string,
  fallback: TaskType[],
): TaskType[] {
  if (!input.trim()) {
    return fallback;
  }

  const rawEntries = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (rawEntries.length === 0) {
    throw new Error(
      `At least one task type must be selected from: ${TASK_TYPES.join(", ")}.`,
    );
  }

  const invalid = rawEntries.filter(
    (entry) => !(TASK_TYPES as readonly string[]).includes(entry),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid task type(s): ${invalid.join(", ")}. Expected values: ${TASK_TYPES.join(", ")}.`,
    );
  }

  const parsed = rawEntries as TaskType[];

  return Array.from(new Set(parsed));
}

/**
 * Parses a CSV list of excluded billing types, with `none` clearing the list.
 */
export function parseBillingTypeList(
  input: string,
  fallback: BillingType[],
): BillingType[] {
  if (!input.trim()) {
    return fallback;
  }

  const rawEntries = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (rawEntries.length === 1 && rawEntries[0]?.toLowerCase() === "none") {
    return [];
  }

  const invalid = rawEntries.filter(
    (entry) => !BILLING_TYPES.includes(entry as BillingType),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid billing type(s): ${invalid.join(", ")}. Expected values: ${BILLING_TYPES.join(", ")}.`,
    );
  }

  const parsed = rawEntries as BillingType[];

  return Array.from(new Set(parsed));
}

/**
 * Parses a non-negative numeric prompt input, falling back when blank.
 */
export function parseNumberInput(input: string, fallback: number): number {
  if (!input.trim()) {
    return fallback;
  }

  const parsed = Number.parseFloat(input);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value '${input}'.`);
  }

  return parsed;
}

/**
 * Parses a yes/no style prompt input, falling back when blank.
 */
export function parseBooleanInput(input: string, fallback: boolean): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "true" ||
    normalized === "1"
  ) {
    return true;
  }
  if (
    normalized === "no" ||
    normalized === "n" ||
    normalized === "false" ||
    normalized === "0"
  ) {
    return false;
  }

  throw new Error(`Invalid boolean value '${input}'. Expected yes/no.`);
}
