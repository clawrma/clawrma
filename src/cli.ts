import { Command } from "commander";
import { access, readFile, writeFile } from "node:fs/promises";
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from "node:process";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getBalance,
  getStatus,
  requestChatCompletions,
  submitTask,
  updateAccountSettings,
  truncateKey,
} from "./client.js";
import { CONFIG_PATH } from "./constants.js";
import { readConfig, writeConfig } from "./config.js";
import { scanPrompt } from "./safety/scan.js";
import type {
  ClawrmaConfig,
  ApiError,
  FrameworkType,
  PageSnapshotTaskPayload,
  ProxyFetchTaskPayload,
  TaskType,
} from "./types.js";
import type { SolverHandle } from "./solver.js";

const WINDOWS_UNSUPPORTED_MESSAGE =
  "Clawrma is not supported on Windows. Use WSL or a Linux/macOS environment.";
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const ASCII_WHITESPACE_PATTERN = /[ \t\n\r\f\v]+/g;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface InferCommandOptions {
  system?: string;
  model?: string;
  stream?: boolean;
  stdin?: boolean;
  safetyScan?: boolean;
}

type AuthStatusResult =
  | {
      state: "authenticated";
      exitCode: 0;
      accountId: string;
      apiKey: string;
      apiBaseUrl: string;
      balance: number;
    }
  | {
      state: "not_configured";
      exitCode: 1;
    }
  | {
      state: "cannot_reach_api";
      exitCode: 2;
      accountId: string;
      apiKey: string;
      apiBaseUrl: string;
      error: string;
    }
  | {
      state: "auth_rejected";
      exitCode: 3;
      accountId: string;
      apiKey: string;
      apiBaseUrl: string;
      error: string;
    }
  | {
      state: "invalid_local_config";
      exitCode: 4;
      error: string;
    }
  | {
      state: "openclaw_sync_broken";
      exitCode: 5;
      accountId: string;
      apiKey: string;
      apiBaseUrl: string;
      error: string;
    };

const DEFAULT_CLI_IO: CliIo = {
  stdin: processStdin,
  stdout: processStdout,
  stderr: processStderr,
};

