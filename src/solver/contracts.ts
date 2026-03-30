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
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
}

/**
 * OpenAI-compatible text content part preserved on request messages.
 */
export interface InferenceTextContentPart {
  type?: string;
  text?: string;
  input_text?: string;
  [key: string]: unknown;
}

/**
 * Message content preserved across the solver runtime boundary.
 */
export type InferenceMessageContent =
  | string
  | Array<string | InferenceTextContentPart>;

/**
 * Parsed message content sent to provider or CLI inference executors.
 */
export interface InferenceMessage {
  role: string;
  content: InferenceMessageContent;
  [key: string]: unknown;
}

/**
 * Tool-call function delta emitted by streaming inference providers.
 */
export interface InferenceToolCallFunctionDelta {
  name?: string;
  arguments?: string;
}

/**
 * Tool-call delta emitted by streaming inference providers.
 */
export interface InferenceToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: InferenceToolCallFunctionDelta;
}

/**
 * Normalized chunk content emitted by all inference executors.
 */
export type InferenceChunk =
  | {
      type: "text_delta";
      text: string;
      finish_reason?: string;
    }
  | {
      type: "tool_call_delta";
      tool_call: InferenceToolCallDelta;
      finish_reason?: string;
    };

/**
 * Final tool-call function state included in terminal assistant messages.
 */
export interface InferenceToolCallFunction {
  name?: string;
  arguments?: string;
}

/**
 * Final tool-call state included in terminal assistant messages.
 */
export interface InferenceToolCall {
  id?: string;
  type?: string;
  function?: InferenceToolCallFunction;
}

/**
 * Terminal assistant-message summary persisted alongside inference usage when
 * structured tool output exists.
 */
export interface InferenceAssistantMessage {
  role: "assistant";
  content?: string | null;
  tool_calls?: InferenceToolCall[];
}

/**
 * Final success payload returned by all inference executors.
 */
export interface InferenceExecutionResult {
  usage: TaskUsage;
  result?: InferenceAssistantMessage;
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

/**
 * Projects OpenAI-compatible message content into plain text for text-only
 * safety scans and CLI executors.
 */
export function projectInferenceMessageContentText(
  value: InferenceMessageContent,
): string {
  if (typeof value === "string") {
    return value;
  }

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }

    const textValue = typeof item.text === "string" ? item.text.trim() : "";
    if (textValue) {
      parts.push(textValue);
      continue;
    }

    const inputTextValue =
      typeof item.input_text === "string" ? item.input_text.trim() : "";
    if (inputTextValue) {
      parts.push(inputTextValue);
    }
  }

  return parts.join("\n");
}

/**
 * Projects a parsed inference-message list into plain-text strings.
 */
export function projectInferenceMessagesText(
  messages: InferenceMessage[],
): string[] {
  return messages.map((message) =>
    projectInferenceMessageContentText(message.content),
  );
}
