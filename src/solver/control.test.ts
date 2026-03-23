import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawrmaConfig, SolverSchedule } from "../types.js";
import type {
  ConnectionChangeHandler,
  MessageHandler,
  WebSocketManager,
} from "../ws.js";

const TEST_CONFIG_DIR = vi.hoisted(
  () => `/tmp/clawrma-control-test-config-${process.pid}`,
);

vi.mock("../constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../constants.js")>();

  return {
    ...actual,
    CONFIG_DIR: TEST_CONFIG_DIR,
    CONFIG_PATH: `${TEST_CONFIG_DIR}/config.json`,
    SCHEMA_PATH: `${TEST_CONFIG_DIR}/config.schema.json`,
    LOG_DIR: `${TEST_CONFIG_DIR}/logs`,
  };
});

import { readConfig } from "../config.js";
import {
  parseBillingTypeList,
  parseBooleanInput,
  parseNumberInput,
  parseTaskTypeList,
  reconfigureSolver,
  startSolverIntake,
  stopSolverIntake,
  waitForWsConnection,
  type SolverConfigPrompter,
} from "./control.js";

class FakeWebSocketManager implements WebSocketManager {
  public sent: object[] = [];
  private connected: boolean;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly connectionHandlers = new Set<ConnectionChangeHandler>();

  constructor(connected: boolean = true) {
    this.connected = connected;
  }

  public send(message: object): void {
    this.sent.push(message);
  }

  public close(): void {
    this.connected = false;
    this.emitConnection(false);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onConnectionChange(handler: ConnectionChangeHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  public setIdleStateProvider(_provider: () => boolean): void {
    // Control-path tests do not use idle state callbacks.
  }

  public setConnected(connected: boolean): void {
    this.connected = connected;
    this.emitConnection(connected);
  }

  private emitConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }
}

class StaticPrompter implements SolverConfigPrompter {
  private readonly answers: string[];
  private index = 0;

  constructor(answers: string[]) {
    this.answers = answers;
  }

  public async ask(_prompt: string): Promise<string> {
    const answer = this.answers[this.index];
    this.index += 1;
    return answer ?? "";
  }

  public close(): void {
    // no-op
  }
}

function overnightSchedule(): SolverSchedule {
  return {
    preset: "overnight",
    source: "manual",
    timezone: "UTC",
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "00:00",
        end: "06:00",
      },
    ],
  };
}

function getMessagesByType(
  messages: object[],
  type: string,
): Record<string, unknown>[] {
  return messages.filter((message): message is Record<string, unknown> => {
    const record = message as Record<string, unknown>;
    return record.type === type;
  });
}

function makeConfig(schedule: SolverSchedule): ClawrmaConfig {
  return {
    version: 1,
    accountId: "cr_usr_test",
    apiKey: "cr_sk_test",
    apiBaseUrl: "http://127.0.0.1:8000",
    framework: "none",
    solver: {
      enabled: true,
      schedule,
      taskTypes: ["proxy_fetch"],
      excludedBillingTypes: [],
      domainPolicy: "allowlist",
    },
    webFetchFallback: {
      injected: false,
      method: "none",
    },
    notifications: {
      channel: "",
      target: "",
      earningsThreshold: 1,
      dailySummary: false,
    },
    welcomeCredit: 200,
    installedAt: "2026-02-25T00:00:00.000Z",
  };
}

beforeEach(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
});

