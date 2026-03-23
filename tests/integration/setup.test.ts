import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CAN_RUN_LIVE_INTEGRATION, LIVE_API_BASE_URL } from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;

describeLive("integration setup", () => {
  it("runs full setup with framework none in non-interactive mode", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "clawrma-live-setup-"));
    const originalEnv = { ...process.env };

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      process.env.CI = "1";

      vi.resetModules();
      const { runSetup } = await import("../../src/setup.js");
      await runSetup({
        framework: "none",
        interactive: false,
        solver: "off",
        schedule: "overnight",
        apiBaseUrl: LIVE_API_BASE_URL,
      });

      const { readConfig } = await import("../../src/config.js");
      const config = await readConfig();
      expect(config).not.toBeNull();
      expect(config?.framework).toBe("none");
      expect(config?.apiBaseUrl).toBe(LIVE_API_BASE_URL);
      expect(config?.accountId.length ?? 0).toBeGreaterThan(0);
      expect(config?.apiKey.length ?? 0).toBeGreaterThan(0);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }

      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
