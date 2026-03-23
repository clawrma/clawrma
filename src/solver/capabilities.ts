import { solverLogger } from "../logging.js";
import { detectCapabilities } from "../detect.js";
import {
  defaultWebSearchFulfillers,
  type WebSearchDetectContext,
  type WebSearchFulfiller,
} from "../fulfillments/web-search.js";
import {
  defaultScreenshotFulfillers,
  type BrowserDetectContext,
  type ScreenshotFulfiller,
} from "../fulfillments/screenshot.js";
import {
  defaultPageSnapshotFulfillers,
  type PageSnapshotFulfiller,
} from "../fulfillments/page-snapshot.js";
import {
  buildExtensibleTaskIdentityKey,
  isExtensibleTaskType,
  type ExtensibleTaskType,
} from "../fulfillments/identity.js";
import type {
  BillingType,
  ClawrmaConfig,
  DetectionResult,
  DetectedProvider,
  FrameworkType,
  SolverCapability,
} from "../types.js";

const PROXY_FETCH_CAPABILITY_METADATA = {
  providerName: "clawrma-browser",
  modelName: "proxy-fetch",
} as const;

type CapabilityBuildOptions = {
  detectCapabilitiesImpl?: (
    framework: FrameworkType,
  ) => Promise<DetectionResult>;
};

interface CapabilityBuildContext {
  detection: DetectionResult | null;
  webSearch: WebSearchDetectContext;
  browser: BrowserDetectContext;
}

type ExtensibleTaskFulfiller =
  | WebSearchFulfiller
  | ScreenshotFulfiller
  | PageSnapshotFulfiller;

/**
 * Captures which local-only runtime capabilities can be advertised directly.
 */
export interface LocalSolverRuntimeAvailability {
  proxyFetch: boolean;
}

/**
 * Holds the effective fulfiller arrays used for both advertisement and dispatch.
 */
export interface EffectiveFulfillers {
  webSearch: WebSearchFulfiller[];
  screenshot: ScreenshotFulfiller[];
  pageSnapshot: PageSnapshotFulfiller[];
}

/**
 * Describes the concrete local fulfiller that should handle an extensible task.
 */
export interface ExtensibleTaskDispatchEntry {
  taskType: ExtensibleTaskType;
  fulfiller: ExtensibleTaskFulfiller;
}

/**
 * Maps advertised extensible capability identities to local fulfillers.
 */
export type ExtensibleTaskDispatchLookup = Map<
  string,
  ExtensibleTaskDispatchEntry
>;

/**
 * Internal-only startup overrides used by tests and runtime wiring.
 */
export interface InternalSolverRuntimeOptions {
  fulfillers?: {
    web_search?: WebSearchFulfiller[];
    screenshot?: ScreenshotFulfiller[];
    page_snapshot?: PageSnapshotFulfiller[];
  };
  resolvedCapabilities?: SolverCapability[];
}

/**
 * Bundles the derived startup state the runtime needs before connecting.
 */
export interface SolverRuntimeState {
  effectiveFulfillers: EffectiveFulfillers;
  resolvedCapabilities: SolverCapability[];
  extensibleDispatchLookup: ExtensibleTaskDispatchLookup;
}

/**
 * Builds the solver capability snapshot for startup, detection, and tests.
 */
export async function buildSolverCapabilities(
  config: ClawrmaConfig,
  options: {
    detectCapabilitiesImpl?: (
      framework: FrameworkType,
    ) => Promise<DetectionResult>;
  } = {},
): Promise<SolverCapability[]> {
  const internalOptions = extractInternalSolverRuntimeOptions(
    options as typeof options & InternalSolverRuntimeOptions,
  );
  if (internalOptions.resolvedCapabilities) {
    return internalOptions.resolvedCapabilities;
  }

  const effectiveFulfillers = resolveEffectiveFulfillers(internalOptions);
  const buildContext = await resolveCapabilityBuildContext(config, options);
  return buildSolverCapabilitiesFromEffectiveFulfillers(
    config,
    effectiveFulfillers,
    buildContext,
  );
}

/**
 * Derives effective fulfillers, advertised capabilities, and dispatch lookup together.
 */
