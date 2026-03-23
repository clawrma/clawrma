import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_SEARCH_PROVIDERS,
  listConfiguredBuiltInSearchProviders,
  normalizeConfiguredString,
  readNormalizedEnv,
} from "./builtins.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeConfiguredString", () => {
  it("trims configured values", () => {
    expect(normalizeConfiguredString(" brave-test-key ")).toBe(
      "brave-test-key",
    );
  });

  it("treats blank values as missing", () => {
    expect(normalizeConfiguredString("   ")).toBeNull();
  });
});

describe("readNormalizedEnv", () => {
  it("returns a trimmed BRAVE_API_KEY when configured", () => {
    vi.stubEnv("BRAVE_API_KEY", " brave-test-key ");

    expect(readNormalizedEnv("BRAVE_API_KEY")).toBe("brave-test-key");
  });

  it("returns null for a blank BRAVE_API_KEY", () => {
    vi.stubEnv("BRAVE_API_KEY", "   ");

    expect(readNormalizedEnv("BRAVE_API_KEY")).toBeNull();
  });

  it("returns null for a missing BRAVE_API_KEY", () => {
    expect(readNormalizedEnv("BRAVE_API_KEY")).toBeNull();
  });
});

describe("BUILT_IN_SEARCH_PROVIDERS", () => {
  it("keeps metadata-only entries for all recognized built-in search env vars", () => {
    const envNames = BUILT_IN_SEARCH_PROVIDERS.flatMap(
      (provider) => provider.envVarNames,
    );

    expect(envNames).toContain("BRAVE_API_KEY");
    expect(envNames).toContain("PERPLEXITY_API_KEY");
    expect(envNames).toContain("OPENROUTER_API_KEY");
  });
});

describe("listConfiguredBuiltInSearchProviders", () => {
  it("returns Brave only when its trimmed env var is non-empty", () => {
    vi.stubEnv("BRAVE_API_KEY", " brave-test-key ");
    vi.stubEnv("PERPLEXITY_API_KEY", "   ");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    expect(listConfiguredBuiltInSearchProviders()).toEqual([
      expect.objectContaining({
        envVarNames: ["BRAVE_API_KEY"],
      }),
    ]);
  });
});