function registerCommands(program: Command, io: CliIo): void {
  // ── Auth & setup ──────────────────────────────────────────────────

  const auth = program
    .command("auth")
    .description("Check and configure Clawrma authentication");

  auth
    .command("status")
    .description("Show current auth state and remediation guidance")
    .addHelpText(
      "after",
      "\nExample:\n" +
        "  $ npx clawrma auth status\n" +
        "  Clawrma: authenticated\n" +
        "    Account   acc_abc123\n" +
        "    Balance   42.00 points\n",
    )
    .action(async () => {
      const status = await getAuthStatus();
      printAuthStatus(status);
      process.exitCode = status.exitCode;
    });

  auth
    .command("setup")
    .description("Run the OpenClaw-first auth setup flow")
    .option("--interactive", "Force interactive setup")
    .option("--no-interactive", "Force non-interactive setup")
    .option("--solver <on|off>", "Enable or disable solver")
    .option("--schedule <preset>", "Schedule preset")
    .option("--api-base-url <url>", "Override API base URL")
    .action(async (options: Record<string, unknown>) => {
      const { runSetup } = await import("./setup.js");
      await runSetup({
        framework: "openclaw",
        interactive:
          typeof options.interactive === "boolean" ? options.interactive : true,
        solver: options.solver as "on" | "off" | undefined,
        schedule: options.schedule as
          | "outside-active-hours"
          | "overnight"
          | "idle-always"
          | "custom"
          | "off"
          | undefined,
        apiBaseUrl: options.apiBaseUrl as string | undefined,
      });
    });

  program
    .command("setup")
    .description(
      "Run standalone setup (use 'auth setup' instead for OpenClaw users)",
    )
    .requiredOption("--framework <openclaw|none>", "Framework type")
    .option("--interactive", "Force interactive setup")
    .option("--no-interactive", "Force non-interactive setup")
    .option("--solver <on|off>", "Enable or disable solver")
    .option("--schedule <preset>", "Schedule preset")
    .option("--web-fetch-fallback <yes|no>", "Configure web fetch fallback")
    .option("--api-base-url <url>", "Override API base URL")
    .action(async (options: Record<string, unknown>) => {
      const { runSetup } = await import("./setup.js");
      const framework = String(options.framework) as FrameworkType;
      if (framework !== "openclaw" && framework !== "none") {
        throw new Error(
          `Unsupported framework '${String(options.framework)}'.`,
        );
      }

      await runSetup({
        framework,
        interactive:
          typeof options.interactive === "boolean"
            ? options.interactive
            : undefined,
        solver: options.solver as "on" | "off" | undefined,
        schedule: options.schedule as
          | "outside-active-hours"
          | "overnight"
          | "idle-always"
          | "custom"
          | "off"
          | undefined,
        webFetchFallback: options.webFetchFallback as "yes" | "no" | undefined,
        apiBaseUrl: options.apiBaseUrl as string | undefined,
      });
    });

  // ── Config ────────────────────────────────────────────────────────

  const config = program
    .command("config")
    .description("Show or update local Clawrma configuration");

  config
    .command("show")
    .description("Print current config (API key is masked)")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      printJson({
        ...cfg,
        apiKey: maskConfigApiKey(cfg.apiKey),
      });
    });

  config
    .command("set <key> <value>")
    .description("Set a config value and sync supported settings to the server")
    .addHelpText(
      "after",
      "\nExample:\n" + "  $ npx clawrma config set promptSafetyScan false\n",
    )
    .action(async (key: string, value: string) => {
      const cfg = await loadRequiredConfigObject();
      await setConfigValue(cfg, key, value);
    });

  // ── Task commands ─────────────────────────────────────────────────

  program
    .command("search <query...>")
    .description("Run a web search (returns JSON)")
    .option("--count <count>", "Result count (1-10)", "5")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        '  $ npx clawrma search "rust async patterns"\n' +
        "  $ npx clawrma search how to install docker --count 3\n",
    )
    .action(async (queryParts: string[], options: { count?: string }) => {
      const query = normalizeSearchQuery(queryParts);
      const count = parseResultCount(options.count ?? "5");
      const cfg = await loadRequiredConfig();

      try {
        const result = await submitTask(
          cfg.apiBaseUrl,
          cfg.apiKey,
          "web_search",
          { query, count },
          !isPromptSafetyScanEnabled(cfg),
        );
        printJson({
          query: asString(result.query, query),
          results: normalizeSearchResults(result.results),
          elapsed_ms: asNumber(result.elapsed_ms, 0),
        });
      } catch (error: unknown) {
        throw mapTaskCommandError(error, "web_search");
      }
    });

  program
    .command("fetch <url>")
    .description("Fetch a URL and return content as JSON")
    .option("--raw-html", "Request raw HTML from compatible solvers")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ npx clawrma fetch https://example.com\n" +
        "  $ npx clawrma fetch https://example.com --raw-html\n",
    )
    .action(async (url: string, options: { rawHtml?: boolean }) => {
      const parsedUrl = parseHttpUrl(url);
      const cfg = await loadRequiredConfig();
      const payload: ProxyFetchTaskPayload = {
        url: parsedUrl,
      };
      if (options.rawHtml) {
        payload.raw_html = true;
      }

      try {
        const result = await submitTask(
          cfg.apiBaseUrl,
          cfg.apiKey,
          "proxy_fetch",
          payload,
          !isPromptSafetyScanEnabled(cfg),
        );
        printJson({
          url: asString(result.url, parsedUrl),
          status_code: asNumber(result.status_code, 0),
          headers: asStringMap(result.headers),
          body: asString(result.body, ""),
          content_format: asOptionalString(result.content_format),
          original_content_type: asOptionalString(result.original_content_type),
          elapsed_ms: asNumber(result.elapsed_ms, 0),
        });
      } catch (error: unknown) {
        throw mapTaskCommandError(error, "proxy_fetch");
      }
    });

  program
    .command("screenshot <url>")
    .description("Capture a page screenshot (writes image file)")
    .option("--viewport <widthxheight>", "Viewport size", "1280x720")
    .option("--full-page", "Capture full page")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ npx clawrma screenshot https://example.com\n" +
        "  $ npx clawrma screenshot https://example.com --full-page\n",
    )
    .action(
      async (
        url: string,
        options: {
          viewport?: string;
          fullPage?: boolean;
        },
      ) => {
        const parsedUrl = parseHttpUrl(url);
        const viewport = parseViewport(options.viewport ?? "1280x720");
        const cfg = await loadRequiredConfig();

        try {
          const result = await submitTask(
            cfg.apiBaseUrl,
            cfg.apiKey,
            "screenshot",
            {
              url: parsedUrl,
              viewport,
              full_page: Boolean(options.fullPage),
            },
            !isPromptSafetyScanEnabled(cfg),
          );

          const imageBase64 = parseBase64Image(result.image_base64);
          if (!imageBase64) {
            throw new Error(
              "Screenshot response did not include image_base64.",
            );
          }

          const imageBytes = decodeBase64ImageStrict(imageBase64);
          assertValidPngImageBytes(imageBytes);
          const outputPath = buildScreenshotOutputPath(parsedUrl);
          await writeFile(outputPath, imageBytes);

          printJson({
            output_path: outputPath,
            format: "png",
            url: asString(result.url, parsedUrl),
            elapsed_ms: asNumber(result.elapsed_ms, 0),
          });
        } catch (error: unknown) {
          throw mapTaskCommandError(error, "screenshot");
        }
      },
    );

  program
    .command("snapshot <url>")
    .description("Capture structured page data (returns JSON)")
    .option("--mode <ai|aria>", "Snapshot mode")
    .option("--selector <selector>", "CSS selector scope")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ npx clawrma snapshot https://example.com\n" +
        "  $ npx clawrma snapshot https://example.com --mode ai --selector main\n",
    )
    .action(
      async (
        url: string,
        options: {
          mode?: string;
          selector?: string;
        },
      ) => {
        const parsedUrl = parseHttpUrl(url);
        const cfg = await loadRequiredConfig();
        const payload: PageSnapshotTaskPayload = {
          url: parsedUrl,
        };
        if (options.mode) {
          payload.mode = parseSnapshotMode(options.mode);
        }
        if (options.selector) {
          payload.selector = options.selector;
        }

        try {
          const result = await submitTask(
            cfg.apiBaseUrl,
            cfg.apiKey,
            "page_snapshot",
            payload,
            !isPromptSafetyScanEnabled(cfg),
          );
          printJson({
            snapshot: result.snapshot,
            snapshot_format: result.snapshot_format,
            title: asString(result.title, ""),
            url: asString(result.url, parsedUrl),
            elapsed_ms: asNumber(result.elapsed_ms, 0),
          });
        } catch (error: unknown) {
          throw mapTaskCommandError(error, "page_snapshot");
        }
      },
    );

  program
    .command("infer [prompt]")
    .description("Run inference via the solver network")
    .option("--system <text>", "System prompt")
    .option("--model <name>", "Model name", "clawrma/strong")
    .option("--no-stream", "Return a complete response instead of streaming")
    .option("--stdin", "Read the prompt from stdin instead of argv")
    .option("--no-safety-scan", "Skip the local prompt safety scan")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        '  $ npx clawrma infer "Explain async/await in Rust"\n' +
        '  $ echo "Summarize this" | npx clawrma infer --stdin\n' +
        '  $ npx clawrma infer "Hello" --no-stream\n',
    )
    .action(
      async (prompt: string | undefined, options: InferCommandOptions) => {
        const cfg = await loadRequiredConfig();
        const userPrompt = options.stdin
          ? await readPromptFromStream(io.stdin)
          : parsePromptArgument(prompt);
        const request = buildInferenceRequest(userPrompt, options);

        if (isPromptSafetyScanEnabled(cfg) && options.safetyScan !== false) {
          const fullText = request.messages
            .map((message) => message.content)
            .join("\n\n");
          const flags = scanPrompt(fullText);
          if (flags.length > 0) {
            const labels = flags.map((flag) => flag.label).join(", ");
            throw new Error(
              `Sensitive content detected (${labels}). Use --no-safety-scan to skip local check, or disable permanently with: npx clawrma config set promptSafetyScan false`,
            );
          }
        }

        const response = await requestChatCompletions(
          cfg.apiBaseUrl,
          cfg.apiKey,
          request,
        );
        if (request.stream) {
          await writeStreamingInferenceResponse(response, io.stdout);
          return;
        }

        await writeNonStreamingInferenceResponse(response, io.stdout);
      },
    );

  // ── Account ───────────────────────────────────────────────────────

  program
    .command("status")
    .description("Show balance, solver state, and capabilities")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      const status = await getStatus(cfg.apiBaseUrl, cfg.apiKey);
      const solverStatus = describeSolverStatus(cfg, status);

      console.log("Clawrma");
      console.log("");
      console.log(`  Agent       ${truncateKey(cfg.apiKey)}`);
      console.log(`  Balance     ${formatPoints(status.balance)}`);
      console.log(
        `  Solver      ${solverStatus.label} - ${status.solverState.tasksSolvedToday} tasks solved today`,
      );
      if (solverStatus.nextAction) {
        console.log(`  Next        ${solverStatus.nextAction}`);
      }
      console.log(`  Uptime      ${formatUptime(status.uptimeSeconds)}`);
      console.log(
        `  Last task   ${formatRecentActivity(status.recentActivity)}`,
      );

      if (status.capabilities.length > 0) {
        console.log("  Capabilities");
        for (const capability of status.capabilities) {
          console.log(
            `    - ${capability.task_type} via ${capability.fulfillment_path} (${capability.provider_name}/${capability.model_name})`,
          );
        }
      }

      if (cfg.framework === "openclaw") {
        const openClawApiKey = await readOpenClawClawrmaApiKey();
        if (openClawApiKey.state === "unavailable") {
          console.warn(
            "Warning: Unable to read OpenClaw CLAWRMA_API_KEY from openclaw.json. Run 'npx clawrma auth setup' to verify sync.",
          );
        } else if (!openClawApiKey.apiKey) {
          console.warn(
            "Warning: OpenClaw CLAWRMA_API_KEY is missing in openclaw.json. Run 'npx clawrma auth setup' to re-sync.",
          );
        } else if (openClawApiKey.apiKey !== cfg.apiKey) {
          console.warn(
            "Warning: API key mismatch between ~/.clawrma/config.json and openclaw.json. Run 'npx clawrma auth setup' to re-sync.",
          );
        }
      }
    });

  program
    .command("balance")
    .description("Show account balance")
    .action(async () => {
      const cfg = await loadRequiredConfig();
      const balance = await getBalance(cfg.apiBaseUrl, cfg.apiKey);
      console.log(`Balance: ${formatPoints(balance.balance)}`);
    });

  program
    .command("version")
    .description("Show installed version")
    .action(async () => {
      const version = await readPackageVersion();
      console.log(version);
    });

  // ── Solver ────────────────────────────────────────────────────────

  const solver = program
    .command("solver")
    .description("Earn credits by solving tasks for other agents");
  solver
    .command("run")
    .description("Run the foreground solver runtime")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      const { startSolver } = await loadSolverCommands();
      const handle = await startSolver(cfg);

      console.log("Solver runtime started. Press Ctrl+C to stop.");
      await waitForSolverTermination(handle);
      console.log("Solver runtime stopped.");
    });
  solver
    .command("start")
    .description("Start solver task intake")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      const { startSolverIntake } = await loadSolverCommands();
      await startSolverIntake(cfg);
      console.log("Solver resumed. solver.enabled is now true.");
    });
  solver
    .command("stop")
    .description("Pause solver task intake")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      const { stopSolverIntake } = await loadSolverCommands();
      await stopSolverIntake(cfg);
      console.log("Solver paused. solver.enabled is now false.");
    });
  solver
    .command("config")
    .description("Configure solver options")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      const { reconfigureSolver } = await loadSolverCommands();
      await reconfigureSolver(cfg);
      console.log("Solver configuration updated.");
    });
  const solverDomains = solver
    .command("domains")
    .description("Show or change solver domain policy");
  solverDomains.action(async () => {
    const cfg = await loadRequiredConfigObject();
    console.log(formatDomainPolicySummary(cfg.solver.domainPolicy));
  });
  solverDomains
    .command("open")
    .description("Route browser tasks to the open internet")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      await writeConfig({
        ...cfg,
        solver: {
          ...cfg.solver,
          domainPolicy: "open",
        },
      });
      console.log("Solver domain policy set to open internet.");
    });
  solverDomains
    .command("default")
    .description("Route browser tasks to popular sites only")
    .action(async () => {
      const cfg = await loadRequiredConfigObject();
      await writeConfig({
        ...cfg,
        solver: {
          ...cfg.solver,
          domainPolicy: "allowlist",
        },
      });
      console.log("Solver domain policy set to popular sites only.");
    });
}