export async function resolveSolverRuntimeState(
  config: ClawrmaConfig,
  options: CapabilityBuildOptions,
  internalOptions: InternalSolverRuntimeOptions = {},
): Promise<SolverRuntimeState> {
  const effectiveFulfillers = resolveEffectiveFulfillers(internalOptions);
  const buildContext = await resolveCapabilityBuildContext(config, options);
  const resolvedCapabilities =
    internalOptions.resolvedCapabilities ??
    buildSolverCapabilitiesFromEffectiveFulfillers(
      config,
      effectiveFulfillers,
      buildContext,
    );

  return {
    effectiveFulfillers,
    resolvedCapabilities,
    extensibleDispatchLookup: buildExtensibleTaskDispatchLookup(
      effectiveFulfillers,
      buildContext,
      resolvedCapabilities,
    ),
  };
}

/**
 * Resolves the fulfiller arrays that should be treated as authoritative.
 */
export function resolveEffectiveFulfillers(
  options: Pick<InternalSolverRuntimeOptions, "fulfillers"> = {},
): EffectiveFulfillers {
  return {
    webSearch: options.fulfillers?.web_search ?? defaultWebSearchFulfillers,
    screenshot: options.fulfillers?.screenshot ?? defaultScreenshotFulfillers,
    pageSnapshot:
      options.fulfillers?.page_snapshot ?? defaultPageSnapshotFulfillers,
  };
}

/**
 * Extracts the hidden runtime-only startup overrides from a loose options bag.
 */
export function extractInternalSolverRuntimeOptions(
  options: Partial<InternalSolverRuntimeOptions>,
): InternalSolverRuntimeOptions {
  return {
    fulfillers: options.fulfillers,
    resolvedCapabilities: options.resolvedCapabilities,
  };
}

/**
 * Resolves detection inputs shared by capability building and runtime startup.
 */
export async function resolveCapabilityBuildContext(
  config: ClawrmaConfig,
  options: CapabilityBuildOptions,
): Promise<CapabilityBuildContext> {
  const taskTypeSet = new Set(config.solver.taskTypes);
  const needsDetection =
    taskTypeSet.has("llm_inference") ||
    taskTypeSet.has("screenshot") ||
    taskTypeSet.has("page_snapshot");
  const detectImpl = options.detectCapabilitiesImpl ?? detectCapabilities;
  const detection = needsDetection ? await detectImpl(config.framework) : null;

  return {
    detection,
    webSearch: {
      taskTypes: config.solver.taskTypes,
    },
    browser: {
      playwrightAvailable: detection?.browserAvailable ?? false,
    },
  };
}

/**
 * Builds the advertised capability list from the effective fulfiller set.
 */
export function buildSolverCapabilitiesFromEffectiveFulfillers(
  config: ClawrmaConfig,
  effectiveFulfillers: EffectiveFulfillers,
  buildContext: CapabilityBuildContext,
): SolverCapability[] {
  const taskTypeSet = new Set(config.solver.taskTypes);
  const excludedBillingTypes = new Set(config.solver.excludedBillingTypes);
  const capabilities: SolverCapability[] = [];
  const runtime = resolveLocalSolverRuntimeAvailability(config);

  if (runtime.proxyFetch) {
    capabilities.push({
      task_type: "proxy_fetch",
      billing_type: "local",
      fulfillment_path: "api",
      provider_name: PROXY_FETCH_CAPABILITY_METADATA.providerName,
      model_name: PROXY_FETCH_CAPABILITY_METADATA.modelName,
    });
  }

  if (taskTypeSet.has("web_search")) {
    for (const fulfiller of effectiveFulfillers.webSearch) {
      const capability = fulfiller.detect(buildContext.webSearch);
      if (capability) {
        capabilities.push(capability);
      }
    }
  }

  if (taskTypeSet.has("screenshot")) {
    for (const fulfiller of effectiveFulfillers.screenshot) {
      const capability = fulfiller.detect(buildContext.browser);
      if (capability) {
        capabilities.push(capability);
      }
    }
  }

  if (taskTypeSet.has("page_snapshot")) {
    for (const fulfiller of effectiveFulfillers.pageSnapshot) {
      const capability = fulfiller.detect(buildContext.browser);
      if (capability) {
        capabilities.push(capability);
      }
    }
  }

  if (taskTypeSet.has("llm_inference")) {
    const detection = buildContext.detection;
    if (!detection) {
      throw new Error(
        "Capability detection result was not available for llm_inference.",
      );
    }
    const inferenceCapabilities = buildInferenceCapabilities(
      detection.providers,
      excludedBillingTypes,
    );
    capabilities.push(...inferenceCapabilities);
  }

  return dedupeCapabilities(capabilities);
}

