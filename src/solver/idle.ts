import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { isRecord } from "../guards.js";
import { solverLogger } from "../logging.js";
import type { FrameworkType } from "../types.js";

const DEFAULT_IDLE_STATUS_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_FALLBACK_BUSY_THRESHOLD_MS = 30_000;
const DEFAULT_OPENCLAW_GATEWAY_PORT = "18789";
const OPENCLAW_GATEWAY_CLIENT_VERSION = "clawrma";

type GatewayIdleStatus = "idle" | "busy" | "unknown";

interface GatewayStatusEvaluation {
  status: GatewayIdleStatus;
  supportedFields: string[];
}

interface GatewayResponseError {
  message: string;
}

interface GatewayStatusResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayResponseError;
}

/**
 * Detects whether the local solver runtime should be considered idle.
 */
export interface IdleDetector {
  isIdle(): Promise<boolean>;
  recordUserActivity(activityAtMs?: number): void;
}

/**
 * Context passed to an OpenClaw Gateway status client.
 */
export interface OpenClawGatewayStatusRequest {
  gatewayUrl: string;
  gatewayToken: string | null;
  timeoutMs: number;
}

/**
 * Fetches the OpenClaw Gateway status payload.
 */
export type OpenClawGatewayStatusClient = (
  request: OpenClawGatewayStatusRequest,
) => Promise<unknown>;

/**
 * Configures the idle detector's gateway checks and fallback behavior.
 */
export interface IdleDetectorOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
  statusClient?: OpenClawGatewayStatusClient;
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
  private readonly gatewayToken: string | null;
  private readonly statusClient: OpenClawGatewayStatusClient;
  private readonly nowMs: () => number;
  private readonly statusTimeoutMs: number;
  private readonly fallbackBusyThresholdMs: number;

  private lastUserActivityMs = 0;

  constructor(options: IdleDetectorOptions) {
    this.gatewayUrl = resolveOpenClawGatewayWebSocketUrl(options.gatewayUrl);
    this.gatewayToken =
      options.gatewayToken ?? readGatewayTokenFromEnvironment();
    this.statusClient = options.statusClient ?? fetchOpenClawGatewayStatus;
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
    let payload: unknown;
    try {
      payload = await this.statusClient({
        gatewayUrl: this.gatewayUrl,
        gatewayToken: this.gatewayToken,
        timeoutMs: this.statusTimeoutMs,
      });
    } catch (error: unknown) {
      return this.applyFallback(
        "solver_idle_gateway_unavailable_fallback_applied",
        {
          err: error,
          gatewayUrl: this.gatewayUrl,
        },
      );
    }

    const evaluation = evaluateGatewayStatus(payload);
    if (evaluation.status === "busy") {
      return false;
    }
    if (evaluation.status === "idle") {
      return true;
    }

    return this.applyFallback(
      "solver_idle_gateway_status_unknown_fallback_applied",
      {
        gatewayUrl: this.gatewayUrl,
        payloadShape: describePayloadShape(payload),
        supportedFields: evaluation.supportedFields,
      },
    );
  }

  private applyFallback(
    logMessage: string,
    logContext: Record<string, unknown>,
  ): boolean {
    const now = this.nowMs();
    const fallbackIdle =
      now - this.lastUserActivityMs > this.fallbackBusyThresholdMs;
    solverLogger.warn(
      {
        ...logContext,
        fallbackIdle,
        lastUserActivityMs: this.lastUserActivityMs,
        thresholdMs: this.fallbackBusyThresholdMs,
      },
      logMessage,
    );
    return fallbackIdle;
  }
}

async function fetchOpenClawGatewayStatus(
  request: OpenClawGatewayStatusRequest,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(request.gatewayUrl);
    const connectId = `clawrma-connect-${randomUUID()}`;
    const statusId = `clawrma-status-${randomUUID()}`;
    let settled = false;
    let connectSent = false;
    let statusSent = false;
    let challengeFallbackTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;

    const settle = (error?: unknown, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (challengeFallbackTimer) {
        clearTimeout(challengeFallbackTimer);
        challengeFallbackTimer = null;
      }
      socket.removeAllListeners();
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        if (error) {
          socket.terminate();
        } else {
          socket.close(1000, "clawrma-status-complete");
        }
      }

      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };

    timeout = setTimeout(() => {
      settle(
        new Error(
          `OpenClaw Gateway status timed out after ${request.timeoutMs}ms.`,
        ),
      );
    }, request.timeoutMs);

    const sendFrame = (frame: Record<string, unknown>): void => {
      socket.send(JSON.stringify(frame));
    };

    const sendConnect = (): void => {
      if (connectSent || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      connectSent = true;
      if (challengeFallbackTimer) {
        clearTimeout(challengeFallbackTimer);
        challengeFallbackTimer = null;
      }

      sendFrame({
        type: "req",
        id: connectId,
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "gateway-client",
            version: OPENCLAW_GATEWAY_CLIENT_VERSION,
            platform: process.platform,
            mode: "backend",
          },
          role: "operator",
          scopes: ["operator.read"],
          caps: [],
          commands: [],
          permissions: {},
          auth: request.gatewayToken ? { token: request.gatewayToken } : {},
          locale: "en-US",
          userAgent: `clawrma/${OPENCLAW_GATEWAY_CLIENT_VERSION}`,
        },
      });
    };

    const sendStatus = (): void => {
      if (statusSent || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      statusSent = true;
      sendFrame({
        type: "req",
        id: statusId,
        method: "status",
        params: {},
      });
    };

    socket.on("open", () => {
      challengeFallbackTimer = setTimeout(() => {
        sendConnect();
      }, 750);
    });

    socket.on("message", (raw: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch (error: unknown) {
        settle(error);
        return;
      }

      if (!isRecord(parsed)) {
        settle(new Error("OpenClaw Gateway returned a non-object frame."));
        return;
      }

      if (parsed.type === "event" && parsed.event === "connect.challenge") {
        sendConnect();
        return;
      }

      const response = parseGatewayResponseFrame(parsed);
      if (!response) {
        return;
      }

      if (response.id === connectId) {
        if (!response.ok) {
          settle(
            new Error(
              `OpenClaw Gateway connect failed: ${response.error?.message ?? "unknown error"}.`,
            ),
          );
          return;
        }
        sendStatus();
        return;
      }

      if (response.id === statusId) {
        if (!response.ok) {
          settle(
            new Error(
              `OpenClaw Gateway status RPC failed: ${response.error?.message ?? "unknown error"}.`,
            ),
          );
          return;
        }
        settle(undefined, response.payload);
      }
    });

    socket.on("error", (error: Error) => {
      settle(error);
    });

    socket.on("close", (code: number, reason: Buffer) => {
      if (settled) {
        return;
      }
      const reasonText = reason.toString("utf8") || "no close reason";
      settle(new Error(`OpenClaw Gateway closed (${code}): ${reasonText}.`));
    });
  });
}