async function loadSolverCommands(): Promise<
  Pick<
    typeof import("./solver.js"),
    | "startSolver"
    | "startSolverIntake"
    | "stopSolverIntake"
    | "reconfigureSolver"
  >
> {
  const {
    startSolver,
    startSolverIntake,
    stopSolverIntake,
    reconfigureSolver,
  } = await import("./solver.js");
  return {
    startSolver,
    startSolverIntake,
    stopSolverIntake,
    reconfigureSolver,
  };
}

async function waitForSolverTermination(handle: SolverHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const listeners = TERMINATION_SIGNALS.map((signal) => {
      const listener = (): void => {
        if (stopping) {
          return;
        }
        stopping = true;
        cleanup();
        console.log(`Received ${signal}. Stopping solver runtime...`);
        void handle.stop().then(resolve, reject);
      };
      process.once(signal, listener);
      return { signal, listener };
    });

    const cleanup = (): void => {
      for (const { signal, listener } of listeners) {
        process.removeListener(signal, listener);
      }
    };
  });
}

async function setConfigValue(
  config: ClawrmaConfig,
  key: string,
  value: string,
): Promise<void> {
  if (key !== "promptSafetyScan") {
    throw new Error(`Unsupported config key '${key}'.`);
  }

  const promptSafetyScan = parseBooleanValue(value, key);
  const updatedConfig: ClawrmaConfig = {
    ...config,
    promptSafetyScan,
  };

  await writeConfig(updatedConfig);

  try {
    await updateAccountSettings(
      updatedConfig.apiBaseUrl,
      updatedConfig.apiKey,
      {
        prompt_safety_scan: promptSafetyScan,
      },
    );
    console.log(
      `Prompt safety scan ${promptSafetyScan ? "enabled" : "disabled"} locally and on server.`,
    );
  } catch (error: unknown) {
    console.warn(
      `Warning: Prompt safety scan ${promptSafetyScan ? "enabled" : "disabled"} locally, but the server setting was not updated: ${getErrorMessage(error)}`,
    );
  }
}

