import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectionResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
  registerAccount: vi.fn(),
  getStatus: vi.fn(),
  truncateKey: vi.fn((value: string) => value),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  detectCapabilities: vi.fn(),
  injectFirecrawlConfig: vi.fn(),
  injectProvider: vi.fn(),
  invertActiveHoursToSolverWindows: vi.fn((windows: unknown) => windows),
  loadOpenClawConfigForWrite: vi.fn(),
  readOpenClawConfig: vi.fn(),
  writeClawrmaApiKey: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: mocks.createInterface,
}));

vi.mock("./client.js", () => ({
  registerAccount: mocks.registerAccount,
  getStatus: mocks.getStatus,
  truncateKey: mocks.truncateKey,
}));

vi.mock("./config.js", () => ({
  readConfig: mocks.readConfig,
  writeConfig: mocks.writeConfig,
}));

vi.mock("./detect.js", () => ({
  detectCapabilities: mocks.detectCapabilities,
}));

vi.mock("./integrations/openclaw.js", () => ({
  injectFirecrawlConfig: mocks.injectFirecrawlConfig,
  injectProvider: mocks.injectProvider,
  invertActiveHoursToSolverWindows: mocks.invertActiveHoursToSolverWindows,
  loadOpenClawConfigForWrite: mocks.loadOpenClawConfigForWrite,
  readOpenClawConfig: mocks.readOpenClawConfig,
  writeClawrmaApiKey: mocks.writeClawrmaApiKey,
}));

const { runSetup } = await import("./setup.js");

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

function makeDetectionResult(): DetectionResult {
  return {
    providers: [],
    browserAvailable: false,
    notificationChannels: [],
    activeHours: null,
    existingSearchConfig: false,
    existingFirecrawlConfig: false,
  };
}

function makeStatusResponse() {
  return {
    balance: 200,
    solverState: {
      activeTasks: 0,
      tasksSolvedToday: 0,
      tasksSolvedTotal: 0,
      earningsToday: 0,
      earningsTotal: 0,
      paused: false,
      connected: true,
    },
    recentActivity: {
      tasksSolvedToday: 0,
      earningsToday: 0,
    },
    uptimeSeconds: 0,
    capabilities: [],
  };
}

