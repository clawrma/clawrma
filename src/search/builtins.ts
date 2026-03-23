import type { BillingType, FulfillmentPath } from "../types.js";

/**
 * Shared advertised capability metadata for built-in web search.
 */
export const SEARCH_TASK_CAPABILITY_METADATA = {
  providerName: "clawrma-search",
  modelName: "web-search",
} as const;

/**
 * Metadata for a built-in search provider that may be detected from local env.
 */
export interface BuiltInSearchProviderDefinition {
  providerName: string;
  modelName: string;
  billingType: BillingType;
  fulfillmentPath: FulfillmentPath;
  envVarNames: string[];
}

const LOCAL_SEARCH_BILLING_TYPE: BillingType = "local";
const API_FULFILLMENT_PATH: FulfillmentPath = "api";

/**
 * Metadata-only list of recognized built-in search providers.
 */
export const BUILT_IN_SEARCH_PROVIDERS: BuiltInSearchProviderDefinition[] = [
  {
    providerName: SEARCH_TASK_CAPABILITY_METADATA.providerName,
    modelName: SEARCH_TASK_CAPABILITY_METADATA.modelName,
    billingType: LOCAL_SEARCH_BILLING_TYPE,
    fulfillmentPath: API_FULFILLMENT_PATH,
    envVarNames: ["BRAVE_API_KEY"],
  },
  {
    providerName: SEARCH_TASK_CAPABILITY_METADATA.providerName,
    modelName: SEARCH_TASK_CAPABILITY_METADATA.modelName,
    billingType: LOCAL_SEARCH_BILLING_TYPE,
    fulfillmentPath: API_FULFILLMENT_PATH,
    envVarNames: ["PERPLEXITY_API_KEY"],
  },
  {
    providerName: SEARCH_TASK_CAPABILITY_METADATA.providerName,
    modelName: SEARCH_TASK_CAPABILITY_METADATA.modelName,
    billingType: LOCAL_SEARCH_BILLING_TYPE,
    fulfillmentPath: API_FULFILLMENT_PATH,
    envVarNames: ["OPENROUTER_API_KEY"],
  },
];

/**
 * Trim search-related configuration strings and treat blank values as missing.
 */
export function normalizeConfiguredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

/**
 * Read and normalize an env var used by built-in search configuration.
 */
export function readNormalizedEnv(name: string): string | null {
  return normalizeConfiguredString(process.env[name]);
}

/**
 * Check whether any env var for a built-in search provider is configured.
 */
export function isBuiltInSearchProviderConfigured(
  def: BuiltInSearchProviderDefinition,
): boolean {
  return def.envVarNames.some((name) => readNormalizedEnv(name) !== null);
}

/**
 * List built-in search providers with configured non-blank env vars.
 */
export function listConfiguredBuiltInSearchProviders(): BuiltInSearchProviderDefinition[] {
  return BUILT_IN_SEARCH_PROVIDERS.filter((def) =>
    isBuiltInSearchProviderConfigured(def),
  );
}
