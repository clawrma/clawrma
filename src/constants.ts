import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_BASE_URL = "https://api.clawrma.com";

export const CONFIG_DIR = join(homedir(), ".clawrma");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const SCHEMA_PATH = join(CONFIG_DIR, "config.schema.json");
export const LOG_DIR = join(CONFIG_DIR, "logs");

export const LOCAL_SOLVER_TASK_TYPES = [
  "proxy_fetch",
  "web_search",
  "llm_inference",
] as const;

export const TASK_TYPES = [
  "proxy_fetch",
  "screenshot",
  "page_snapshot",
  "web_search",
  "llm_inference",
] as const;

export const FULFILLMENT_PATHS = ["api", "cli", "cli_codex"] as const;
export const BILLING_TYPES = [
  "subscription",
  "per_token",
  "free_tier",
  "local",
] as const;
export const DOMAIN_POLICIES = ["allowlist", "open"] as const;
export const SCHEDULE_PRESETS = [
  "outside-active-hours",
  "overnight",
  "idle-always",
  "custom",
  "off",
] as const;
export const ALL_SCHEDULE_DAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export const ALWAYS_ON_SCHEDULE_WINDOW: {
  days: string[];
  start: string;
  end: string;
} = {
  days: [...ALL_SCHEDULE_DAYS],
  start: "00:00",
  end: "00:00",
};
