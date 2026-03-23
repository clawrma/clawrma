import WebSocket, { type ClientOptions, type RawData } from "ws";
import { isRecord } from "./guards.js";
import { wsLogger } from "./logging.js";
import type { ClawrmaConfig, DomainPolicy, SolverCapability } from "./types.js";

const DEFAULT_RECONNECT_DELAYS_MS = [
  1000, 2000, 4000, 8000, 16000, 30000,
] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export type PauseReason = "schedule" | "user" | "idle-conflict";
export type WebSocketMessage = Record<string, unknown>;
export type MessageHandler = (message: WebSocketMessage) => void;
export type ConnectionChangeHandler = (connected: boolean) => void;

export interface WebSocketManager {
  send(message: object): void;
  close(): void;
  isConnected(): boolean;
  onMessage(handler: MessageHandler): () => void;
  onConnectionChange(handler: ConnectionChangeHandler): () => void;
  setIdleStateProvider(provider: () => boolean): void;
}

export interface WebSocketManagerOptions {
  endpoint?: string;
  reconnectDelaysMs?: number[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

class ManagedWebSocket implements WebSocketManager {
  private readonly authorizationHeader: string;
  private readonly endpoint: string;
  private readonly reconnectDelaysMs: number[];
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly webSocketFactory: (
    url: string,
    options: ClientOptions,
  ) => WebSocket;

  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private closedManually = false;
  private idleStateProvider: () => boolean = () => true;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly connectionChangeHandlers =
    new Set<ConnectionChangeHandler>();

  constructor(config: ClawrmaConfig, options: WebSocketManagerOptions) {
    this.authorizationHeader = `Bearer ${config.apiKey}`;
    this.endpoint =
      options.endpoint ?? buildSolverWebSocketUrl(config.apiBaseUrl);
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [
      ...DEFAULT_RECONNECT_DELAYS_MS,
    ];
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url: string, socketOptions: ClientOptions) =>
        new WebSocket(url, socketOptions));

    this.connect();
  }

  public send(message: object): void {
    if (!isRecord(message)) {
      throw new Error("WebSocket message payload must be an object.");
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected.");
    }

    const payload = JSON.stringify(message);
    socket.send(payload);
  }