describe("runSetup non-interactive mode", () => {
  beforeEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "linux",
      });
    }

    mocks.registerAccount.mockReset();
    mocks.getStatus.mockReset();
    mocks.truncateKey.mockClear();
    mocks.readConfig.mockReset();
    mocks.writeConfig.mockReset();
    mocks.detectCapabilities.mockReset();
    mocks.injectFirecrawlConfig.mockReset();
    mocks.injectProvider.mockReset();
    mocks.invertActiveHoursToSolverWindows.mockClear();
    mocks.loadOpenClawConfigForWrite.mockReset();
    mocks.readOpenClawConfig.mockReset();
    mocks.writeClawrmaApiKey.mockReset();
    mocks.createInterface.mockReset();
    mocks.readConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("throws when required non-interactive flags are missing", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());

    await expect(
      runSetup({
        framework: "openclaw",
        interactive: false,
        solver: "on",
      }),
    ).rejects.toThrow(
      "Non-interactive setup requires these flags: --schedule <preset>",
    );
  });

  it("does not require web-fetch-fallback for non-interactive openclaw setup", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeClawrmaApiKey.mockResolvedValue(undefined);
    mocks.readOpenClawConfig.mockResolvedValue(null);
    mocks.writeConfig.mockResolvedValue(undefined);

    await expect(
      runSetup({
        framework: "openclaw",
        interactive: false,
        solver: "on",
        schedule: "overnight",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips ASK blocks and writes expected config in non-interactive mode", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeClawrmaApiKey.mockResolvedValue(undefined);
    mocks.readOpenClawConfig.mockResolvedValue(null);
    mocks.writeConfig.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSetup({
      framework: "openclaw",
      interactive: false,
      solver: "on",
      schedule: "overnight",
      webFetchFallback: "no",
    });

    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).not.toContain("[ASK THE USER]");
    expect(combinedOutput).toContain(
      "Sandboxed or containerized agents may have restricted behavior. Review your environment manually before enabling deeper framework integration.",
    );
    expect(combinedOutput).toContain("✓ Solver configured     enabled");
    expect(combinedOutput).toContain("Run: npx clawrma solver run");
    expect(combinedOutput).not.toContain(["Provider", "injected"].join(" "));
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        framework: "openclaw",
        solver: expect.objectContaining({
          enabled: true,
          schedule: expect.objectContaining({
            preset: "overnight",
          }),
          taskTypes: ["proxy_fetch", "web_search", "llm_inference"],
        }),
        webFetchFallback: {
          injected: false,
          method: "none",
        },
      }),
    );
    expect(mocks.writeConfig.mock.calls[0]?.[0]).not.toHaveProperty("provider");
    expect(mocks.injectProvider).not.toHaveBeenCalled();
  });

  it("does not invoke Firecrawl setup even when web-fetch-fallback is requested", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeClawrmaApiKey.mockResolvedValue(undefined);
    mocks.readOpenClawConfig.mockResolvedValue(null);
    mocks.writeConfig.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runSetup({
        framework: "openclaw",
        interactive: false,
        solver: "on",
        schedule: "overnight",
        webFetchFallback: "yes",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.injectFirecrawlConfig).not.toHaveBeenCalled();
    expect(mocks.injectProvider).not.toHaveBeenCalled();
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        solver: expect.objectContaining({
          taskTypes: ["proxy_fetch", "web_search", "llm_inference"],
        }),
        webFetchFallback: {
          injected: false,
          method: "none",
        },
      }),
    );

    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).toContain(
      "Firecrawl web_fetch fallback setup is disabled in this launch phase; OpenClaw config was not changed.",
    );
    expect(combinedOutput).not.toContain(
      "Configure Clawrma as Firecrawl backend for web_fetch fallback",
    );
  });

  it("does not emit provider fallback prompt text in interactive mode", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeClawrmaApiKey.mockResolvedValue(undefined);
    mocks.readOpenClawConfig.mockResolvedValue(null);
    mocks.writeConfig.mockResolvedValue(undefined);
    mocks.createInterface.mockReturnValue({
      question: vi
        .fn()
        .mockResolvedValueOnce("n")
        .mockResolvedValueOnce("overnight"),
      close: vi.fn(),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSetup({
      framework: "openclaw",
      interactive: true,
    });

    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).not.toContain(
      "Inject clawrma/strong into fallback chain",
    );
    expect(mocks.injectProvider).not.toHaveBeenCalled();
  });

  it("skips capability detection for framework none in non-interactive mode", async () => {
    mocks.detectCapabilities.mockRejectedValue(
      new Error("detect should be skipped"),
    );
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeConfig.mockResolvedValue(undefined);

    await runSetup({
      framework: "none",
      interactive: false,
      solver: "off",
      schedule: "overnight",
    });

    expect(mocks.detectCapabilities).not.toHaveBeenCalled();
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfig.mock.calls[0]?.[0]).not.toHaveProperty("provider");
    expect(mocks.injectProvider).not.toHaveBeenCalled();
  });

  it("reports solver as configured but disabled when setup leaves solving off", async () => {
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeConfig.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSetup({
      framework: "none",
      interactive: false,
      solver: "off",
      schedule: "overnight",
    });

    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).toContain("✓ Solver configured     disabled");
    expect(combinedOutput).not.toContain("Run: npx clawrma solver run");
  });

  it("reuses an existing account for the same api base url", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.readConfig.mockResolvedValue({
      version: 1,
      accountId: "cr_usr_existing",
      apiKey: "cr_sk_existing",
      apiBaseUrl: "https://api.clawrma.com",
      framework: "none",
      solver: {
        enabled: false,
        schedule: {
          preset: "off",
          source: "manual",
          timezone: "UTC",
          windows: [],
        },
        taskTypes: ["proxy_fetch", "web_search", "llm_inference"],
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
      notifications: {
        channel: null,
        target: "",
        earningsThreshold: 1,
        dailySummary: true,
      },
      welcomeCredit: 200,
      installedAt: "2026-03-10T00:00:00.000Z",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeConfig.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSetup({
      framework: "none",
      interactive: false,
      solver: "off",
      schedule: "overnight",
    });

    expect(mocks.registerAccount).not.toHaveBeenCalled();
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "cr_usr_existing",
        apiKey: "cr_sk_existing",
      }),
    );
    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).toContain(
      "Reusing cr_sk_existing (cr_usr_existing) from existing config",
    );
  });

  it("registers only after interactive choices are collected", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_test",
      apiKey: "cr_sk_test",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeConfig.mockResolvedValue(undefined);

    const order: string[] = [];
    mocks.createInterface.mockReturnValue({
      question: vi.fn(async () => {
        order.push("question");
        return "n";
      }),
      close: vi.fn(),
    });
    mocks.registerAccount.mockImplementation(async () => {
      order.push("register");
      return {
        accountId: "cr_usr_test",
        apiKey: "cr_sk_test",
      };
    });

    await runSetup({
      framework: "none",
      interactive: true,
    });

    expect(order.indexOf("question")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("register")).toBeGreaterThan(
      order.indexOf("question"),
    );
  });

  it("does not register an account when interactive prompt collection aborts", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.createInterface.mockReturnValue({
      question: vi.fn(async () => {
        throw new Error("prompt aborted");
      }),
      close: vi.fn(),
    });

    await expect(
      runSetup({
        framework: "none",
        interactive: true,
      }),
    ).rejects.toThrow("prompt aborted");

    expect(mocks.registerAccount).not.toHaveBeenCalled();
    expect(mocks.writeConfig).not.toHaveBeenCalled();
  });

  it("replaces invalid json config on successful setup", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.readConfig.mockRejectedValue(
      new Error("Config at /tmp/.clawrma/config.json is not valid JSON."),
    );
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_recovered",
      apiKey: "cr_sk_recovered",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeConfig.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSetup({
      framework: "none",
      interactive: false,
      solver: "off",
      schedule: "overnight",
    });

    expect(mocks.registerAccount).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "cr_usr_recovered",
        apiKey: "cr_sk_recovered",
      }),
    );
    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).toContain(
      "Existing Clawrma config is invalid and will be replaced",
    );
  });

  it("replaces schema-invalid config on successful setup", async () => {
    mocks.detectCapabilities.mockResolvedValue(makeDetectionResult());
    mocks.readConfig.mockRejectedValue(
      new Error(
        "Config at /tmp/.clawrma/config.json does not match ClawrmaConfig schema.",
      ),
    );
    mocks.registerAccount.mockResolvedValue({
      accountId: "cr_usr_schema",
      apiKey: "cr_sk_schema",
    });
    mocks.getStatus.mockResolvedValue(makeStatusResponse());
    mocks.writeConfig.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSetup({
      framework: "none",
      interactive: false,
      solver: "off",
      schedule: "overnight",
    });

    expect(mocks.registerAccount).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "cr_usr_schema",
        apiKey: "cr_sk_schema",
      }),
    );
    const combinedOutput = logSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n");
    expect(combinedOutput).toContain("does not match ClawrmaConfig schema");
  });
});