/**
 * Converts detected provider records into inference capabilities.
 */
export function buildInferenceCapabilities(
  providers: DetectedProvider[],
  excludedBillingTypes: Set<BillingType>,
): SolverCapability[] {
  const capabilities: SolverCapability[] = [];

  for (const provider of providers) {
    if (excludedBillingTypes.has(provider.billingType)) {
      continue;
    }
    const modelName = provider.modelName.trim();
    if (!modelName) {
      solverLogger.warn(
        { providerName: provider.name },
        "solver_capability_skipped_missing_model_name",
      );
      continue;
    }

    capabilities.push({
      task_type: "llm_inference",
      billing_type: provider.billingType,
      fulfillment_path: provider.fulfillmentPath,
      provider_name: provider.name,
      model_name: modelName,
    });
  }

  return capabilities;
}

/**
 * Resolves local-only runtime capability availability from solver config.
 */
export function resolveLocalSolverRuntimeAvailability(
  config: ClawrmaConfig,
): LocalSolverRuntimeAvailability {
  const taskTypes = new Set(config.solver.taskTypes);

  return {
    proxyFetch: taskTypes.has("proxy_fetch"),
  };
}

/**
 * Deduplicates capability records using the shared advertise/dispatch identity rules.
 */
export function dedupeCapabilities(
  capabilities: SolverCapability[],
): SolverCapability[] {
  const map = new Map<string, SolverCapability>();

  for (const capability of capabilities) {
    let key: string;
    if (isExtensibleTaskType(capability.task_type)) {
      key = buildExtensibleTaskIdentityKey({
        task_type: capability.task_type,
        provider_name: capability.provider_name,
        model_name: capability.model_name,
        fulfillment_path: capability.fulfillment_path,
      });
    } else {
      key = [
        capability.task_type,
        capability.provider_name,
        capability.model_name,
        capability.billing_type,
        capability.fulfillment_path,
      ].join("|");
    }
    if (!map.has(key)) {
      map.set(key, capability);
    }
  }

  return Array.from(map.values());
}

/**
 * Builds the runtime dispatch lookup from advertised extensible capabilities.
 */
export function buildExtensibleTaskDispatchLookup(
  effectiveFulfillers: EffectiveFulfillers,
  buildContext: Pick<CapabilityBuildContext, "webSearch" | "browser">,
  resolvedCapabilities: SolverCapability[],
): ExtensibleTaskDispatchLookup {
  const advertisedKeys = new Set<string>();
  for (const capability of resolvedCapabilities) {
    if (!isExtensibleTaskType(capability.task_type)) {
      continue;
    }

    advertisedKeys.add(
      buildExtensibleTaskIdentityKey({
        task_type: capability.task_type,
        provider_name: capability.provider_name,
        model_name: capability.model_name,
        fulfillment_path: capability.fulfillment_path,
      }),
    );
  }
  const lookup: ExtensibleTaskDispatchLookup = new Map();

  for (const fulfiller of effectiveFulfillers.webSearch) {
    addExtensibleDispatchEntry(
      lookup,
      advertisedKeys,
      fulfiller.detect(buildContext.webSearch),
      fulfiller,
    );
  }

  for (const fulfiller of effectiveFulfillers.screenshot) {
    addExtensibleDispatchEntry(
      lookup,
      advertisedKeys,
      fulfiller.detect(buildContext.browser),
      fulfiller,
    );
  }

  for (const fulfiller of effectiveFulfillers.pageSnapshot) {
    addExtensibleDispatchEntry(
      lookup,
      advertisedKeys,
      fulfiller.detect(buildContext.browser),
      fulfiller,
    );
  }

  return lookup;
}

/**
 * Adds one extensible dispatch entry only when that capability was advertised.
 */
export function addExtensibleDispatchEntry(
  lookup: ExtensibleTaskDispatchLookup,
  advertisedKeys: Set<string>,
  capability: SolverCapability | null,
  fulfiller: ExtensibleTaskFulfiller,
): void {
  if (!capability || !isExtensibleTaskType(capability.task_type)) {
    return;
  }

  const key = buildExtensibleTaskIdentityKey({
    task_type: capability.task_type,
    provider_name: capability.provider_name,
    model_name: capability.model_name,
    fulfillment_path: capability.fulfillment_path,
  });
  if (!advertisedKeys.has(key) || lookup.has(key)) {
    return;
  }

  lookup.set(key, {
    taskType: capability.task_type,
    fulfiller,
  });
}
