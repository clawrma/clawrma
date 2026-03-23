import { solverLogger } from "../logging.js";
import { readConfig } from "../config.js";
import { getStatus, type StatusResponse } from "../client.js";
import { sendNotification } from "../notify.js";
import {
  WebSearchFulfillmentError,
  type WebSearchFulfiller,
} from "../fulfillments/web-search.js";
import {
  type BrowserFulfillContext,
  type ScreenshotFulfiller,
} from "../fulfillments/screenshot.js";
import { type PageSnapshotFulfiller } from "../fulfillments/page-snapshot.js";
import {
  buildExtensibleTaskIdentityKey,
  type ExtensibleTaskType,
} from "../fulfillments/identity.js";
import type {
  ClawrmaConfig,
  DetectionResult,
  FrameworkType,
  PageSnapshotTaskPayload,
  ProxyFetchTaskPayload,
  ProxyFetchTaskResult,
  ScreenshotTaskPayload,
  SolverCapability,
} from "../types.js";
import {
  createWebSocket,
  sendPause,
  sendResume,
  sendSubscribe,
  type PauseReason,
  type WebSocketManager,
  type WebSocketMessage,
} from "../ws.js";
import {
  asRecord,
  extractWebSocketErrorMessage,
  normalizeFulfillmentPath,
  parseAssignedCapability,
  parseTaskAssignment,
  summarizeInvalidTaskAssignment,
} from "./assignments.js";
import {
  extractInternalSolverRuntimeOptions,
  resolveSolverRuntimeState,
  type EffectiveFulfillers,
  type ExtensibleTaskDispatchEntry,
  type ExtensibleTaskDispatchLookup,
  type InternalSolverRuntimeOptions,
  type SolverRuntimeState,
} from "./capabilities.js";
import type {
  LlmTaskPayload,
  TaskAssignment,
  TaskErrorCategory,
  TaskUsage,
} from "./contracts.js";
import { createIdleDetector, type IdleDetector } from "./idle.js";
import {
  defaultSpawn,
  fulfillViaApi,
  fulfillViaClaudeCli,
  fulfillViaCodexCli,
  resolveProviderRuntimeConfig,
  type InferenceChunk,
  type ProviderResolver,
  type SpawnImpl,
} from "./inference.js";
import { isInScheduleWindow } from "./schedule.js";

const DEFAULT_SCHEDULE_EVAL_MS = 60_000;
const DEFAULT_CLI_TIMEOUT_MS = 120_000;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_CAPABILITIES_FALLBACK_TIMEOUT_MS = 10_000;
const DEFAULT_CAPABILITY_SUBSCRIBE_ACK_TIMEOUT_MS = 5_000;
const SOLVER_ERROR_NOTIFICATION_COOLDOWN_MS = 60_000;
const LOW_BALANCE_THRESHOLD_POINTS = 50;

interface OutboundTaskMessage {
  type: "task_chunk" | "task_complete" | "task_error";
  task_id: string;
  chunk?: {
    content: string;
    finish_reason?: string;
  };
  result?: Record<string, unknown>;
  usage?: TaskUsage;
  error?: string;
  category?: TaskErrorCategory;
}

/**
 * Runtime handle returned to callers that start a solver session.
 */
export interface SolverHandle {
  stop(): Promise<void>;
  isRunning(): boolean;
  isPaused(): boolean;
}

/**
 * Dependency injection hooks for solver runtime startup and tests.
 */
export interface SolverRuntimeDependencies {
  wsFactory?: (config: ClawrmaConfig) => WebSocketManager;
  configLoader?: () => Promise<ClawrmaConfig | null>;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnImpl;
  now?: () => Date;
  scheduleEvalIntervalMs?: number;
  fetchTimeoutMs?: number;
  cliTimeoutMs?: number;
  providerResolver?: ProviderResolver;
  idleDetector?: IdleDetector | null;
  idlePollIntervalMs?: number;
  capabilityFallbackRegistrar?: CapabilityFallbackRegistrar;
  detectCapabilitiesImpl?: (
    framework: FrameworkType,
  ) => Promise<DetectionResult>;
  notificationSender?: (
    config: ClawrmaConfig,
    message: string,
  ) => Promise<void>;
  statusProvider?: (
    apiBaseUrl: string,
    apiKey: string,
  ) => Promise<StatusResponse>;
}