function evaluateGatewayStatus(payload: unknown): GatewayStatusEvaluation {
  const supportedFields: string[] = [];
  const activeCounts = readGatewayActiveCounts(payload, supportedFields);
  if (activeCounts.length === 0) {
    return { status: "unknown", supportedFields };
  }

  if (activeCounts.some((count) => count > 0)) {
    return { status: "busy", supportedFields };
  }

  return { status: "idle", supportedFields };
}

function readGatewayActiveCounts(
  payload: unknown,
  supportedFields: string[],
): number[] {
  const root = isRecord(payload) ? payload : null;
  const tasks = isRecord(root?.tasks) ? root.tasks : null;
  const byStatus = isRecord(tasks?.byStatus) ? tasks.byStatus : null;
  const counts: number[] = [];

  appendActiveCount(counts, supportedFields, "tasks.active", tasks?.active);
  appendActiveCount(
    counts,
    supportedFields,
    "tasks.byStatus.running",
    byStatus?.running,
  );

  return counts;
}

function appendActiveCount(
  counts: number[],
  supportedFields: string[],
  field: string,
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return;
  }
  supportedFields.push(field);
  counts.push(value);
}

function parseGatewayResponseFrame(
  frame: Record<string, unknown>,
): GatewayStatusResponseFrame | null {
  if (
    frame.type !== "res" ||
    typeof frame.id !== "string" ||
    typeof frame.ok !== "boolean"
  ) {
    return null;
  }

  const error = isRecord(frame.error)
    ? { message: String(frame.error.message ?? "unknown error") }
    : undefined;
  return {
    type: "res",
    id: frame.id,
    ok: frame.ok,
    payload: frame.payload,
    ...(error ? { error } : {}),
  };
}

function resolveOpenClawGatewayWebSocketUrl(explicitUrl?: string): string {
  const configuredUrl =
    readNonEmptyString(explicitUrl) ?? readNonEmptyEnv("OPENCLAW_GATEWAY_URL");
  if (configuredUrl) {
    return normalizeOpenClawGatewayWebSocketUrl(configuredUrl);
  }

  const gatewayPort =
    readNonEmptyEnv("OPENCLAW_GATEWAY_PORT") ?? DEFAULT_OPENCLAW_GATEWAY_PORT;
  return `ws://127.0.0.1:${gatewayPort}`;
}

function normalizeOpenClawGatewayWebSocketUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error: unknown) {
    throw new Error(`OpenClaw Gateway URL must be a valid URL: ${rawUrl}`, {
      cause: error,
    });
  }

  if (parsed.hash) {
    throw new Error("OpenClaw Gateway URL must not include a fragment.");
  }

  if (parsed.protocol === "wss:") {
    return rawUrl;
  }
  if (parsed.protocol === "ws:") {
    assertPlaintextGatewayUrlIsLoopback(parsed);
    return rawUrl;
  }
  if (parsed.protocol === "http:") {
    assertPlaintextGatewayUrlIsLoopback(parsed);
    return rawUrl.replace(/^http:/i, "ws:");
  }
  if (parsed.protocol === "https:") {
    return rawUrl.replace(/^https:/i, "wss:");
  }

  throw new Error(
    `OpenClaw Gateway URL must use ws://, wss://, http://, or https://; got ${parsed.protocol}.`,
  );
}

function assertPlaintextGatewayUrlIsLoopback(parsed: URL): void {
  if (isLoopbackGatewayHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    "OpenClaw Gateway plaintext URLs must target localhost or a loopback address. Use wss:// for remote gateways.",
  );
}

function isLoopbackGatewayHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const unbracketed =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (unbracketed === "localhost" || unbracketed === "::1") {
    return true;
  }

  const parts = unbracketed.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255;
  });
}

function readGatewayTokenFromEnvironment(): string | null {
  return (
    readNonEmptyEnv("OPENCLAW_GATEWAY_TOKEN") ??
    readNonEmptyEnv("OPENCLAW_RPC_TOKEN")
  );
}

function readNonEmptyEnv(envName: string): string | null {
  return readNonEmptyString(process.env[envName]);
}

function readNonEmptyString(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function describePayloadShape(payload: unknown): string {
  if (!isRecord(payload)) {
    return Array.isArray(payload) ? "array" : typeof payload;
  }

  const keys = Object.keys(payload).slice(0, 5);
  return keys.length > 0 ? `object:${keys.join(",")}` : "object";
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return raw.toString("utf8");
}