function formatPoints(value: number): string {
  return `${value.toFixed(2)} points`;
}

function describeSolverStatus(
  config: Pick<ClawrmaConfig, "solver">,
  status: Awaited<ReturnType<typeof getStatus>>,
): { label: string; nextAction: string | null } {
  if (status.solverState.connected === false) {
    return {
      label: "configured, not running",
      nextAction: "npx clawrma solver run",
    };
  }
  if (status.solverState.connected !== true) {
    return {
      label: config.solver.enabled ? "connection unknown" : "paused",
      nextAction: config.solver.enabled ? null : "npx clawrma solver run",
    };
  }
  if (status.solverState.paused === true) {
    return {
      label: "paused",
      nextAction: "npx clawrma solver start",
    };
  }
  if (status.solverState.activeTasks > 0) {
    return {
      label: `running (active tasks: ${status.solverState.activeTasks})`,
      nextAction: null,
    };
  }
  return {
    label: "running (idle)",
    nextAction: null,
  };
}

function formatDomainPolicySummary(
  domainPolicy: ClawrmaConfig["solver"]["domainPolicy"],
): string {
  return domainPolicy === "open" ? "open internet" : "popular sites only";
}

function isPromptSafetyScanEnabled(
  config: Pick<ClawrmaConfig, "promptSafetyScan">,
): boolean {
  return config.promptSafetyScan !== false;
}

