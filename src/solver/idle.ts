import { solverLogger } from "../logging.js";
import type { FrameworkType } from "../types.js";

const DEFAULT_IDLE_STATUS_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_FALLBACK_BUSY_THRESHOLD_MS = 30_000;

/**
 * Detects whether the local solver runtime should be considered idle.
 */
export interface IdleDetector {
  isIdle(): Promise<boolean>;
  recordUserActivity(activityAtMs?: number): void;
}

/**
 * Configures the idle detector's gateway checks and fallback behavior.
 */
export interface IdleDetectorOptions {
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  statusTimeoutMs?: number;
  fallbackBusyThresholdMs?: number;
}

/**
 * Creates an idle detector for the configured solver framework.
 */
export function createIdleDetector(
  framework: FrameworkType,
  options: IdleDetectorOptions = {},
): IdleDetector | null {
  if (framework === "none") {
    return null;
  }

  return new OpenClawIdleDetector(options);
}

/**
 * Idle detector that queries the local OpenClaw gateway and falls back to
 * recent user activity when the gateway cannot be reached.
 */
export class OpenClawIdleDetector implements IdleDetector {
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly statusTimeoutMs: number;
  private readonly fallbackBusyThresholdMs: number;

  private lastUserActivityMs = 0;

  constructor(options: IdleDetectorOptions) {
    const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
    this.gatewayUrl =
      options.gatewayUrl ?? `http://127.0.0.1:${gatewayPort}/health`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.statusTimeoutMs =
      options.statusTimeoutMs ?? DEFAULT_IDLE_STATUS_TIMEOUT_MS;
    this.fallbackBusyThresholdMs =
      options.fallbackBusyThresholdMs ??
      parseEnvInt(
        "CLAWRMA_IDLE_FALLBACK_BUSY_THRESHOLD_MS",
        DEFAULT_IDLE_FALLBACK_BUSY_THRESHOLD_MS,
      );
  }

  public recordUserActivity(activityAtMs: number = this.nowMs()): void {
    this.lastUserActivityMs = activityAtMs;
  }

  public async isIdle(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.statusTimeoutMs);

    try {
      const response = await this.fetchImpl(this.gatewayUrl, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Gateway status returned HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as unknown;
      const record = asRecord(payload);
      if (!record || typeof record.activeSessions !== "number") {
        throw new Error(
          "Gateway status payload missing numeric activeSessions.",
        );
      }

      return record.activeSessions === 0;
    } catch (error: unknown) {
      const now = this.nowMs();
      const fallbackIdle =
        now - this.lastUserActivityMs > this.fallbackBusyThresholdMs;
      solverLogger.warn(
        {
          err: error,
          gatewayUrl: this.gatewayUrl,
          fallbackIdle,
          lastUserActivityMs: this.lastUserActivityMs,
          thresholdMs: this.fallbackBusyThresholdMs,
        },
        "solver_idle_gateway_unavailable_fallback_applied",
      );
      return fallbackIdle;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
