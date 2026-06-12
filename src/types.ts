import { FULFILLMENT_PATHS, TASK_TYPES } from "./constants.js";

/**
 * Solver schedule presets for human-friendly configuration.
 */
export type SchedulePreset =
  | "outside-active-hours"
  | "overnight"
  | "idle-always"
  | "custom"
  | "off";

/**
 * Solver schedule source identifier.
 */
export type ScheduleSource = "openclaw-heartbeat" | "manual" | "unknown";

/**
 * Billing model classification for providers.
 */
export type BillingType = "subscription" | "per_token" | "free_tier" | "local";

/**
 * Domain routing policy for browser-style tasks.
 */
export type DomainPolicy = "allowlist" | "open";

/**
 * Task fulfillment path for a detected provider.
 */
export type FulfillmentPath = (typeof FULFILLMENT_PATHS)[number];

/**
 * Canonical task type enum for solver capabilities.
 */
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Framework identifier for setup and runtime behavior.
 */
export type FrameworkType = "openclaw" | "none";

/**
 * Local state for OpenClaw managed web_search fallback setup.
 */
export type WebSearchFallbackStatus =
  | "injected"
  | "existing-config"
  | "skipped"
  | "failed";

/**
 * Tagged fetch content format returned by browser-capable solvers.
 */
export type FetchContentFormat = "text" | "markdown" | "html";

/**
 * Tagged snapshot format returned by snapshot-capable solvers.
 */
export type SnapshotFormat = "markdown" | "ai" | "aria" | "role";

/**
 * Raw snapshot payload surfaced to callers without normalization.
 */
export type SnapshotPayload = string | Record<string, unknown>;

/**
 * A single schedule window with days and time bounds.
 */
export interface ScheduleWindow {
  /**
   * Days of week for this window (e.g., "mon", "tue").
   */
  days: string[];
  /**
   * Start time in HH:MM (24h) format.
   */
  start: string;
  /**
   * End time in HH:MM (24h) format.
   */
  end: string;
}

/**
 * Solver schedule configuration.
 */
export interface SolverSchedule {
  /**
   * Preset identifier for the schedule.
   */
  preset: SchedulePreset;
  /**
   * Source of the schedule configuration.
   */
  source: ScheduleSource;
  /**
   * IANA timezone identifier (e.g., "America/New_York").
   */
  timezone: string;
  /**
   * Explicit schedule windows.
   */
  windows: ScheduleWindow[];
}

/**
 * Narrow CLI hardening settings for local inference execution.
 */
export interface CliSandboxConfig {
  /**
   * Optional root directory for per-task CLI workspaces.
   */
  workspaceRoot?: string;
  /**
   * Retain failed task workspaces for debugging.
   */
  retainFailedWorkspaces?: boolean;
}

/**
 * Canonical Clawrma configuration persisted to disk.
 */
export interface ClawrmaConfig {
  /**
   * Schema version for the config format.
   */
  version: number;
  /**
   * Clawrma account identifier.
   */
  accountId: string;
  /**
   * Clawrma API key.
   */
  apiKey: string;
  /**
   * Base URL for the Clawrma API.
   */
  apiBaseUrl: string;
  /**
   * Framework identifier.
   */
  framework: FrameworkType;
  /**
   * Solver settings and schedule.
   */
  solver: {
    /**
     * Whether the solver loop is enabled.
     */
    enabled: boolean;
    /**
     * Solver schedule configuration.
     */
    schedule: SolverSchedule;
    /**
     * Allowed task types for this solver.
     */
    taskTypes: TaskType[];
    /**
     * Billing types excluded from inference.
     */
    excludedBillingTypes: BillingType[];
    /**
     * Domain routing policy for browser tasks.
     */
    domainPolicy: DomainPolicy;
    /**
     * Optional CLI hardening settings for local inference execution.
     */
    cliSandbox?: CliSandboxConfig;
  };
  /**
   * Inference requester guardrails.
   */
  inference?: {
    /**
     * Optional per-request spend ceiling in points.
     */
    maxSpendPerRequest: number | null;
  };
  /**
   * Whether local prompt safety scanning is enabled. Absent is treated as enabled.
   */
  promptSafetyScan?: boolean;
  /**
   * Web fetch fallback injection status.
   */
  webFetchFallback: {
    injected: boolean;
    method: string;
  };
  /**
   * OpenClaw managed web_search fallback setup status.
   */
  webSearchFallback?: {
    status: WebSearchFallbackStatus;
    method: "openclaw-managed-web-search" | "none";
    configured: boolean;
    selectedProvider: string | null;
    preservedProvider: string | null;
    replacedProvider: string | null;
    error?: string;
  };
  /**
   * Notification settings.
   */
  notifications: {
    channel: string | null;
    target: string;
    earningsThreshold: number;
    dailySummary: boolean;
  };
  /**
   * Welcome credit amount in points.
   */
  welcomeCredit: number;
  /**
   * ISO 8601 installation timestamp.
   */
  installedAt: string;
}

/**
 * API error response envelope.
 */
export interface ApiError {
  status?: string;
  charged?: boolean;
  elapsed_ms?: number;
  error: {
    type: string;
    message: string;
    category?: string;
    detail?: string | Record<string, unknown>;
  };
}

