import type { ExtensibleTaskType } from "../fulfillments/identity.js";
import type { FulfillmentPath, TaskType } from "../types.js";

/**
 * Normalized task-assignment shape consumed by the solver runtime.
 */
export interface TaskAssignment {
  type: "task_assignment";
  task_id: string;
  task_type?: TaskType;
  // The API may inject _content_boundary into marketplace payloads. Treat
  // unknown fields as server metadata and payload values as untrusted data.
  payload?: unknown;
  capability?: {
    task_type?: TaskType;
    fulfillment_path?: FulfillmentPath;
    provider_name?: string;
    model_name?: string;
  };
}

/**
 * Capability identity parsed from an extensible task assignment.
 */
export interface AssignedCapability {
  task_type: ExtensibleTaskType;
  provider_name: string;
  model_name: string;
  fulfillment_path: FulfillmentPath;
}

/**
 * Raw `llm_inference` payload shape accepted at the runtime boundary.
 */
export interface LlmTaskPayload {
  model?: unknown;
  messages?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  max_spend_points?: unknown;
}

/**
 * Parsed message content sent to provider or CLI inference executors.
 */
export interface InferenceMessage {
  role: string;
  content: string;
}

/**
 * Normalized token-usage metadata emitted after task completion.
 */
export interface TaskUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
}

/**
 * Marketplace-facing task-error category used by solver task_error frames.
 */
export type TaskErrorCategory =
  | "blocked"
  | "timeout"
  | "not_found"
  | "server_error"
  | "empty_content"
  | "internal";

/**
 * Provider endpoint and credential data needed for API inference execution.
 */
export interface ProviderRuntimeConfig {
  endpoint: string;
  apiKey: string | null;
}
