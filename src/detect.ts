import { execFile } from "node:child_process";
import { isRecord } from "./guards.js";
import {
  readOpenClawConfig,
  type OpenClawProviderConfig,
} from "./integrations/openclaw.js";
import { listConfiguredBuiltInSearchProviders } from "./search/builtins.js";
import type {
  BillingType,
  DetectionResult,
  DetectedProvider,
  FrameworkType,
  FulfillmentPath,
} from "./types.js";

const PLAYWRIGHT_TIMEOUT_MS = 2_000;
const CLI_TIMEOUT_MS = 2_000;
const LOCAL_MODEL_TIMEOUT_MS = 2_000;

interface ProviderClassificationInput {
  name: string;
  endpoint?: string;
  apiKey?: string;
  token?: string;
}

interface CliAvailability {
  claudeAvailable: boolean;
  codexAvailable: boolean;
}

interface LocalProviderProbe {
  name: string;
  endpoint: string;
}

export async function detectCapabilities(
  framework: FrameworkType,
  options: { includeNotificationChannels?: boolean } = {},
): Promise<DetectionResult> {
  if (framework === "none") {
    const [browserAvailable, localProviders] = await Promise.all([
      detectPlaywrightAvailability(),
      detectLocalProviders(),
    ]);

    return {
      providers: localProviders,
      browserAvailable,
      notificationChannels: [],
      activeHours: null,
      existingSearchConfig: listConfiguredBuiltInSearchProviders().length > 0,
      existingFirecrawlConfig: false,
    };
  }

  const [
    openClawConfig,
    browserAvailable,
    cliAvailability,
    notificationChannels,
  ] = await Promise.all([
    readOpenClawConfig(),
    detectPlaywrightAvailability(),
    detectCliAvailability(),
    options.includeNotificationChannels === false
      ? Promise.resolve<string[]>([])
      : detectNotificationChannels(),
  ]);

  const providers = (openClawConfig?.providers ?? []).map((provider) =>
    classifyProvider(provider, cliAvailability),
  );

  return {
    providers,
    browserAvailable,
    notificationChannels,
    activeHours: openClawConfig?.activeHours ?? null,
    existingSearchConfig:
      openClawConfig?.existingSearchConfig ??
      listConfiguredBuiltInSearchProviders().length > 0,
    existingFirecrawlConfig: openClawConfig?.existingFirecrawlConfig ?? false,
  };
}

export function classifyBillingType(
  provider: ProviderClassificationInput,
): BillingType {
  const name = provider.name.toLowerCase();
  const endpoint = (provider.endpoint ?? "").toLowerCase();
  const token = provider.token ?? provider.apiKey ?? "";

  if (isLocalEndpoint(endpoint)) {
    return "local";
  }

  if (isFreeTierProvider(name, token)) {
    return "free_tier";
  }

  if (isPerTokenApiKey(token)) {
    return "per_token";
  }

  if (isSubscriptionProvider(name, token)) {
    return "subscription";
  }

  return "per_token";
}

export function classifyFulfillmentPath(
  provider: ProviderClassificationInput,
  cliAvailability: CliAvailability,
): FulfillmentPath {
  const billingType = classifyBillingType(provider);
  if (billingType !== "subscription") {
    return "api";
  }

  const name = provider.name.toLowerCase();
  if (name.includes("codex") || name.includes("openai-codex")) {
    return cliAvailability.codexAvailable ? "cli_codex" : "api";
  }

  if (name.includes("claude") || name.includes("anthropic")) {
    return cliAvailability.claudeAvailable ? "cli" : "api";
  }

  if (cliAvailability.claudeAvailable) {
    return "cli";
  }

  if (cliAvailability.codexAvailable) {
    return "cli_codex";
  }

  return "api";
}