/**
 * Provider discovered during capability detection.
 */
export interface DetectedProvider {
  name: string;
  modelName: string;
  billingType: BillingType;
  endpoint: string;
  fulfillmentPath: FulfillmentPath;
}

/**
 * Capability detection result.
 */
export interface DetectionResult {
  providers: DetectedProvider[];
  browserAvailable: boolean;
  notificationChannels: string[];
  activeHours: ScheduleWindow[] | null;
  existingSearchConfig: boolean;
  existingFirecrawlConfig: boolean;
  existingClawrmaSearchConfig: boolean;
  selectedSearchProvider: string | null;
}

/**
 * Solver capability description for subscription.
 */
export interface SolverCapability {
  task_type: TaskType;
  billing_type: BillingType;
  fulfillment_path: FulfillmentPath;
  provider_name: string;
  model_name: string;
}

/**
 * Request payload for `proxy_fetch`.
 */
export interface ProxyFetchTaskPayload {
  /**
   * HTTP or HTTPS URL to fetch.
   */
  url: string;
  /**
   * Optional solver-specific timeout hint in milliseconds.
   */
  timeout?: number;
  /**
   * Request raw HTML when the selected solver supports a transformed mode.
   */
  raw_html?: boolean;
}

/**
 * Request payload for `screenshot`.
 */
export interface ScreenshotTaskPayload {
  /**
   * HTTP or HTTPS URL to capture.
   */
  url: string;
  /**
   * Optional explicit viewport width.
   */
  viewport_width?: number;
  /**
   * Optional explicit viewport height.
   */
  viewport_height?: number;
  /**
   * Optional viewport object for convenience routes that accept it directly.
   */
  viewport?: {
    width: number;
    height: number;
  };
  /**
   * Whether to capture the full scrollable page.
   */
  full_page?: boolean;
}

/**
 * Request payload for `page_snapshot`.
 */
export interface PageSnapshotTaskPayload {
  /**
   * HTTP or HTTPS URL to snapshot.
   */
  url: string;
  /**
   * Optional snapshot mode supported by the selected solver.
   */
  mode?: "ai" | "aria";
  /**
   * Optional CSS selector that narrows the snapshot scope.
   */
  selector?: string;
}

/**
 * Request payload for `web_search`.
 */
export interface WebSearchTaskPayload {
  /**
   * Search query text.
   */
  query: string;
  /**
   * Optional result count hint.
   */
  count?: number;
}

/**
 * Request payload for `llm_inference`.
 */
export type LlmInferenceTaskPayload = Record<string, unknown>;

/**
 * Canonical request payload map keyed by task type.
 */
export interface TaskPayloadMap {
  proxy_fetch: ProxyFetchTaskPayload;
  screenshot: ScreenshotTaskPayload;
  page_snapshot: PageSnapshotTaskPayload;
  web_search: WebSearchTaskPayload;
  llm_inference: LlmInferenceTaskPayload;
}

/**
 * Result payload for `proxy_fetch`.
 */
export interface ProxyFetchTaskResult {
  /**
   * Final fetched URL when available.
   */
  url?: string;
  /**
   * HTTP status code returned by the solver.
   */
  status_code?: number;
  /**
   * Response headers exposed by the solver.
   */
  headers?: Record<string, string>;
  /**
   * Returned body content.
   */
  body: string;
  /**
   * Tagged content format for `body`.
   */
  content_format: FetchContentFormat;
  /**
   * Original upstream content type when available.
   */
  original_content_type?: string;
  /**
   * Solver-reported execution time.
   */
  elapsed_ms?: number;
  [key: string]: unknown;
}

/**
 * Result payload for `screenshot`.
 */
export interface ScreenshotTaskResult {
  image_base64?: string;
  output_path?: string;
  format?: string;
  url?: string;
  elapsed_ms?: number;
  [key: string]: unknown;
}

/**
 * Result payload for `page_snapshot`.
 */
export interface PageSnapshotTaskResult {
  /**
   * Tagged raw snapshot payload.
   */
  snapshot: SnapshotPayload;
  /**
   * Tagged format for `snapshot`.
   */
  snapshot_format: SnapshotFormat;
  /**
   * Optional page title.
   */
  title?: string;
  /**
   * Final URL when available.
   */
  url?: string;
  /**
   * Solver-reported execution time.
   */
  elapsed_ms?: number;
  [key: string]: unknown;
}

/**
 * Result payload for `web_search`.
 */
export interface WebSearchTaskResult {
  query?: string;
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
  elapsed_ms?: number;
  [key: string]: unknown;
}

/**
 * Result payload for `llm_inference`.
 */
export interface LlmInferenceTaskResult {
  output?: unknown;
  [key: string]: unknown;
}

/**
 * Canonical task result map keyed by task type.
 */
export interface TaskResultMap {
  proxy_fetch: ProxyFetchTaskResult;
  screenshot: ScreenshotTaskResult;
  page_snapshot: PageSnapshotTaskResult;
  web_search: WebSearchTaskResult;
  llm_inference: LlmInferenceTaskResult;
}