type CapabilityFallbackRegistrar = (
  config: ClawrmaConfig,
  capabilities: SolverCapability[],
  fetchImpl: typeof fetch,
) => Promise<void>;

type SolverRuntimeConstructorDependencies = SolverRuntimeDependencies &
  SolverRuntimeState;

type CapabilityRegistrationState = "unregistered" | "pending" | "registered";

interface SolverStatusSnapshot {
  date: string;
  tasksSolvedToday: number;
  earningsToday: number;
  balance: number;
}

/**
 * Owns solver WebSocket lifecycle, task routing, and runtime notifications.
 */
export class SolverRuntime implements SolverHandle {
  private readonly ws: WebSocketManager;
  private readonly config: ClawrmaConfig;
  private readonly configLoader: () => Promise<ClawrmaConfig | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: SpawnImpl;
  private readonly now: () => Date;
  private readonly scheduleEvalIntervalMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly cliTimeoutMs: number;
  private readonly providerResolver: ProviderResolver;
  private readonly idleDetector: IdleDetector | null;
  private readonly capabilities: SolverCapability[];
  private readonly effectiveFulfillers: EffectiveFulfillers;
  private readonly extensibleDispatchLookup: ExtensibleTaskDispatchLookup;
  private readonly capabilityFallbackRegistrar: CapabilityFallbackRegistrar | null;
  private readonly notificationSender: (
    config: ClawrmaConfig,
    message: string,
  ) => Promise<void>;
  private readonly statusProvider: (
    apiBaseUrl: string,
    apiKey: string,
  ) => Promise<StatusResponse>;
  private readonly notificationsEnabled: boolean;
  private readonly startedAtMs: number;

