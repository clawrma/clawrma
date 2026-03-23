import type { FulfillmentPath, TaskType } from "../types.js";

export const EXTENSIBLE_TASK_TYPES = [
  "web_search",
  "screenshot",
  "page_snapshot",
] as const;

export type ExtensibleTaskType = (typeof EXTENSIBLE_TASK_TYPES)[number];

export interface ExtensibleTaskIdentity {
  task_type: ExtensibleTaskType;
  provider_name: string;
  model_name: string;
  fulfillment_path: FulfillmentPath;
}

export function isExtensibleTaskType(
  taskType: TaskType,
): taskType is ExtensibleTaskType {
  return (EXTENSIBLE_TASK_TYPES as readonly TaskType[]).includes(taskType);
}

export function buildExtensibleTaskIdentityKey(
  capability: ExtensibleTaskIdentity,
): string {
  return [
    capability.task_type,
    capability.provider_name,
    capability.model_name,
    capability.fulfillment_path,
  ].join("|");
}