  public close(): void {
    this.closedManually = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();

    const socket = this.socket;
    this.socket = null;

    if (!socket) {
      return;
    }

    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1000, "client-close");
    }
  }

  public isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  public onConnectionChange(handler: ConnectionChangeHandler): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  public setIdleStateProvider(provider: () => boolean): void {
    this.idleStateProvider = provider;
  }

  private connect(): void {
    if (this.closedManually) {
      return;
    }

    wsLogger.info({ endpoint: this.endpoint }, "ws_connecting");

    const socket = this.webSocketFactory(this.endpoint, {
      headers: {
        Authorization: this.authorizationHeader,
      },
    });

    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) {
        return;
      }
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.emitConnectionChange(true);
      wsLogger.info({ endpoint: this.endpoint }, "ws_connected");
    });

    socket.on("close", (code: number, reason: Buffer) => {
      if (this.socket !== socket) {
        return;
      }
      const reasonText = reason.toString("utf8");
      this.stopHeartbeat();
      this.emitConnectionChange(false);
      wsLogger.warn({ code, reason: reasonText }, "ws_closed");
      if (!this.closedManually) {
        this.scheduleReconnect();
      }
    });

    socket.on("error", (error: Error) => {
      if (this.socket !== socket) {
        return;
      }
      wsLogger.error({ err: error }, "ws_error");
    });

    socket.on("pong", () => {
      if (this.socket !== socket) {
        return;
      }
      this.clearHeartbeatTimeout();
    });

    socket.on("message", (raw: RawData) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleIncomingMessage(raw);
    });
  }

  private scheduleReconnect(): void {
    if (this.closedManually || this.reconnectTimer) {
      return;
    }

    const delayMs = computeReconnectDelayMs(
      this.reconnectAttempt,
      this.reconnectDelaysMs,
    );
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt += 1;

    wsLogger.info({ attempt, delayMs }, "ws_reconnect_scheduled");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        socket.ping();
      } catch (error: unknown) {
        wsLogger.warn({ err: error }, "ws_ping_send_failed");
        socket.terminate();
        return;
      }

      this.clearHeartbeatTimeout();
      this.heartbeatTimeoutTimer = setTimeout(() => {
        wsLogger.warn(
          { timeoutMs: this.heartbeatTimeoutMs },
          "ws_pong_timeout",
        );
        socket.terminate();
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (!this.heartbeatTimeoutTimer) {
      return;
    }
    clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = null;
  }

  private handleIncomingMessage(raw: RawData): void {
    const text = rawDataToString(raw);
    const byteLength = Buffer.byteLength(text, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      wsLogger.warn({ err: error, byteLength }, "ws_invalid_json_message");
      return;
    }

    if (!isRecord(parsed)) {
      wsLogger.warn(
        { byteLength, parsedType: describeMessageShape(parsed) },
        "ws_invalid_message_shape",
      );
      return;
    }

    const messageType = typeof parsed.type === "string" ? parsed.type : "";
    if (messageType === "ping") {
      this.respondToGatewayPing();
    }
    if (messageType === "pong") {
      this.clearHeartbeatTimeout();
    }

    this.emitMessage(parsed);
  }

  private respondToGatewayPing(): void {
    let isIdle = true;
    try {
      isIdle = this.idleStateProvider();
    } catch (error: unknown) {
      wsLogger.warn({ err: error }, "ws_idle_state_provider_failed");
    }

    try {
      this.send({ type: "pong", is_idle: isIdle });
    } catch (error: unknown) {
      wsLogger.warn({ err: error }, "ws_pong_send_failed");
    }
  }

  private emitMessage(message: WebSocketMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error: unknown) {
        wsLogger.warn({ err: error }, "ws_message_handler_failed");
      }
    }
  }

  private emitConnectionChange(connected: boolean): void {
    for (const handler of this.connectionChangeHandlers) {
      try {
        handler(connected);
      } catch (error: unknown) {
        wsLogger.warn(
          { err: error, connected },
          "ws_connection_handler_failed",
        );
      }
    }
  }
}

function describeMessageShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

export function buildSolverWebSocketUrl(apiBaseUrl: string): string {
  const url = new URL("/v1/solver/connect", apiBaseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
    return url.toString();
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
    return url.toString();
  }
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return url.toString();
  }
  throw new Error(`Unsupported API base URL protocol: '${url.protocol}'`);
}

export function computeReconnectDelayMs(
  attempt: number,
  delaysMs?: readonly number[],
): number {
  const source =
    delaysMs && delaysMs.length > 0 ? delaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const defaultDelay =
    DEFAULT_RECONNECT_DELAYS_MS[DEFAULT_RECONNECT_DELAYS_MS.length - 1] ??
    30_000;
  const safeAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  const index = Math.min(safeAttempt, source.length - 1);
  const configuredDelay = source[index];
  if (configuredDelay !== undefined) {
    return configuredDelay;
  }
  return defaultDelay;
}

export function createWebSocket(
  config: ClawrmaConfig,
  options: WebSocketManagerOptions = {},
): WebSocketManager {
  return new ManagedWebSocket(config, options);
}

export function sendResume(ws: WebSocketManager): void {
  ws.send({ type: "resume" });
}

export function sendPause(ws: WebSocketManager, reason: PauseReason): void {
  ws.send({ type: "pause", reason });
}

export function sendSubscribe(
  ws: WebSocketManager,
  capabilities: SolverCapability[],
  domainPolicy: DomainPolicy = "allowlist",
): void {
  ws.send({
    type: "subscribe",
    capabilities,
    domain_policy: domainPolicy,
  });
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