  private running = true;
  private routingPaused = true;
  private desiredRoutingActive = false;
  private initialRoutingSynced = false;
  private pendingSchedulePause = false;
  private capabilityRegistrationState: CapabilityRegistrationState =
    "unregistered";
  private inFlightTasks = 0;
  private lastKnownIdle = true;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private capabilitySubscribeAckTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];
  private notificationQueue: Promise<void> = Promise.resolve();
  private lastStatusSnapshot: SolverStatusSnapshot | null = null;
  private pendingEarningsPoints = 0;
  private pendingEarningTasks = 0;
  private lowBalanceAlertSent = false;
  private lastSolverErrorNotificationAtMs = 0;

  public constructor(
    config: ClawrmaConfig,
    dependencies: SolverRuntimeConstructorDependencies,
  ) {
    this.config = config;
    this.configLoader = dependencies.configLoader ?? readConfig;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.spawnImpl = dependencies.spawnImpl ?? defaultSpawn;
    this.now = dependencies.now ?? (() => new Date());
    this.scheduleEvalIntervalMs =
      dependencies.scheduleEvalIntervalMs ?? DEFAULT_SCHEDULE_EVAL_MS;
    this.fetchTimeoutMs =
      dependencies.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.cliTimeoutMs = dependencies.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.providerResolver =
      dependencies.providerResolver ?? resolveProviderRuntimeConfig;
    this.idleDetector =
      dependencies.idleDetector === undefined
        ? createIdleDetector(config.framework)
        : dependencies.idleDetector;
    this.capabilities = dependencies.resolvedCapabilities;
    this.effectiveFulfillers = dependencies.effectiveFulfillers;
    this.extensibleDispatchLookup = dependencies.extensibleDispatchLookup;
    this.capabilityFallbackRegistrar =
      dependencies.capabilityFallbackRegistrar ??
      registerCapabilitiesHttpFallback;
    this.notificationSender =
      dependencies.notificationSender ?? sendNotification;
    this.statusProvider = dependencies.statusProvider ?? getStatus;
    this.notificationsEnabled =
      config.framework !== "none" &&
      typeof config.notifications.channel === "string" &&
      config.notifications.channel.length > 0;
    this.startedAtMs = this.now().getTime();

    const wsFactory = dependencies.wsFactory ?? createWebSocket;
    this.ws = wsFactory(config);
    this.ws.setIdleStateProvider(() => this.lastKnownIdle);

    this.unsubscribers.push(
      this.ws.onMessage((message) => {
        void this.handleWsMessage(message);
      }),
    );
    this.unsubscribers.push(
      this.ws.onConnectionChange((connected) => {
        if (!this.running) {
          return;
        }

        if (!connected) {
          this.clearCapabilitySubscribeAckTimeout();
          this.capabilityRegistrationState = "unregistered";
          return;
        }

        void this.syncCapabilityRegistration();
        this.syncDesiredRoutingState();
      }),
    );

    void this.syncCapabilityRegistration();
    this.evaluateSchedule();
    this.scheduleTimer = setInterval(() => {
      this.evaluateSchedule();
    }, this.scheduleEvalIntervalMs);

    if (this.idleDetector) {
      void this.refreshIdleState();
      const idlePollIntervalMs = dependencies.idlePollIntervalMs ?? 5_000;
      this.idleTimer = setInterval(() => {
        void this.refreshIdleState();
      }, idlePollIntervalMs);
    }
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.clearCapabilitySubscribeAckTimeout();

    try {
      await this.notificationQueue;
    } catch (error: unknown) {
      solverLogger.warn(
        { err: error },
        "solver_notification_queue_drain_failed",
      );
    }

    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error: unknown) {
        solverLogger.warn({ err: error }, "solver_unsubscribe_failed");
      }
    }
    this.unsubscribers = [];

    this.ws.close();
  }

  public isRunning(): boolean {
    return this.running;
  }

  public isPaused(): boolean {
    return this.routingPaused;
  }

  private async handleWsMessage(message: WebSocketMessage): Promise<void> {
    if (!this.running) {
      return;
    }

    if (message.type === "subscribe_ack") {
      this.handleSubscribeAck(message);
      return;
    }

    if (message.type === "error") {
      await this.handleWebSocketErrorMessage(message);
      return;
    }

    if (message.type !== "task_assignment") {
      return;
    }

    const assignment = parseTaskAssignment(message);
    if (!assignment) {
      solverLogger.warn(
        summarizeInvalidTaskAssignment(message),
        "solver_invalid_task_assignment",
      );
      return;
    }

    await this.fulfillTaskAssignment(assignment);
  }

  private async fulfillTaskAssignment(task: TaskAssignment): Promise<void> {
    const taskId = task.task_id;
    solverLogger.info(
      { taskId, taskType: task.task_type ?? null },
      "solver_task_received",
    );

    if (!this.desiredRoutingActive) {
      solverLogger.info({ taskId, reason: "schedule" }, "solver_task_declined");
      this.sendTaskError(taskId, "Solver is paused due to schedule.");
      return;
    }

    if (this.idleDetector) {
      const idle = await this.safeIsIdle();
      if (!idle) {
        solverLogger.info(
          { taskId, reason: "idle-conflict" },
          "solver_task_declined",
        );
        this.sendTaskError(taskId, "Solver is busy with local agent activity.");
        return;
      }
    }

    this.inFlightTasks += 1;
    try {
      const taskType = task.task_type;
      if (!taskType) {
        this.sendTaskError(taskId, "Task assignment missing task_type.");
        return;
      }

      switch (taskType) {
        case "proxy_fetch":
          await this.fulfillProxyFetch(task);
          return;
        case "llm_inference":
          await this.fulfillLlmInference(task);
          return;
        case "screenshot":
        case "page_snapshot":
        case "web_search":
          await this.fulfillExtensibleTask(task, taskType);
          return;
        default:
          this.sendTaskError(
            taskId,
            `Unsupported task_type '${String(taskType)}'.`,
          );
          return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      solverLogger.error(
        { err: error, taskId },
        "solver_task_assignment_failed",
      );
      this.sendTaskError(taskId, message);
    } finally {
      this.inFlightTasks = Math.max(0, this.inFlightTasks - 1);
      this.trySendDeferredSchedulePause();
    }
  }

  private async safeIsIdle(): Promise<boolean> {
    if (!this.idleDetector) {
      this.lastKnownIdle = true;
      return true;
    }

    try {
      const idle = await this.idleDetector.isIdle();
      this.lastKnownIdle = idle;
      return idle;
    } catch (error: unknown) {
      solverLogger.warn({ err: error }, "solver_idle_probe_failed");
      this.lastKnownIdle = true;
      return true;
    }
  }

  private async refreshIdleState(): Promise<void> {
    await this.safeIsIdle();
  }

  private async fulfillProxyFetch(task: TaskAssignment): Promise<void> {
    const taskId = task.task_id;
    const payload = asRecord(task.payload) as ProxyFetchTaskPayload | null;
    const url = typeof payload?.url === "string" ? payload.url : "";
    if (!url) {
      this.sendTaskError(
        taskId,
        "proxy_fetch payload must include a url string.",
      );
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const body = await response.text();
      const originalContentType = response.headers.get("content-type")?.trim();
      const result: ProxyFetchTaskResult = {
        url,
        status_code: response.status,
        headers,
        body,
        content_format: "html",
        elapsed_ms: Date.now() - startedAt,
      };
      if (originalContentType) {
        result.original_content_type = originalContentType;
      }

      this.sendTaskMessage({
        type: "task_complete",
        task_id: taskId,
        result,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendTaskError(taskId, `proxy_fetch failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fulfillLlmInference(task: TaskAssignment): Promise<void> {
    const taskId = task.task_id;
    const payload = asRecord(task.payload);
    if (!payload) {
      this.sendTaskError(taskId, "llm_inference payload must be an object.");
      return;
    }

    const capability = asRecord(task.capability);
    const providerName =
      typeof capability?.provider_name === "string"
        ? capability.provider_name
        : "";
    const fulfillmentPath = normalizeFulfillmentPath(
      capability?.fulfillment_path,
    );
    const modelName =
      typeof capability?.model_name === "string"
        ? capability.model_name
        : typeof payload.model === "string"
          ? payload.model
          : "";

    if (!modelName) {
      this.sendTaskError(
        taskId,
        "llm_inference assignment missing model_name.",
      );
      return;
    }

    solverLogger.info(
      {
        taskId,
        fulfillmentPath,
        providerName,
        modelName,
      },
      "solver_llm_dispatch",
    );

    const emitChunk = (chunk: InferenceChunk): void => {
      this.sendTaskMessage({
        type: "task_chunk",
        task_id: taskId,
        chunk,
      });
    };

    try {
      const result =
        fulfillmentPath === "cli"
          ? await fulfillViaClaudeCli({
              payload: payload as LlmTaskPayload,
              modelName,
              spawnImpl: this.spawnImpl,
              cliTimeoutMs: this.cliTimeoutMs,
              onChunk: emitChunk,
            })
          : fulfillmentPath === "cli_codex"
            ? await fulfillViaCodexCli({
                payload: payload as LlmTaskPayload,
                modelName,
                spawnImpl: this.spawnImpl,
                cliTimeoutMs: this.cliTimeoutMs,
                onChunk: emitChunk,
              })
            : await fulfillViaApi({
                payload: payload as LlmTaskPayload,
                providerName,
                modelName,
                framework: this.config.framework,
                providerResolver: this.providerResolver,
                fetchImpl: this.fetchImpl,
                fetchTimeoutMs: this.fetchTimeoutMs,
                maxSpendPerRequest:
                  this.config.inference?.maxSpendPerRequest ?? null,
                onChunk: emitChunk,
              });

      this.sendTaskMessage({
        type: "task_complete",
        task_id: taskId,
        usage: result.usage,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendTaskError(taskId, message);
    }
  }

  private async fulfillExtensibleTask(
    task: TaskAssignment,
    taskType: ExtensibleTaskType,
  ): Promise<void> {
    const taskId = task.task_id;
    const assignedCapability = parseAssignedCapability(task, taskType);
    if (typeof assignedCapability === "string") {
      this.sendTaskError(taskId, assignedCapability);
      return;
    }

    const capabilityKey = buildExtensibleTaskIdentityKey(assignedCapability);
    const entry = this.extensibleDispatchLookup.get(capabilityKey);
    if (!entry) {
      this.sendTaskError(
        taskId,
        `Assigned capability '${assignedCapability.provider_name}/${assignedCapability.model_name}/${assignedCapability.fulfillment_path}' for task type '${taskType}' is not available in the local solver runtime.`,
      );
      return;
    }

    try {
      const result = await fulfillExtensibleTaskPayload(entry, task.payload, {
        fetchImpl: this.fetchImpl,
        fetchTimeoutMs: this.fetchTimeoutMs,
      });

      this.sendTaskMessage({
        type: "task_complete",
        task_id: taskId,
        result,
      });
    } catch (error: unknown) {
      if (error instanceof WebSearchFulfillmentError) {
        this.sendTaskError(taskId, error.message, error.category ?? undefined);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.sendTaskError(taskId, `${taskType} failed: ${message}`);
    }
  }

  private async syncCapabilityRegistration(): Promise<void> {
    if (
      !this.ws.isConnected() ||
      this.capabilityRegistrationState !== "unregistered"
    ) {
      return;
    }

    try {
      await this.refreshDomainPolicyFromConfig();
      sendSubscribe(
        this.ws,
        this.capabilities,
        this.config.solver.domainPolicy,
      );
      this.capabilityRegistrationState = "pending";
      this.armCapabilitySubscribeAckTimeout();
      solverLogger.info(
        {
          capabilityCount: this.capabilities.length,
        },
        "solver_capabilities_subscribe_sent",
      );
    } catch (error: unknown) {
      this.clearCapabilitySubscribeAckTimeout();
      this.capabilityRegistrationState = "unregistered";
      solverLogger.warn({ err: error }, "solver_capabilities_subscribe_failed");
      void this.tryCapabilityFallbackRegistration();
    }
  }

  private async refreshDomainPolicyFromConfig(): Promise<void> {
    try {
      const latestConfig = await this.configLoader();
      if (
        latestConfig === null ||
        latestConfig.accountId !== this.config.accountId
      ) {
        return;
      }
      this.config.solver.domainPolicy = latestConfig.solver.domainPolicy;
    } catch (error: unknown) {
      solverLogger.warn({ err: error }, "solver_config_reload_failed");
    }
  }

  private async tryCapabilityFallbackRegistration(): Promise<void> {
    if (!this.capabilityFallbackRegistrar) {
      return;
    }

    try {
      await this.capabilityFallbackRegistrar(
        this.config,
        this.capabilities,
        this.fetchImpl,
      );
      this.clearCapabilitySubscribeAckTimeout();
      this.capabilityRegistrationState = "registered";
      solverLogger.info(
        { capabilityCount: this.capabilities.length },
        "solver_capabilities_registered_http_fallback",
      );
    } catch (error: unknown) {
      this.capabilityRegistrationState = "unregistered";
      solverLogger.warn(
        { err: error },
        "solver_capabilities_fallback_registration_failed",
      );
    }
  }

  private handleSubscribeAck(message: WebSocketMessage): void {
    this.clearCapabilitySubscribeAckTimeout();
    this.capabilityRegistrationState = "registered";
    const upserted =
      typeof message.upserted === "number"
        ? message.upserted
        : this.capabilities.length;
    solverLogger.info({ upserted }, "solver_capabilities_subscribe_ack");
  }

  private async handleWebSocketErrorMessage(
    message: WebSocketMessage,
  ): Promise<void> {
    const errorMessage = extractWebSocketErrorMessage(message);

    if (this.capabilityRegistrationState === "pending") {
      this.clearCapabilitySubscribeAckTimeout();
      this.capabilityRegistrationState = "unregistered";
      solverLogger.warn(
        { error: errorMessage },
        "solver_capabilities_subscribe_rejected",
      );
      await this.tryCapabilityFallbackRegistration();
      return;
    }

    solverLogger.warn(
      { error: errorMessage },
      "solver_ws_error_message_received",
    );
  }

  private armCapabilitySubscribeAckTimeout(): void {
    this.clearCapabilitySubscribeAckTimeout();
    this.capabilitySubscribeAckTimer = setTimeout(() => {
      if (!this.running || this.capabilityRegistrationState !== "pending") {
        return;
      }

      this.capabilityRegistrationState = "unregistered";
      solverLogger.warn(
        { timeoutMs: DEFAULT_CAPABILITY_SUBSCRIBE_ACK_TIMEOUT_MS },
        "solver_capabilities_subscribe_ack_timeout",
      );
      void this.tryCapabilityFallbackRegistration();
    }, DEFAULT_CAPABILITY_SUBSCRIBE_ACK_TIMEOUT_MS);
  }

  private clearCapabilitySubscribeAckTimeout(): void {
    if (!this.capabilitySubscribeAckTimer) {
      return;
    }
    clearTimeout(this.capabilitySubscribeAckTimer);
    this.capabilitySubscribeAckTimer = null;
  }

  private evaluateSchedule(): void {
    if (!this.running) {
      return;
    }

    this.desiredRoutingActive =
      this.config.solver.enabled &&
      isInScheduleWindow(this.config.solver.schedule, this.now());

    if (
      !this.desiredRoutingActive &&
      !this.routingPaused &&
      this.inFlightTasks > 0
    ) {
      this.pendingSchedulePause = true;
      return;
    }

    this.syncDesiredRoutingState();
  }

  private syncDesiredRoutingState(): void {
    if (!this.ws.isConnected()) {
      return;
    }

    if (!this.initialRoutingSynced) {
      if (this.desiredRoutingActive) {
        this.safeRoutingMessage("resume");
      } else {
        this.safeRoutingMessage("pause", "schedule");
      }
      this.initialRoutingSynced = true;
      return;
    }

    if (this.desiredRoutingActive && this.routingPaused) {
      this.safeRoutingMessage("resume");
      return;
    }

    if (
      !this.desiredRoutingActive &&
      !this.routingPaused &&
      this.inFlightTasks === 0
    ) {
      this.safeRoutingMessage("pause", "schedule");
    }
  }

  private trySendDeferredSchedulePause(): void {
    if (
      !this.pendingSchedulePause ||
      this.inFlightTasks > 0 ||
      !this.ws.isConnected()
    ) {
      return;
    }

    this.safeRoutingMessage("pause", "schedule");
  }

  private safeRoutingMessage(
    action: "resume" | "pause",
    reason: PauseReason = "schedule",
  ): void {
    try {
      if (action === "resume") {
        sendResume(this.ws);
        this.routingPaused = false;
        this.pendingSchedulePause = false;
        solverLogger.info({ reason: "schedule" }, "solver_resume_sent");
      } else {
        sendPause(this.ws, reason);
        this.routingPaused = true;
        this.pendingSchedulePause = false;
        solverLogger.info({ reason }, "solver_pause_sent");
      }
    } catch (error: unknown) {
      solverLogger.warn(
        { err: error, action, reason },
        "solver_routing_message_failed",
      );
    }
  }

  private sendTaskError(
    taskId: string,
    error: string,
    category?: TaskErrorCategory,
  ): void {
    this.sendTaskMessage({
      type: "task_error",
      task_id: taskId,
      error,
      category,
    });

    if (shouldNotifyOnSolverError(error)) {
      this.queueNotification(async () => {
        await this.notifySolverError(error);
      });
    }
  }

  private sendTaskMessage(message: OutboundTaskMessage): void {
    try {
      this.ws.send(message);
      if (message.type === "task_complete") {
        solverLogger.info({ taskId: message.task_id }, "solver_task_completed");
      } else if (message.type === "task_error") {
        solverLogger.info(
          { taskId: message.task_id, error: message.error ?? "unknown" },
          "solver_task_error_sent",
        );
      }
      if (message.type === "task_complete") {
        this.queueNotification(async () => {
          await this.handleTaskCompletionNotifications();
        });
      }
    } catch (error: unknown) {
      solverLogger.warn(
        { err: error, messageType: message.type },
        "solver_task_send_failed",
      );
    }
  }

  private queueNotification(work: () => Promise<void>): void {
    if (!this.notificationsEnabled) {
      return;
    }

    this.notificationQueue = this.notificationQueue
      .then(() => work())
      .catch((error: unknown) => {
        solverLogger.warn({ err: error }, "solver_notification_worker_failed");
      });
  }

  private async handleTaskCompletionNotifications(): Promise<void> {
    let status: StatusResponse;
    try {
      status = await this.statusProvider(
        this.config.apiBaseUrl,
        this.config.apiKey,
      );
    } catch (error: unknown) {
      solverLogger.warn(
        { err: error },
        "solver_notification_status_fetch_failed",
      );
      return;
    }

    const now = this.now();
    const date = isoDate(now);
    const previous = this.lastStatusSnapshot;

    if (
      this.config.notifications.dailySummary &&
      previous &&
      previous.date !== date &&
      (previous.tasksSolvedToday > 0 || previous.earningsToday > 0)
    ) {
      const uptimeHours = formatUptimeHours(now.getTime() - this.startedAtMs);
      await this.sendNotificationSafe(
        `Today: ${previous.tasksSolvedToday} tasks, ${previous.earningsToday.toFixed(2)} points earned, ${uptimeHours}h uptime.`,
      );
    }

    const baselineEarnings =
      previous && previous.date === date ? previous.earningsToday : 0;
    const baselineTasks =
      previous && previous.date === date ? previous.tasksSolvedToday : 0;
    const earningsDelta = Math.max(
      0,
      status.solverState.earningsToday - baselineEarnings,
    );
    const tasksDelta = Math.max(
      0,
      status.solverState.tasksSolvedToday - baselineTasks,
    );

    if (earningsDelta > 0 || tasksDelta > 0) {
      this.pendingEarningsPoints += earningsDelta;
      this.pendingEarningTasks += tasksDelta;
    }

    const threshold = Math.max(0, this.config.notifications.earningsThreshold);
    if (
      this.pendingEarningTasks > 0 &&
      this.pendingEarningsPoints >= threshold
    ) {
      await this.sendNotificationSafe(
        `Earned ${this.pendingEarningsPoints.toFixed(2)} points from ${this.pendingEarningTasks} tasks. Balance: ${status.balance.toFixed(2)} points.`,
      );
      this.pendingEarningsPoints = 0;
      this.pendingEarningTasks = 0;
    }

    if (
      status.balance < LOW_BALANCE_THRESHOLD_POINTS &&
      !this.lowBalanceAlertSent
    ) {
      await this.sendNotificationSafe(
        "Balance below 50.00 points - solver may stop accepting inference tasks.",
      );
      this.lowBalanceAlertSent = true;
    } else if (status.balance >= LOW_BALANCE_THRESHOLD_POINTS) {
      this.lowBalanceAlertSent = false;
    }

    this.lastStatusSnapshot = {
      date,
      tasksSolvedToday: status.solverState.tasksSolvedToday,
      earningsToday: status.solverState.earningsToday,
      balance: status.balance,
    };
  }

  private async notifySolverError(reason: string): Promise<void> {
    const nowMs = this.now().getTime();
    if (
      nowMs - this.lastSolverErrorNotificationAtMs <
      SOLVER_ERROR_NOTIFICATION_COOLDOWN_MS
    ) {
      return;
    }

    this.lastSolverErrorNotificationAtMs = nowMs;
    await this.sendNotificationSafe(`Solver error: ${reason}.`);
  }

  private async sendNotificationSafe(message: string): Promise<void> {
    try {
      await this.notificationSender(this.config, message);
    } catch (error: unknown) {
      solverLogger.warn({ err: error }, "solver_notification_send_failed");
    }
  }
}

/**
 * Starts the solver runtime with derived capabilities and runtime state.
 */
export async function startSolver(
  config: ClawrmaConfig,
  dependencies: SolverRuntimeDependencies = {},
): Promise<SolverHandle> {
  const runtimeState = await resolveSolverRuntimeState(
    config,
    {
      detectCapabilitiesImpl: dependencies.detectCapabilitiesImpl,
    },
    extractInternalSolverRuntimeOptions(
      dependencies as InternalSolverRuntimeOptions,
    ),
  );

  const runtime = new SolverRuntime(config, {
    ...dependencies,
    ...runtimeState,
  });

  return runtime;
}

/**
 * Registers the current solver capability snapshot via HTTP when WebSocket
 * subscribe registration is unavailable.
 */
export async function registerCapabilitiesHttpFallback(
  config: ClawrmaConfig,
  capabilities: SolverCapability[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const payload = capabilities.map((capability) => ({
    task_type: capability.task_type,
    tier: "strong",
    billing_type: capability.billing_type,
    fulfillment_path: capability.fulfillment_path,
    provider_name: capability.provider_name,
    model_name: capability.model_name,
    marginal_cost: "0",
    min_price_points: "0",
    max_concurrent: 1,
  }));

  const baseHeaders: HeadersInit = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
    "x-api-key": config.apiKey,
  };

  const endpointCandidates = [
    { method: "POST", path: "/v1/solver/capabilities" },
    { method: "PUT", path: "/v1/capabilities" },
  ] as const;

  let lastError: Error | null = null;
  for (const endpoint of endpointCandidates) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFAULT_CAPABILITIES_FALLBACK_TIMEOUT_MS,
    );

    try {
      const response = await fetchImpl(`${config.apiBaseUrl}${endpoint.path}`, {
        method: endpoint.method,
        headers: baseHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        solverLogger.info(
          {
            method: endpoint.method,
            path: endpoint.path,
            capabilityCount: capabilities.length,
          },
          "solver_capabilities_registered_http_fallback",
        );
        return;
      }

      if (response.status === 404 || response.status === 405) {
        continue;
      }

      const errorBody = (await response.text()).slice(0, 400);
      throw new Error(
        `Capabilities fallback ${endpoint.method} ${endpoint.path} failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
      );
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function fulfillExtensibleTaskPayload(
  entry: ExtensibleTaskDispatchEntry,
  payload: unknown,
  context: BrowserFulfillContext,
): Promise<
  | Awaited<ReturnType<WebSearchFulfiller["fulfill"]>>
  | Awaited<ReturnType<ScreenshotFulfiller["fulfill"]>>
  | Awaited<ReturnType<PageSnapshotFulfiller["fulfill"]>>
> {
  switch (entry.taskType) {
    case "web_search":
      return (entry.fulfiller as WebSearchFulfiller).fulfill(payload, context);
    case "screenshot":
      return (entry.fulfiller as ScreenshotFulfiller).fulfill(
        payload as ScreenshotTaskPayload,
        context,
      );
    case "page_snapshot":
      return (entry.fulfiller as PageSnapshotFulfiller).fulfill(
        payload as PageSnapshotTaskPayload,
        context,
      );
  }
}

function shouldNotifyOnSolverError(reason: string): boolean {
  if (!reason) {
    return false;
  }

  return (
    reason.startsWith("proxy_fetch failed:") ||
    reason.startsWith("API fulfillment failed:") ||
    reason.startsWith("CLI fulfillment failed:") ||
    reason.startsWith("Codex CLI fulfillment failed:")
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatUptimeHours(elapsedMs: number): string {
  const hours = Math.max(0, elapsedMs) / 3_600_000;
  if (!Number.isFinite(hours)) {
    return "0.0";
  }
  return hours.toFixed(1);
}
