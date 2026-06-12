import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawrmaConfig } from "./types.js";

const testPaths = vi.hoisted(() => ({
  configDir: "",
  configPath: "",
  schemaPath: "",
}));

vi.mock("./constants.js", () => ({
  get CONFIG_DIR() {
    return testPaths.configDir;
  },
  get CONFIG_PATH() {
    return testPaths.configPath;
  },
  get SCHEMA_PATH() {
    return testPaths.schemaPath;
  },
  TASK_TYPES: [
    "proxy_fetch",
    "screenshot",
    "page_snapshot",
    "web_search",
    "llm_inference",
  ],
  FULFILLMENT_PATHS: ["api", "cli", "cli_codex"],
  BILLING_TYPES: ["subscription", "per_token", "free_tier", "local"],
  DOMAIN_POLICIES: ["allowlist", "open"],
  SCHEDULE_PRESETS: [
    "outside-active-hours",
    "overnight",
    "idle-always",
    "custom",
    "off",
  ],
}));

function makeConfig(): ClawrmaConfig {
  return {
    version: 1,
    accountId: "cr_usr_test",
    apiKey: "cr_sk_test",
    apiBaseUrl: "https://api.clawrma.com",
    framework: "none",
    solver: {
      enabled: true,
      schedule: {
        preset: "overnight",
        source: "manual",
        timezone: "UTC",
        windows: [{ days: ["mon", "tue"], start: "22:00", end: "07:00" }],
      },
      taskTypes: ["proxy_fetch", "llm_inference"],
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
      dailySummary: false,
    },
    welcomeCredit: 200,
    installedAt: "2026-02-26T00:00:00.000Z",
  };
}

describe("config read/write", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawrma-config-test-"));
    testPaths.configDir = join(tempDir, ".clawrma");
    testPaths.configPath = join(testPaths.configDir, "config.json");
    testPaths.schemaPath = join(testPaths.configDir, "config.schema.json");
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes and reads config with schema sidecar", async () => {
    const { writeConfig, readConfig, configExists } =
      await import("./config.js");
    const config = makeConfig();

    await writeConfig(config);

    expect(configExists()).toBe(true);
    const loaded = await readConfig();
    expect(loaded).toEqual(config);

    const schemaRaw = await readFile(testPaths.schemaPath, "utf8");
    const schema = JSON.parse(schemaRaw) as { title?: unknown };
    expect(schema.title).toBe("ClawrmaConfig");
  });

  it("writes config secrets with restrictive permissions", async () => {
    const { writeConfig } = await import("./config.js");

    await writeConfig(makeConfig());

    const configStat = await stat(testPaths.configPath);
    const schemaStat = await stat(testPaths.schemaPath);
    const dirStat = await stat(testPaths.configDir);

    expect(configStat.mode & 0o777).toBe(0o600);
    expect(schemaStat.mode & 0o777).toBe(0o644);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("returns null when config file does not exist", async () => {
    const { readConfig, configExists } = await import("./config.js");
    expect(configExists()).toBe(false);
    await expect(readConfig()).resolves.toBeNull();
  });

  it("round-trips promptSafetyScan false", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const config = {
      ...makeConfig(),
      promptSafetyScan: false,
    };

    await writeConfig(config);

    await expect(readConfig()).resolves.toEqual(config);
  });

  it("preserves undefined promptSafetyScan when omitted", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const config = makeConfig();

    await writeConfig(config);

    await expect(readConfig()).resolves.toEqual(config);
  });

  it("round-trips promptSafetyScan true", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const config = {
      ...makeConfig(),
      promptSafetyScan: true,
    };

    await writeConfig(config);

    await expect(readConfig()).resolves.toEqual(config);
  });

  it("round-trips solver domainPolicy", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const config = {
      ...makeConfig(),
      solver: {
        ...makeConfig().solver,
        domainPolicy: "open" as const,
      },
    };

    await writeConfig(config);

    await expect(readConfig()).resolves.toEqual(config);
  });

  it("round-trips optional solver cliSandbox settings", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const config = {
      ...makeConfig(),
      solver: {
        ...makeConfig().solver,
        cliSandbox: {
          workspaceRoot: "/tmp/clawrma-workspaces",
          retainFailedWorkspaces: true,
        },
      },
    };

    await writeConfig(config);

    await expect(readConfig()).resolves.toEqual(config);
  });

  it("round-trips managed web search fallback state", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const config = {
      ...makeConfig(),
      webSearchFallback: {
        status: "injected" as const,
        method: "openclaw-managed-web-search" as const,
        configured: true,
        selectedProvider: "clawrma",
        preservedProvider: null,
        replacedProvider: "brave",
      },
    };

    await writeConfig(config);

    await expect(readConfig()).resolves.toEqual(config);
  });

  it("throws when persisted config fails schema validation", async () => {
    const { readConfig } = await import("./config.js");

    await mkdir(testPaths.configDir, { recursive: true });
    await writeFile(
      testPaths.configPath,
      JSON.stringify({
        version: 1,
        accountId: "cr_usr_test",
      }),
      "utf8",
    );

    await expect(readConfig()).rejects.toThrow(
      "does not match ClawrmaConfig schema",
    );
  });

  it("rejects invalid solver cliSandbox settings from disk", async () => {
    const { readConfig } = await import("./config.js");

    await mkdir(testPaths.configDir, { recursive: true });
    await writeFile(
      testPaths.configPath,
      JSON.stringify({
        ...makeConfig(),
        solver: {
          ...makeConfig().solver,
          cliSandbox: {
            retainFailedWorkspaces: "yes",
          },
        },
      }),
      "utf8",
    );

    await expect(readConfig()).rejects.toThrow(
      "does not match ClawrmaConfig schema",
    );
  });

  it("rejects invalid managed web search fallback state from disk", async () => {
    const { readConfig } = await import("./config.js");

    await mkdir(testPaths.configDir, { recursive: true });
    await writeFile(
      testPaths.configPath,
      JSON.stringify({
        ...makeConfig(),
        webSearchFallback: {
          status: "owned",
          method: "openclaw-managed-web-search",
          configured: true,
          selectedProvider: "clawrma",
          preservedProvider: null,
          replacedProvider: null,
        },
      }),
      "utf8",
    );

    await expect(readConfig()).rejects.toThrow(
      "does not match ClawrmaConfig schema",
    );
  });

  it("keeps the previous config and schema when an atomic rewrite cannot start", async () => {
    const { writeConfig, readConfig } = await import("./config.js");
    const originalConfig = makeConfig();
    const updatedConfig = {
      ...makeConfig(),
      accountId: "cr_usr_updated",
      apiKey: "cr_sk_updated",
    };

    await writeConfig(originalConfig);
    await chmod(testPaths.configDir, 0o555);

    await expect(writeConfig(updatedConfig)).rejects.toThrow();

    await chmod(testPaths.configDir, 0o755);

    await expect(readConfig()).resolves.toEqual(originalConfig);
    await expect(readFile(testPaths.schemaPath, "utf8")).resolves.toContain(
      '"title": "ClawrmaConfig"',
    );
    await expect(readdir(testPaths.configDir)).resolves.not.toContain(
      expect.stringMatching(/\.tmp$/),
    );
  });
});