describe("solver control commands", () => {
  it("sends resume and enables solver on solver start", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig(overnightSchedule());
    config.solver.enabled = false;

    const updated = await startSolverIntake(config, {
      wsFactory: () => fakeWs,
      persistConfig: false,
    });

    expect(updated.solver.enabled).toBe(true);
    expect(getMessagesByType(fakeWs.sent, "resume")).toHaveLength(1);
  });

  it("persists solver control config updates with writeConfig/readConfig", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig(overnightSchedule());
    config.solver.enabled = false;

    const updated = await startSolverIntake(config, {
      wsFactory: () => fakeWs,
    });

    await expect(readConfig()).resolves.toEqual(updated);
  });

  it("sends user pause and disables solver on solver stop", async () => {
    const fakeWs = new FakeWebSocketManager();
    const config = makeConfig(overnightSchedule());
    config.solver.enabled = true;

    const updated = await stopSolverIntake(config, {
      wsFactory: () => fakeWs,
      persistConfig: false,
    });

    expect(updated.solver.enabled).toBe(false);
    const pauseMessage = getMessagesByType(fakeWs.sent, "pause")[0];
    expect(pauseMessage).toEqual({ type: "pause", reason: "user" });
  });

  it("reconfigures schedule/task types/excluded billing/notifications interactively", async () => {
    const config = makeConfig(overnightSchedule());
    const prompter = new StaticPrompter([
      "idle-always",
      "proxy_fetch,llm_inference",
      "per_token,subscription",
      "telegram",
      "@chat",
      "5",
      "yes",
    ]);

    const updated = await reconfigureSolver(config, {
      prompter,
      persistConfig: false,
    });

    expect(updated.solver.schedule.preset).toBe("idle-always");
    expect(updated.solver.taskTypes).toEqual(["proxy_fetch", "llm_inference"]);
    expect(updated.solver.excludedBillingTypes).toEqual([
      "per_token",
      "subscription",
    ]);
    expect(updated.notifications.channel).toBe("telegram");
    expect(updated.notifications.target).toBe("@chat");
    expect(updated.notifications.earningsThreshold).toBe(5);
    expect(updated.notifications.dailySummary).toBe(true);
  });

  it("uses prompt defaults for blank answers during solver reconfiguration", async () => {
    const config = makeConfig(overnightSchedule());
    config.solver.taskTypes = [
      "proxy_fetch",
      "screenshot",
      "page_snapshot",
      "web_search",
      "llm_inference",
    ];
    config.notifications.channel = "slack";
    config.notifications.target = "#alerts";
    config.notifications.earningsThreshold = 25;
    config.notifications.dailySummary = true;

    const prompter = new StaticPrompter([
      "idle-always",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);

    const updated = await reconfigureSolver(config, {
      prompter,
      persistConfig: false,
    });

    expect(updated.solver.taskTypes).toEqual([
      "proxy_fetch",
      "web_search",
      "llm_inference",
    ]);
    expect(updated.notifications.channel).toBe("slack");
    expect(updated.notifications.target).toBe("#alerts");
    expect(updated.notifications.earningsThreshold).toBe(25);
    expect(updated.notifications.dailySummary).toBe(true);
  });

  it("surfaces invalid task types during solver reconfiguration", async () => {
    const config = makeConfig(overnightSchedule());
    const prompter = new StaticPrompter([
      "idle-always",
      "proxy_fetch,invalid_task",
    ]);

    await expect(
      reconfigureSolver(config, {
        prompter,
        persistConfig: false,
      }),
    ).rejects.toThrow("Invalid task type(s): invalid_task.");
  });

  it("surfaces invalid billing types during solver reconfiguration", async () => {
    const config = makeConfig(overnightSchedule());
    const prompter = new StaticPrompter([
      "idle-always",
      "proxy_fetch,llm_inference",
      "subscription,not-real-billing",
    ]);

    await expect(
      reconfigureSolver(config, {
        prompter,
        persistConfig: false,
      }),
    ).rejects.toThrow("Invalid billing type(s): not-real-billing.");
  });
});

describe("solver control helpers", () => {
  it("parses task-type CSV values and dedupes them", () => {
    expect(
      parseTaskTypeList("proxy_fetch, llm_inference, proxy_fetch", [
        "web_search",
      ]),
    ).toEqual(["proxy_fetch", "llm_inference"]);
    expect(parseTaskTypeList("", ["web_search"])).toEqual(["web_search"]);
  });

  it("parses billing-type CSV values, supports none, and rejects invalid entries", () => {
    expect(
      parseBillingTypeList("subscription, per_token, subscription", [
        "free_tier",
      ]),
    ).toEqual(["subscription", "per_token"]);
    expect(parseBillingTypeList("none", ["free_tier"])).toEqual([]);
    expect(() => parseBillingTypeList("not-real", [])).toThrow(
      "Invalid billing type(s): not-real.",
    );
  });

  it("parses numeric prompt input with fallback and validation", () => {
    expect(parseNumberInput("", 0.5)).toBe(0.5);
    expect(parseNumberInput("0.25", 0.5)).toBe(0.25);
    expect(() => parseNumberInput("-1", 0.5)).toThrow(
      "Invalid numeric value '-1'.",
    );
  });

  it("parses boolean prompt input with fallback and validation", () => {
    expect(parseBooleanInput("", true)).toBe(true);
    expect(parseBooleanInput("yes", false)).toBe(true);
    expect(parseBooleanInput("0", true)).toBe(false);
    expect(() => parseBooleanInput("maybe", true)).toThrow(
      "Invalid boolean value 'maybe'. Expected yes/no.",
    );
  });

  it("times out while waiting for a solver control websocket connection", async () => {
    const fakeWs = new FakeWebSocketManager(false);

    await expect(waitForWsConnection(fakeWs, 5)).rejects.toThrow(
      "Timed out waiting for solver connection after 5ms. Start the solver first with: npx clawrma solver run",
    );
  });
});
