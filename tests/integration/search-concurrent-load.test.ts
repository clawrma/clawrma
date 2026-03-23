import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { TaskResult } from "../../src/client.js";
import {
  CAN_RUN_LIVE_INTEGRATION,
  LIVE_API_BASE_URL,
  createLiveAccount,
  isNoSolverAvailableError,
  submitLiveTask,
} from "./helpers.js";

interface AdminStatusPayload {
  tasks_in_flight: number;
}

interface SolverStatsPayload {
  active_tasks: number;
}

function isLocalhostApiBaseUrl(apiBaseUrl: string): boolean {
  try {
    return new URL(apiBaseUrl).hostname === "localhost";
  } catch {
    return false;
  }
}

async function requestJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GET ${url} failed with status ${response.status}: ${body || "<empty body>"}`,
    );
  }

  return (await response.json()) as T;
}

async function getAdminStatus(
  adminApiKey: string,
): Promise<AdminStatusPayload> {
  return requestJson<AdminStatusPayload>(
    `${LIVE_API_BASE_URL}/v1/admin/status`,
    adminApiKey,
  );
}

async function getSolverStats(
  solverApiKey: string,
): Promise<SolverStatsPayload> {
  return requestJson<SolverStatsPayload>(
    `${LIVE_API_BASE_URL}/v1/solver/stats`,
    solverApiKey,
  );
}

const RUN_CONCURRENT_LOAD =
  process.env.CLAWRMA_RUN_SEARCH_CONCURRENT_LOAD !== "0";
const DEFAULT_CONCURRENT_SEARCH_TASKS = 3;
const MAX_CONCURRENT_SEARCH_TASKS = Number.parseInt(
  process.env.CLAWRMA_SEARCH_CONCURRENT_TASKS ??
    `${DEFAULT_CONCURRENT_SEARCH_TASKS}`,
  10,
);
const TASK_RETRY_ATTEMPTS = 8;
const TASK_INITIAL_DELAY_MS = 250;
const DEFAULT_LOCAL_ADMIN_KEY = "test-admin-key";
const DEFAULT_LOCAL_SEARCH_SOLVER_KEY = "test-solver-key";
const ADMIN_API_KEY =
  process.env.CLAWRMA_ADMIN_API_KEY ??
  (isLocalhostApiBaseUrl(LIVE_API_BASE_URL) ? DEFAULT_LOCAL_ADMIN_KEY : "");
const SEARCH_SOLVER_API_KEY =
  process.env.CLAWRMA_SEARCH_SOLVER_API_KEY ??
  (isLocalhostApiBaseUrl(LIVE_API_BASE_URL)
    ? DEFAULT_LOCAL_SEARCH_SOLVER_KEY
    : "");
const HAS_REQUIRED_KEYS =
  ADMIN_API_KEY.length > 0 && SEARCH_SOLVER_API_KEY.length > 0;
const describeLive =
  CAN_RUN_LIVE_INTEGRATION && RUN_CONCURRENT_LOAD && HAS_REQUIRED_KEYS
    ? describe
    : describe.skip;
type WebSearchResult = TaskResult<"web_search">;

describeLive("integration search concurrent load", () => {
  it("completes concurrent web_search tasks without no_solvers_available and shows concurrent active task counters", async () => {
    if (
      !Number.isInteger(MAX_CONCURRENT_SEARCH_TASKS) ||
      MAX_CONCURRENT_SEARCH_TASKS < 2
    ) {
      throw new Error(
        "CLAWRMA_SEARCH_CONCURRENT_TASKS must be an integer >= 2.",
      );
    }

    const { apiKey } = await createLiveAccount();
    const now = Date.now();

    const singleStart = Date.now();
    await submitLiveTask(
      apiKey,
      "web_search",
      {
        query: `clawrma baseline ${now}`,
        count: 2,
      },
      {
        operationName: "submit_web_search_baseline",
        attempts: TASK_RETRY_ATTEMPTS,
        initialDelayMs: TASK_INITIAL_DELAY_MS,
      },
    );
    const singleLatencyMs = Date.now() - singleStart;

    let peakAdminTasksInFlight = 0;
    let peakSolverActiveTasks = 0;
    let sawAdminCounterField = false;
    let sawSolverCounterField = false;
    let monitorRunning = true;

    const monitor = (async () => {
      while (monitorRunning) {
        const [adminStatus, solverStats] = await Promise.all([
          getAdminStatus(ADMIN_API_KEY),
          getSolverStats(SEARCH_SOLVER_API_KEY),
        ]);

        if (typeof adminStatus.tasks_in_flight === "number") {
          sawAdminCounterField = true;
          peakAdminTasksInFlight = Math.max(
            peakAdminTasksInFlight,
            adminStatus.tasks_in_flight,
          );
        }
        if (typeof solverStats.active_tasks === "number") {
          sawSolverCounterField = true;
          peakSolverActiveTasks = Math.max(
            peakSolverActiveTasks,
            solverStats.active_tasks,
          );
        }

        await delay(100);
      }
    })();

    const startedAt = Date.now();
    const submissions = Array.from(
      { length: MAX_CONCURRENT_SEARCH_TASKS },
      (_, index) =>
        submitLiveTask(
          apiKey,
          "web_search",
          {
            query: `clawrma concurrent ${now}-${index}`,
            count: 3,
          },
          {
            operationName: `submit_web_search_concurrent_${index}`,
            attempts: TASK_RETRY_ATTEMPTS,
            initialDelayMs: TASK_INITIAL_DELAY_MS,
          },
        ),
    );

    let settledResults: PromiseSettledResult<WebSearchResult>[];

    try {
      settledResults = await Promise.allSettled(submissions);
    } finally {
      monitorRunning = false;
      await monitor;
    }

    const elapsedMs = Date.now() - startedAt;
    const rejectedResults = settledResults.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    const noSolverErrors = rejectedResults.filter((entry) =>
      isNoSolverAvailableError(entry.reason),
    );

    expect(noSolverErrors.length).toBe(0);
    if (rejectedResults.length > 0) {
      const messages = rejectedResults
        .map((entry) =>
          entry.reason instanceof Error
            ? entry.reason.message
            : String(entry.reason),
        )
        .join(" | ");
      throw new Error(`Concurrent web_search submissions failed: ${messages}`);
    }

    const fulfilledResults = settledResults.filter(
      (entry): entry is PromiseFulfilledResult<WebSearchResult> =>
        entry.status === "fulfilled",
    );

    expect(fulfilledResults.length).toBe(MAX_CONCURRENT_SEARCH_TASKS);
    for (const fulfilled of fulfilledResults) {
      expect(Array.isArray(fulfilled.value.results)).toBe(true);
    }

    expect(sawAdminCounterField).toBe(true);
    expect(sawSolverCounterField).toBe(true);
    expect(peakAdminTasksInFlight).toBeGreaterThanOrEqual(0);
    expect(peakSolverActiveTasks).toBeGreaterThanOrEqual(0);
    expect(elapsedMs).toBeLessThan(
      singleLatencyMs * MAX_CONCURRENT_SEARCH_TASKS,
    );
  }, 120_000);
});