function formatUptime(uptimeSeconds: number | null): string {
  if (uptimeSeconds === null || uptimeSeconds < 0) {
    return "unknown";
  }

  const totalSeconds = Math.floor(uptimeSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSeconds}s`;
}

function formatRecentActivity(recentActivity: {
  tasksSolvedToday: number;
  earningsToday: number;
}): string {
  if (recentActivity.tasksSolvedToday <= 0) {
    return "none today";
  }

  return `${recentActivity.tasksSolvedToday} tasks today (${formatPoints(recentActivity.earningsToday)})`;
}

function buildInferenceRequest(
  prompt: string,
  options: InferCommandOptions,
): {
  model: string;
  stream: boolean;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  const model = parseModelName(options.model ?? "clawrma/strong");
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [];

  if (typeof options.system === "string" && options.system.length > 0) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: prompt });

  return {
    model,
    stream: options.stream !== false,
    messages,
  };
}

function parseModelName(value: string): string {
  const model = value.trim();
  if (!model) {
    throw new Error("Model name cannot be empty.");
  }
  return model;
}

function parseBooleanValue(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(
    `Invalid value '${value}' for '${key}'. Expected 'true' or 'false'.`,
  );
}

function parsePromptArgument(prompt: string | undefined): string {
  if (typeof prompt !== "string") {
    throw new Error("Infer prompt is required unless --stdin is set.");
  }

  if (!prompt.trim()) {
    throw new Error("Infer prompt cannot be empty.");
  }

  return prompt;
}

async function readPromptFromStream(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  stream.setEncoding("utf8");

  let content = "";
  for await (const chunk of stream) {
    content += String(chunk);
  }

  const trimmed = content.trimEnd();
  if (!trimmed.trim()) {
    throw new Error("Infer prompt cannot be empty.");
  }

  return trimmed;
}

async function writeStreamingInferenceResponse(
  response: Response,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  if (!response.body) {
    throw new Error("Inference response did not include a response body.");
  }

  let sawDone = false;
  for await (const line of iterateResponseLines(response.body)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const dataPart = line.slice("data: ".length).trim();
    if (!dataPart) {
      continue;
    }

    if (dataPart === "[DONE]") {
      sawDone = true;
      break;
    }

    const content = extractInferenceChunkContent(
      JSON.parse(dataPart) as unknown,
    );
    if (content.length > 0) {
      stdout.write(content);
    }
  }

  if (sawDone) {
    stdout.write("\n");
  }
}

async function writeNonStreamingInferenceResponse(
  response: Response,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  const payload = (await response.json()) as unknown;
  const content = extractInferenceMessageContent(payload);
  stdout.write(`${content}\n`);
}

async function* iterateResponseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
        }
      }
    }

    const finalLine = `${buffer}${decoder.decode()}`.trim();
    if (finalLine) {
      yield finalLine;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractInferenceChunkContent(value: unknown): string {
  const payload = asRecord(value);
  if (!payload) {
    return "";
  }

  if (payload.object === "error") {
    const errorRecord = asRecord(payload.error);
    const message =
      typeof errorRecord?.message === "string"
        ? errorRecord.message
        : "Inference stream failed.";
    throw new Error(message);
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  const first = asRecord(choices[0]);
  const delta = asRecord(first?.delta);
  return typeof delta?.content === "string" ? delta.content : "";
}

function extractInferenceMessageContent(value: unknown): string {
  const payload = asRecord(value);
  if (!payload) {
    throw new Error("Inference response payload was not an object.");
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("Inference response did not include any choices.");
  }

  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  const content = message?.content;
  if (typeof content !== "string") {
    throw new Error("Inference response did not include assistant content.");
  }

  return content;
}

function parseHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Invalid URL '${value}'. Expected http:// or https:// URL.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL protocol '${parsed.protocol}'. Use http:// or https://.`,
    );
  }

  return parsed.toString();
}

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid --viewport '${value}'. Expected format WIDTHxHEIGHT (for example 1280x720).`,
    );
  }

  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      `Invalid --viewport '${value}'. Width and height must be positive integers.`,
    );
  }

  return { width, height };
}

function parseSnapshotMode(value: string): "ai" | "aria" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "ai" || normalized === "aria") {
    return normalized;
  }
  throw new Error(`Invalid --mode '${value}'. Expected 'ai' or 'aria'.`);
}

function normalizeSearchQuery(queryParts: string[]): string {
  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("Search query cannot be empty.");
  }
  return query;
}

function parseResultCount(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid --count '${value}'. Expected an integer between 1 and 10.`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Invalid --count '${value}'. Expected an integer between 1 and 10.`,
    );
  }
  if (parsed < 1 || parsed > 10) {
    throw new Error(
      `Invalid --count '${value}'. Count must be between 1 and 10.`,
    );
  }
  return parsed;
}

function parseBase64Image(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "";
  }

  const marker = "base64,";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex >= 0) {
    return raw.slice(markerIndex + marker.length).trim();
  }

  return raw.trim();
}

function decodeBase64ImageStrict(imageBase64: string): Buffer {
  const normalized = imageBase64.trim().replace(ASCII_WHITESPACE_PATTERN, "");
  if (!normalized) {
    throw new Error("Screenshot response did not include image_base64.");
  }

  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new Error("Screenshot response returned invalid base64 image data.");
  }

  const padded =
    remainder === 0 ? normalized : `${normalized}${"=".repeat(4 - remainder)}`;
  if (!BASE64_PATTERN.test(padded)) {
    throw new Error("Screenshot response returned invalid base64 image data.");
  }

  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64") !== padded) {
    throw new Error("Screenshot response returned invalid base64 image data.");
  }
  return decoded;
}

function assertValidPngImageBytes(imageBytes: Buffer): void {
  if (
    imageBytes.length < PNG_SIGNATURE.length ||
    !imageBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Screenshot response returned non-PNG image data.");
  }
}

function buildScreenshotOutputPath(url: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const safeHost = host || "capture";
  return `${safeHost}-${timestamp}.png`;
}

function mapTaskCommandError(error: unknown, taskType: TaskType): Error {
  const apiError = extractApiError(error);
  if (!apiError) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (
    apiError.status === 402 ||
    apiError.apiError.error.type === "insufficient_balance"
  ) {
    return new Error("Insufficient balance (HTTP 402). Add funds and retry.");
  }

  if (
    apiError.status === 503 ||
    apiError.apiError.error.type === "no_solver" ||
    apiError.apiError.error.message === "no_solvers_available"
  ) {
    return new Error(
      `No solver is currently available for task type '${taskType}' (HTTP ${apiError.status}).`,
    );
  }

  if (apiError.status === 504 || apiError.apiError.error.type === "timeout") {
    return new Error(
      `Task '${taskType}' timed out waiting for solver completion (HTTP 504).`,
    );
  }

  return new Error(apiError.apiError.error.message);
}

function extractApiError(
  error: unknown,
): { apiError: ApiError; status: number } | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const candidate = error as Error & { apiError?: unknown; status?: unknown };
  if (!candidate.apiError || typeof candidate.status !== "number") {
    return null;
  }

  const apiError = candidate.apiError as ApiError;
  if (
    !apiError.error ||
    typeof apiError.error.type !== "string" ||
    typeof apiError.error.message !== "string"
  ) {
    return null;
  }

  return {
    apiError,
    status: candidate.status,
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === "string")
    .map(([key, entry]) => [key, entry as string]);

  return Object.fromEntries(entries);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

async function getAuthStatus(): Promise<AuthStatusResult> {
  let config: ClawrmaConfig | null;
  try {
    config = await readConfig();
  } catch (error: unknown) {
    return {
      state: "invalid_local_config",
      exitCode: 4,
      error: getErrorMessage(error),
    };
  }

  if (!config) {
    return {
      state: "not_configured",
      exitCode: 1,
    };
  }

  try {
    const balance = await getBalance(config.apiBaseUrl, config.apiKey);
    if (config.framework === "openclaw") {
      const syncError = await getOpenClawSyncError(config.apiKey);
      if (syncError) {
        return {
          state: "openclaw_sync_broken",
          exitCode: 5,
          accountId: config.accountId,
          apiKey: config.apiKey,
          apiBaseUrl: config.apiBaseUrl,
          error: syncError,
        };
      }
    }

    return {
      state: "authenticated",
      exitCode: 0,
      accountId: config.accountId,
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      balance: balance.balance,
    };
  } catch (error: unknown) {
    const apiError = extractApiError(error);
    const shared = {
      accountId: config.accountId,
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      error: getErrorMessage(error),
    };

    if (apiError && (apiError.status === 401 || apiError.status === 403)) {
      return {
        state: "auth_rejected",
        exitCode: 3,
        ...shared,
      };
    }

    return {
      state: "cannot_reach_api",
      exitCode: 2,
      ...shared,
    };
  }
}

async function getOpenClawSyncError(apiKey: string): Promise<string | null> {
  const openClawApiKey = await readOpenClawClawrmaApiKey();
  if (openClawApiKey.state === "unavailable") {
    return "Unable to read OpenClaw CLAWRMA_API_KEY from openclaw.json";
  }
  if (!openClawApiKey.apiKey || openClawApiKey.apiKey !== apiKey) {
    return "OpenClaw CLAWRMA_API_KEY is missing or does not match ~/.clawrma/config.json";
  }
  return null;
}

function printAuthStatus(status: AuthStatusResult): void {
  switch (status.state) {
    case "authenticated":
      console.log("Clawrma: authenticated");
      console.log(`  Account   ${status.accountId}`);
      console.log(`  Key       ${truncateKey(status.apiKey)}`);
      console.log(`  API       ${status.apiBaseUrl}`);
      console.log(`  Balance   ${formatPoints(status.balance)}`);
      return;
    case "not_configured":
      console.log("Clawrma: not configured");
      console.log("  Run       npx clawrma auth setup");
      return;
    case "cannot_reach_api":
      console.log("Clawrma: configured (cannot reach API)");
      console.log(`  Account   ${status.accountId}`);
      console.log(`  Key       ${truncateKey(status.apiKey)}`);
      console.log(`  API       ${status.apiBaseUrl}`);
      console.log(`  Error     ${status.error}`);
      return;
    case "auth_rejected":
      console.log("Clawrma: auth rejected");
      console.log(`  Account   ${status.accountId}`);
      console.log(`  Key       ${truncateKey(status.apiKey)}`);
      console.log(`  API       ${status.apiBaseUrl}`);
      console.log(`  Error     ${status.error}`);
      console.log("  Run       npx clawrma auth setup");
      return;
    case "invalid_local_config":
      console.log("Clawrma: invalid local config");
      console.log(`  File      ${CONFIG_PATH}`);
      console.log(`  Error     ${status.error}`);
      console.log("  Run       npx clawrma auth setup");
      return;
    case "openclaw_sync_broken":
      console.log("Clawrma: OpenClaw sync broken");
      console.log(`  Account   ${status.accountId}`);
      console.log(`  Key       ${truncateKey(status.apiKey)}`);
      console.log(`  API       ${status.apiBaseUrl}`);
      console.log(`  Error     ${status.error}`);
      console.log("  Run       npx clawrma auth setup");
      return;
  }
}

function normalizeSearchResults(
  value: unknown,
): Array<{ title: string; url: string; snippet: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => ({
      title: asString(entry.title, ""),
      url: asString(entry.url, ""),
      snippet: asString(entry.snippet, ""),
    }));
}

type OpenClawApiKeyReadResult =
  | { state: "ok"; apiKey: string | null }
  | { state: "unavailable" };

async function readOpenClawClawrmaApiKey(): Promise<OpenClawApiKeyReadResult> {
  try {
    const { readOpenClawConfig } = await import("./integrations/openclaw.js");
    const config = await readOpenClawConfig();
    if (!config) {
      return { state: "ok", apiKey: null };
    }

    const value = getNestedValue(config.raw, [
      "skills",
      "entries",
      "clawrma",
      "env",
      "CLAWRMA_API_KEY",
    ]);
    return {
      state: "ok",
      apiKey: typeof value === "string" && value.length > 0 ? value : null,
    };
  } catch {
    return { state: "unavailable" };
  }
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function maskConfigApiKey(apiKey: string): string {
  const masked = truncateKey(apiKey);
  if (masked !== apiKey) {
    return masked;
  }
  return apiKey.length === 0 ? "" : "[masked]";
}

async function loadRequiredConfig(): Promise<{
  apiBaseUrl: string;
  apiKey: string;
  promptSafetyScan?: boolean;
}> {
  const config = await loadRequiredConfigObject();
  return {
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    promptSafetyScan: config.promptSafetyScan,
  };
}

async function loadRequiredConfigObject(): Promise<ClawrmaConfig> {
  const config = await readConfig();
  if (!config) {
    throw new Error(
      `Clawrma is not configured. Run 'npx clawrma auth setup' to create ${CONFIG_PATH}. If you're not using OpenClaw, run 'npx clawrma setup --framework none --interactive' instead.`,
    );
  }

  return config;
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = await findNearestPackageJsonPath(
    fileURLToPath(import.meta.url),
  );
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("Unable to read package version from package.json.");
  }
  return parsed.version;
}

