import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawrmaConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("./logging.js", () => ({
  notifyLogger: {
    warn: mocks.warn,
  },
}));

const { sendNotification } = await import("./notify.js");

function makeConfig(): ClawrmaConfig {
  return {
    version: 1,
    accountId: "cr_usr_test",
    apiKey: "cr_sk_test",
    apiBaseUrl: "https://api.clawrma.com",
    framework: "openclaw",
    solver: {
      enabled: true,
      schedule: {
        preset: "overnight",
        source: "manual",
        timezone: "UTC",
        windows: [],
      },
      taskTypes: ["proxy_fetch"],
      excludedBillingTypes: ["per_token"],
      domainPolicy: "allowlist",
    },
    webFetchFallback: {
      injected: false,
      method: "none",
    },
    notifications: {
      channel: "telegram",
      target: "@chat",
      earningsThreshold: 1,
      dailySummary: true,
    },
    welcomeCredit: 200,
    installedAt: "2026-02-25T00:00:00.000Z",
  };
}

describe("sendNotification", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
    mocks.warn.mockReset();
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null) => void,
      ) => {
        callback(null);
      },
    );
  });

  it("returns silently for framework none", async () => {
    const config = makeConfig();
    config.framework = "none";

    await sendNotification(config, "test");

    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("returns silently when notification channel is null", async () => {
    const config = makeConfig();
    config.notifications.channel = null;

    await sendNotification(config, "test");

    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("invokes openclaw message send with a 10s timeout", async () => {
    const config = makeConfig();

    await sendNotification(config, "Earned 0.10 points");

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const call = mocks.execFile.mock.calls[0] as unknown[] | undefined;
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("openclaw");
    expect(call?.[1]).toEqual([
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "@chat",
      "--message",
      "Earned 0.10 points",
      "--json",
    ]);
    expect(call?.[2]).toEqual({ timeout: 10_000 });
  });

  it("logs warning and does not throw when command execution fails", async () => {
    const config = makeConfig();
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error("openclaw command failed"));
      },
    );

    await expect(sendNotification(config, "test")).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
