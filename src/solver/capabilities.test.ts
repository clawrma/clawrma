import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExtensibleTaskDispatchLookup,
  buildSolverCapabilities,
  buildSolverCapabilitiesFromEffectiveFulfillers,
  dedupeCapabilities,
  resolveEffectiveFulfillers,
  resolveSolverRuntimeState,
} from "./capabilities.js";
import { buildExtensibleTaskIdentityKey } from "../fulfillments/identity.js";
import type { PageSnapshotFulfiller } from "../fulfillments/page-snapshot.js";
import type { ScreenshotFulfiller } from "../fulfillments/screenshot.js";
import type { WebSearchFulfiller } from "../fulfillments/web-search.js";
import type {
  ClawrmaConfig,
  DetectionResult,
  SolverCapability,
} from "../types.js";

type WebSearchCapability = SolverCapability & { task_type: "web_search" };
type ScreenshotCapability = SolverCapability & { task_type: "screenshot" };
type PageSnapshotCapability = SolverCapability & { task_type: "page_snapshot" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

function makeDetectionResult(
  providers: DetectionResult["providers"] = [],
  options: {
    browserAvailable?: boolean;
  } = {},
): DetectionResult {
  return {
    providers,
    browserAvailable: options.browserAvailable ?? false,
    notificationChannels: [],
    activeHours: null,
    existingSearchConfig: false,
    existingFirecrawlConfig: false,
  };
}

function expectNoUnsupportedBrowserCapabilities(
  capabilities: SolverCapability[],
): void {
  expect(capabilities.some((entry) => entry.task_type === "screenshot")).toBe(
    false,
  );
  expect(
    capabilities.some((entry) => entry.task_type === "page_snapshot"),
  ).toBe(false);
}

function makeWebSearchCapability(
  providerName: string,
  modelName: string,
): WebSearchCapability {
  return {
    task_type: "web_search",
    billing_type: "local",
    fulfillment_path: "api",
    provider_name: providerName,
    model_name: modelName,
  };
}

function makeScreenshotCapability(modelName: string): ScreenshotCapability {
  return {
    task_type: "screenshot",
    billing_type: "local",
    fulfillment_path: "api",
    provider_name: "clawrma-browser",
    model_name: modelName,
  };
}

function makePageSnapshotCapability(modelName: string): PageSnapshotCapability {
  return {
    task_type: "page_snapshot",
    billing_type: "local",
    fulfillment_path: "api",
    provider_name: "clawrma-browser",
    model_name: modelName,
  };
}

function makeTestWebSearchFulfiller(
  capability: SolverCapability,
): WebSearchFulfiller {
  return {
    detect: () => capability,
    fulfill: async () => ({
      query: "unused",
      results: [],
    }),
  };
}

function makeTestScreenshotFulfiller(
  capability: SolverCapability,
): ScreenshotFulfiller {
  return {
    detect: (context) => (context.playwrightAvailable ? capability : null),
    fulfill: async (payload) => ({
      image_base64: "c2NyZWVuc2hvdA==",
      format: "png",
      url: payload.url,
    }),
  };
}

function makeTestPageSnapshotFulfiller(
  capability: SolverCapability,
): PageSnapshotFulfiller {
  return {
    detect: (context) => (context.playwrightAvailable ? capability : null),
    fulfill: async (payload) => ({
      snapshot: "# Snapshot",
      snapshot_format: "markdown",
      title: "Snapshot",
      url: payload.url,
    }),
  };
}

describe("solver capabilities", () => {
  it("registers proxy_fetch only for fetch-only local solvers", async () => {
    const config = makeConfig(["proxy_fetch"]);

    const capabilities = await buildSolverCapabilities(config);

    expect(capabilities).toEqual([
      {
        task_type: "proxy_fetch",
        billing_type: "local",
        fulfillment_path: "api",
        provider_name: "clawrma-browser",
        model_name: "proxy-fetch",
      },
    ]);
    expectNoUnsupportedBrowserCapabilities(capabilities);
  });

  it("registers web_search only when BRAVE_API_KEY is available", async () => {
    vi.stubEnv("BRAVE_API_KEY", " brave-test-key ");
    const config = makeConfig([
      "proxy_fetch",
      "screenshot",
      "page_snapshot",
      "web_search",
    ]);

    const capabilities = await buildSolverCapabilities(config);

    expect(capabilities).toEqual([
      {
        task_type: "proxy_fetch",
        billing_type: "local",
        fulfillment_path: "api",
        provider_name: "clawrma-browser",
        model_name: "proxy-fetch",
      },
      {
        task_type: "web_search",
        billing_type: "local",
        fulfillment_path: "api",
        provider_name: "clawrma-search",
        model_name: "web-search",
      },
    ]);
    expectNoUnsupportedBrowserCapabilities(capabilities);
  });

  it("omits web_search when BRAVE_API_KEY is blank or unavailable", async () => {
    const blankConfig = makeConfig(["web_search"]);
    vi.stubEnv("BRAVE_API_KEY", "   ");
    await expect(buildSolverCapabilities(blankConfig)).resolves.toEqual([]);

    const unavailableConfig = makeConfig(["proxy_fetch", "web_search"]);
    vi.unstubAllEnvs();
    const capabilities = await buildSolverCapabilities(unavailableConfig);

    expect(capabilities).toEqual([
      {
        task_type: "proxy_fetch",
        billing_type: "local",
        fulfillment_path: "api",
        provider_name: "clawrma-browser",
        model_name: "proxy-fetch",
      },
    ]);
    expect(capabilities.some((entry) => entry.task_type === "web_search")).toBe(
      false,
    );
  });

  it("resolves effective fulfillers from the internal override seam", () => {
    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const screenshotCapability = makeScreenshotCapability("screenshot-v1");
    const pageSnapshotCapability =
      makePageSnapshotCapability("page-snapshot-v1");

    const effectiveFulfillers = resolveEffectiveFulfillers({
      fulfillers: {
        web_search: [makeTestWebSearchFulfiller(providerA)],
        screenshot: [makeTestScreenshotFulfiller(screenshotCapability)],
        page_snapshot: [makeTestPageSnapshotFulfiller(pageSnapshotCapability)],
      },
    });

    expect(effectiveFulfillers.webSearch).toHaveLength(1);
    expect(effectiveFulfillers.screenshot).toHaveLength(1);
    expect(effectiveFulfillers.pageSnapshot).toHaveLength(1);
  });

  it("builds capabilities from effective fulfillers and gates browser tasks on detection", () => {
    const config = makeConfig(["web_search", "screenshot", "page_snapshot"]);
    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const screenshotCapability = makeScreenshotCapability("screenshot-v1");
    const pageSnapshotCapability =
      makePageSnapshotCapability("page-snapshot-v1");
    const effectiveFulfillers = resolveEffectiveFulfillers({
      fulfillers: {
        web_search: [makeTestWebSearchFulfiller(providerA)],
        screenshot: [makeTestScreenshotFulfiller(screenshotCapability)],
        page_snapshot: [makeTestPageSnapshotFulfiller(pageSnapshotCapability)],
      },
    });

    const unavailable = buildSolverCapabilitiesFromEffectiveFulfillers(
      config,
      effectiveFulfillers,
      {
        detection: makeDetectionResult([], { browserAvailable: false }),
        webSearch: { taskTypes: config.solver.taskTypes },
        browser: { playwrightAvailable: false },
      },
    );
    const available = buildSolverCapabilitiesFromEffectiveFulfillers(
      config,
      effectiveFulfillers,
      {
        detection: makeDetectionResult([], { browserAvailable: true }),
        webSearch: { taskTypes: config.solver.taskTypes },
        browser: { playwrightAvailable: true },
      },
    );

    expect(unavailable).toEqual([providerA]);
    expect(available).toEqual([
      providerA,
      screenshotCapability,
      pageSnapshotCapability,
    ]);
  });

  it("builds inference-only capabilities with billing exclusions applied", async () => {
    const config = makeConfig(["llm_inference"]);
    config.solver.excludedBillingTypes = ["per_token"];

    const capabilities = await buildSolverCapabilities(config, {
      detectCapabilitiesImpl: async () => ({
        providers: [
          {
            name: "openai-codex",
            modelName: "gpt-5.3-codex",
            endpoint: "https://api.openai.com/v1",
            billingType: "subscription",
            fulfillmentPath: "cli_codex",
          },
          {
            name: "anthropic",
            modelName: "claude-sonnet-4-5",
            endpoint: "https://api.anthropic.com",
            billingType: "per_token",
            fulfillmentPath: "api",
          },
        ],
        browserAvailable: true,
        notificationChannels: [],
        activeHours: null,
        existingSearchConfig: false,
        existingFirecrawlConfig: false,
      }),
    });

    expect(capabilities).toEqual([
      {
        task_type: "llm_inference",
        billing_type: "subscription",
        fulfillment_path: "cli_codex",
        provider_name: "openai-codex",
        model_name: "gpt-5.3-codex",
      },
    ]);
    expect(
      capabilities.some((entry) => entry.provider_name === "anthropic"),
    ).toBe(false);
    expectNoUnsupportedBrowserCapabilities(capabilities);
  });

  it("dedupes extensible capabilities by their shared identity key", () => {
    const duplicateA: SolverCapability = {
      task_type: "web_search",
      billing_type: "local",
      fulfillment_path: "api",
      provider_name: "provider-a",
      model_name: "search-a",
    };
    const duplicateB: SolverCapability = {
      ...duplicateA,
      billing_type: "free_tier",
    };

    expect(dedupeCapabilities([duplicateA, duplicateB])).toEqual([duplicateA]);
  });

  it("keeps internal overrides available for both capability building and runtime state", async () => {
    const config = makeConfig(["web_search"]);
    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const providerB = makeWebSearchCapability("provider-b", "search-b");
    const detectCapabilitiesImpl = vi.fn(async () => makeDetectionResult());
    const buildOptions = {
      detectCapabilitiesImpl,
      fulfillers: {
        web_search: [
          makeTestWebSearchFulfiller(providerA),
          makeTestWebSearchFulfiller(providerB),
        ],
      },
      resolvedCapabilities: [providerA],
    };

    const capabilities = await buildSolverCapabilities(config, buildOptions);
    const runtimeState = await resolveSolverRuntimeState(
      config,
      buildOptions,
      buildOptions,
    );

    const keyA = buildExtensibleTaskIdentityKey(providerA);
    const keyB = buildExtensibleTaskIdentityKey(providerB);

    expect(capabilities).toEqual([providerA]);
    expect(detectCapabilitiesImpl).not.toHaveBeenCalled();
    expect(runtimeState.resolvedCapabilities).toEqual([providerA]);
    expect(runtimeState.extensibleDispatchLookup.has(keyA)).toBe(true);
    expect(runtimeState.extensibleDispatchLookup.has(keyB)).toBe(false);
  });

  it("builds dispatch lookup entries only for advertised extensible capabilities", () => {
    const providerA = makeWebSearchCapability("provider-a", "search-a");
    const providerB = makeWebSearchCapability("provider-b", "search-b");
    const effectiveFulfillers = resolveEffectiveFulfillers({
      fulfillers: {
        web_search: [
          makeTestWebSearchFulfiller(providerA),
          makeTestWebSearchFulfiller(providerB),
        ],
      },
    });

    const lookup = buildExtensibleTaskDispatchLookup(
      effectiveFulfillers,
      {
        webSearch: { taskTypes: ["web_search"] },
        browser: { playwrightAvailable: false },
      },
      [providerA],
    );

    expect(Array.from(lookup.keys())).toEqual([
      buildExtensibleTaskIdentityKey(providerA),
    ]);
  });
});
