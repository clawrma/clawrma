import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawrmaConfig } from "./types.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  classifyBillingType,
  classifyFulfillmentPath,
  detectCapabilities,
} from "./detect.js";
import { buildSolverCapabilities } from "./solver.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockCommandsUnavailable(): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error("command unavailable"), "", "");
    },
  );
}

function makeConfig(
  taskTypes: ClawrmaConfig["solver"]["taskTypes"],
): ClawrmaConfig {
  return {
    version: 1,
    accountId: "cr_usr_test",
    apiKey: "cr_sk_test",
    apiBaseUrl: "http://127.0.0.1:8000",
    framework: "none",
    solver: {
      enabled: true,
      schedule: {
        preset: "overnight",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "08:00",
          },
        ],
      },
      taskTypes,
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

describe("classifyBillingType", () => {
  it("classifies Anthropic API key as per_token", () => {
    expect(
      classifyBillingType({
        name: "anthropic",
        endpoint: "https://api.anthropic.com",
        apiKey: "sk-ant-123",
      }),
    ).toBe("per_token");
  });

  it("classifies localhost providers as local", () => {
    expect(
      classifyBillingType({
        name: "ollama",
        endpoint: "http://localhost:11434/api/tags",
      }),
    ).toBe("local");
  });

  it("classifies Claude OAuth token as subscription", () => {
    expect(
      classifyBillingType({
        name: "claude-max",
        endpoint: "https://api.anthropic.com",
        token: "oauth_claude_token",
      }),
    ).toBe("subscription");
  });

  it("classifies OpenAI Codex OAuth token as subscription", () => {
    expect(
      classifyBillingType({
        name: "openai-codex",
        endpoint: "https://api.openai.com",
        token: "oauth_codex_token",
      }),
    ).toBe("subscription");
  });

  it("classifies sk-sess tokens as subscription for codex-like providers", () => {
    expect(
      classifyBillingType({
        name: "openai-codex",
        endpoint: "https://api.openai.com",
        token: "sk-sess-123",
      }),
    ).toBe("subscription");
  });

  it("classifies Gemini free-tier keys as free_tier", () => {
    expect(
      classifyBillingType({
        name: "gemini",
        endpoint: "https://generativelanguage.googleapis.com",
        apiKey: "AIzaSyFakeKey",
      }),
    ).toBe("free_tier");
  });
});

describe("classifyFulfillmentPath", () => {
  const cliAvailable = { claudeAvailable: true, codexAvailable: true };

  it("returns api for per-token provider", () => {
    expect(
      classifyFulfillmentPath(
        {
          name: "anthropic",
          endpoint: "https://api.anthropic.com",
          apiKey: "sk-ant-123",
        },
        cliAvailable,
      ),
    ).toBe("api");
  });

  it("returns api for local provider", () => {
    expect(
      classifyFulfillmentPath(
        {
          name: "ollama",
          endpoint: "http://localhost:11434/api/tags",
        },
        cliAvailable,
      ),
    ).toBe("api");
  });

  it("returns cli for Claude OAuth provider when claude is available", () => {
    expect(
      classifyFulfillmentPath(
        {
          name: "claude-max",
          endpoint: "https://api.anthropic.com",
          token: "oauth_claude_token",
        },
        { claudeAvailable: true, codexAvailable: false },
      ),
    ).toBe("cli");
  });

  it("returns cli_codex for OpenAI Codex OAuth provider when codex is available", () => {
    expect(
      classifyFulfillmentPath(
        {
          name: "openai-codex",
          endpoint: "https://api.openai.com",
          token: "oauth_codex_token",
        },
        { claudeAvailable: false, codexAvailable: true },
      ),
    ).toBe("cli_codex");
  });
});

describe("detectCapabilities", () => {
  it("treats blank built-in search env values as missing during setup-time detection", async () => {
    mockCommandsUnavailable();
    vi.stubEnv("BRAVE_API_KEY", "   ");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("local providers unavailable")),
    );

    const detection = await detectCapabilities("none");

    expect(detection.existingSearchConfig).toBe(false);
  });

  it("keeps setup-time search detection aligned with runtime advertisement", async () => {
    mockCommandsUnavailable();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("local providers unavailable")),
    );
    const config = makeConfig(["web_search"]);

    vi.stubEnv("BRAVE_API_KEY", "   ");
    const blankDetection = await detectCapabilities("none");
    const blankCapabilities = await buildSolverCapabilities(config);
    expect(blankDetection.existingSearchConfig).toBe(false);
    expect(blankCapabilities).not.toContainEqual(
      expect.objectContaining({ task_type: "web_search" }),
    );

    vi.stubEnv("BRAVE_API_KEY", " brave-test-key ");
    const configuredDetection = await detectCapabilities("none");
    const configuredCapabilities = await buildSolverCapabilities(config);
    expect(configuredDetection.existingSearchConfig).toBe(true);
    expect(configuredCapabilities).toContainEqual(
      expect.objectContaining({
        task_type: "web_search",
        provider_name: "clawrma-search",
        model_name: "web-search",
      }),
    );
  });

  it("keeps browser detection aligned with browser capability advertising", async () => {
    mockCommandsUnavailable();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("local providers unavailable")),
    );
    const config = makeConfig(["screenshot"]);
    const buildOptions = {
      detectCapabilitiesImpl: undefined,
      fulfillers: {
        screenshot: [
          {
            detect: (context: { playwrightAvailable: boolean }) =>
              context.playwrightAvailable
                ? {
                    task_type: "screenshot" as const,
                    billing_type: "local" as const,
                    fulfillment_path: "api" as const,
                    provider_name: "clawrma-browser",
                    model_name: "screenshot-v1",
                  }
                : null,
            fulfill: async () => ({
              image_base64: "c2NyZWVuc2hvdA==",
              format: "png",
            }),
          },
        ],
      },
    };

    const detection = await detectCapabilities("none");
    const capabilities = await buildSolverCapabilities(config, buildOptions);

    expect(detection.browserAvailable).toBe(false);
    expect(capabilities).toEqual([]);
  });
});