async function findNearestPackageJsonPath(
  fromFilePath: string,
): Promise<string> {
  let currentDir = dirname(fromFilePath);
  const fsRoot = parse(currentDir).root;

  while (true) {
    const candidatePath = join(currentDir, "package.json");
    try {
      await access(candidatePath);
      return candidatePath;
    } catch {
      // Continue searching parent directories.
    }

    if (currentDir === fsRoot) {
      break;
    }
    currentDir = dirname(currentDir);
  }

  throw new Error("Unable to locate package.json for version command.");
}

export function createProgram(io: CliIo = DEFAULT_CLI_IO): Command {
  const program = new Command();
  program
    .name("clawrma")
    .description(
      "Web fetch, search, screenshots, snapshots, and inference via the Clawrma solver network.\n" +
        "Tasks are routed to available solvers - no third-party API keys required.\n" +
        "Run a solver to earn credits that fund future tasks.",
    )
    .addHelpText(
      "after",
      "\nGetting started:\n" +
        "  OpenClaw users (recommended):\n" +
        "    1. npx clawrma auth setup                          Create account and sync OpenClaw\n" +
        "    2. npx clawrma auth status                         Verify authentication and key sync\n" +
        '    3. npx clawrma search "query"                      Run your first task\n' +
        "\n" +
        "  Standalone / advanced:\n" +
        "    1. npx clawrma setup --framework none --interactive\n" +
        "    2. npx clawrma auth status\n" +
        '    3. npx clawrma search "query"\n' +
        "\nTroubleshooting:\n" +
        "  Not configured?\n" +
        "    OpenClaw:        npx clawrma auth setup\n" +
        "    Standalone:      npx clawrma setup --framework none --interactive\n" +
        "  Auth failing?      npx clawrma auth status    (shows what's wrong)\n" +
        "  No solver?         Retry - solvers come online dynamically\n" +
        "  OpenClaw re-sync?  npx clawrma auth setup\n",
    );
  registerCommands(program, io);
  return program;
}

export async function runCli(
  argv: string[],
  io: CliIo = DEFAULT_CLI_IO,
  handleErrors = false,
): Promise<void> {
  const program = createProgram(io);
  if (!handleErrors) {
    await program.parseAsync(argv);
    return;
  }

  try {
    await program.parseAsync(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  if (process.platform === "win32") {
    console.error(WINDOWS_UNSUPPORTED_MESSAGE);
    process.exitCode = 1;
  }

  void runCli(process.argv, DEFAULT_CLI_IO, true);
}