function classifyProvider(
  provider: OpenClawProviderConfig,
  cliAvailability: CliAvailability,
): DetectedProvider {
  const providerInfo: ProviderClassificationInput = {
    name: provider.name,
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    token: provider.token,
  };

  return {
    name: provider.name,
    modelName: provider.modelName.trim(),
    endpoint: provider.endpoint,
    billingType: classifyBillingType(providerInfo),
    fulfillmentPath: classifyFulfillmentPath(providerInfo, cliAvailability),
  };
}

async function detectCliAvailability(): Promise<CliAvailability> {
  const [claudeAvailable, codexAvailable] = await Promise.all([
    commandAvailable("claude", ["--version"], CLI_TIMEOUT_MS),
    commandAvailable("codex", ["--version"], CLI_TIMEOUT_MS),
  ]);

  return { claudeAvailable, codexAvailable };
}

async function detectPlaywrightAvailability(): Promise<boolean> {
  return commandAvailable(
    "npx",
    ["playwright", "--version"],
    PLAYWRIGHT_TIMEOUT_MS,
  );
}

async function detectNotificationChannels(): Promise<string[]> {
  try {
    const { stdout } = await runCommand(
      "openclaw",
      ["channels", "list", "--json"],
      CLI_TIMEOUT_MS,
    );
    if (!stdout.trim()) {
      return [];
    }

    const parsed = JSON.parse(stdout) as unknown;
    return extractChannelNames(parsed);
  } catch {
    return [];
  }
}

function extractChannelNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (isRecord(entry)) {
          const name = pickFirstString(entry, ["name", "channel", "id"]);
          return name;
        }
        return "";
      })
      .filter((entry) => entry.length > 0);
  }

  if (isRecord(value)) {
    const nested = value.channels;
    if (nested) {
      return extractChannelNames(nested);
    }
  }

  return [];
}

async function detectLocalProviders(): Promise<DetectedProvider[]> {
  const probes: LocalProviderProbe[] = [
    { name: "ollama", endpoint: "http://localhost:11434/api/tags" },
    { name: "lm-studio", endpoint: "http://localhost:1234/v1/models" },
  ];

  const results = await Promise.all(
    probes.map((probe) => probeLocalEndpoint(probe.endpoint)),
  );

  return probes
    .filter((_, index) => results[index])
    .map((probe) => ({
      name: probe.name,
      modelName: "",
      endpoint: probe.endpoint,
      billingType: "local" as const,
      fulfillmentPath: "api" as const,
    }));
}

async function probeLocalEndpoint(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    LOCAL_MODEL_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isLocalEndpoint(endpoint: string): boolean {
  return (
    endpoint.includes("localhost:11434") ||
    endpoint.includes("localhost:1234") ||
    endpoint.includes("127.0.0.1")
  );
}

function isFreeTierProvider(name: string, token: string): boolean {
  const lowerToken = token.toLowerCase();
  return (
    (name.includes("gemini") || name.includes("google")) &&
    lowerToken.startsWith("aiza")
  );
}

function isPerTokenApiKey(token: string): boolean {
  const lowerToken = token.toLowerCase();
  if (
    lowerToken.startsWith("sk-sess-") ||
    lowerToken.startsWith("sk_session_")
  ) {
    return false;
  }

  return (
    lowerToken.startsWith("sk-ant-") ||
    lowerToken.startsWith("sk-or-") ||
    lowerToken.startsWith("sk-proj-") ||
    lowerToken.startsWith("sk-")
  );
}

function isSubscriptionProvider(name: string, token: string): boolean {
  const lowerToken = token.toLowerCase();
  if (
    lowerToken.startsWith("oauth") ||
    lowerToken.includes("max") ||
    lowerToken.startsWith("session-") ||
    lowerToken.startsWith("sk-sess-") ||
    lowerToken.startsWith("sk_session_")
  ) {
    return true;
  }

  return (
    name.includes("claude") ||
    name.includes("anthropic") ||
    name.includes("chatgpt") ||
    name.includes("codex")
  );
}

function pickFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "";
}

async function commandAvailable(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<boolean> {
  try {
    await runCommand(command, args, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
