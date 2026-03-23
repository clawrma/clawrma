import { type ExtensibleTaskType } from "../fulfillments/identity.js";
import type { FulfillmentPath } from "../types.js";
import type { WebSocketMessage } from "../ws.js";
import type { AssignedCapability, TaskAssignment } from "./contracts.js";

type ParsedAssignedTaskTypeResult =
  | { ok: true; value: ExtensibleTaskType }
  | { ok: false; error: string };

/**
 * Parses a raw WebSocket task-assignment message into the normalized runtime
 * shape, or returns `null` when the envelope is malformed.
 */
export function parseTaskAssignment(
  message: WebSocketMessage,
): TaskAssignment | null {
  if (message.type !== "task_assignment") {
    return null;
  }

  if (typeof message.task_id !== "string" || message.task_id.length === 0) {
    return null;
  }

  return {
    type: "task_assignment",
    task_id: message.task_id,
    task_type:
      typeof message.task_type === "string"
        ? (message.task_type as TaskAssignment["task_type"])
        : undefined,
    payload: message.payload,
    capability: asRecord(message.capability) as TaskAssignment["capability"],
  };
}

/**
 * Extracts a log-safe summary for an invalid task assignment without exposing
 * the full untrusted payload.
 */
export function summarizeInvalidTaskAssignment(
  message: WebSocketMessage,
): Record<string, unknown> {
  return {
    taskIdPresent:
      typeof message.task_id === "string" && message.task_id.length > 0,
    taskIdType: describeValueType(message.task_id),
    taskType:
      typeof message.task_type === "string" && message.task_type.length > 0
        ? message.task_type
        : null,
    hasPayload: Object.hasOwn(message, "payload"),
    hasCapability: asRecord(message.capability) !== null,
  };
}

/**
 * Extracts a solver-facing error message from a WebSocket error frame.
 */
export function extractWebSocketErrorMessage(
  message: WebSocketMessage,
): string {
  const rawError = message.error;
  if (typeof rawError === "string" && rawError.trim()) {
    return rawError.trim();
  }
  return "unknown_error";
}

/**
 * Normalizes a fulfillment path, falling back to API when the value is absent
 * or invalid.
 */
export function normalizeFulfillmentPath(value: unknown): FulfillmentPath {
  if (value === "cli" || value === "cli_codex" || value === "api") {
    return value;
  }
  return "api";
}

/**
 * Parses and validates the capability identity attached to an extensible task
 * assignment.
 */
export function parseAssignedCapability(
  task: TaskAssignment,
  taskType: ExtensibleTaskType,
): AssignedCapability | string {
  const capability = asRecord(task.capability);
  const assignedTaskType = parseAssignedTaskType(
    capability?.task_type,
    taskType,
  );
  if (!assignedTaskType.ok) {
    return assignedTaskType.error;
  }

  const providerName =
    typeof capability?.provider_name === "string"
      ? capability.provider_name.trim()
      : "";
  if (!providerName) {
    return `Task assignment missing capability.provider_name for '${taskType}'.`;
  }

  const modelName =
    typeof capability?.model_name === "string"
      ? capability.model_name.trim()
      : "";
  if (!modelName) {
    return `Task assignment missing capability.model_name for '${taskType}'.`;
  }

  const fulfillmentPath = parseAssignedFulfillmentPath(
    capability?.fulfillment_path,
  );
  if (!fulfillmentPath) {
    return `Task assignment missing valid capability.fulfillment_path for '${taskType}'.`;
  }

  return {
    task_type: assignedTaskType.value,
    provider_name: providerName,
    model_name: modelName,
    fulfillment_path: fulfillmentPath,
  };
}

/**
 * Parses the task type inside the advertised capability metadata and verifies
 * it matches the assigned task type.
 */
export function parseAssignedTaskType(
  value: unknown,
  expectedTaskType: ExtensibleTaskType,
): ParsedAssignedTaskTypeResult {
  const taskType = typeof value === "string" ? value.trim() : "";
  if (!taskType) {
    return {
      ok: false,
      error: `Task assignment missing capability.task_type for '${expectedTaskType}'.`,
    };
  }

  if (
    taskType !== "web_search" &&
    taskType !== "screenshot" &&
    taskType !== "page_snapshot"
  ) {
    return {
      ok: false,
      error: `Task assignment missing valid capability.task_type for '${expectedTaskType}'.`,
    };
  }

  if (taskType !== expectedTaskType) {
    return {
      ok: false,
      error: `Task assignment capability.task_type '${taskType}' does not match task_type '${expectedTaskType}'.`,
    };
  }

  return { ok: true, value: taskType };
}

/**
 * Parses a fulfillment path only when it is explicitly valid.
 */
export function parseAssignedFulfillmentPath(
  value: unknown,
): FulfillmentPath | null {
  if (value === "cli" || value === "cli_codex" || value === "api") {
    return value;
  }
  return null;
}

/**
 * Narrows an unknown value to a string-keyed object record.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Describes an unknown value using the compact type labels used in log-safe
 * assignment summaries.
 */
export function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
