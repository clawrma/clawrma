#!/usr/bin/env node

import process from "node:process";
import { startSolver } from "../dist/src/solver.js";

const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseBooleanEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    return defaultValue;
  }
  return BOOLEAN_TRUE_VALUES.has(value.trim().toLowerCase());
}

function parseIntegerEnv(name, defaultValue) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Environment variable ${name} must be a positive integer; received '${value}'.`,
    );
  }
  return parsed;
}

function buildConfig(capability) {
  const accountId =
    process.env.CLAWRMA_ACCOUNT_ID?.trim() ||
    `acct_${capability.provider_name}`;
  const workspaceRoot =
    process.env.CLAWRMA_SOLVER_WORKSPACE_ROOT?.trim() || undefined;
  const retainFailedWorkspaces = parseBooleanEnv(
    "CLAWRMA_SOLVER_RETAIN_FAILED_WORKSPACES",
    false,
  );

  return {
    version: 1,
    accountId,
    apiKey: requireEnv("CLAWRMA_API_KEY"),
    apiBaseUrl: requireEnv("CLAWRMA_API_BASE_URL"),
    framework: "none",
    solver: {
      enabled: true,
      schedule: {
        preset: "idle-always",
        source: "manual",
        timezone: "UTC",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "00:00",
            end: "00:00",
          },
        ],
      },
      taskTypes: ["llm_inference"],
      excludedBillingTypes: [],
      domainPolicy: "allowlist",
      ...(workspaceRoot || retainFailedWorkspaces
        ? {
            cliSandbox: {
              ...(workspaceRoot ? { workspaceRoot } : {}),
              ...(retainFailedWorkspaces
                ? { retainFailedWorkspaces: true }
                : {}),
            },
          }
        : {}),
    },
    inference: {
      maxSpendPerRequest: null,
    },
    promptSafetyScan: true,
    webFetchFallback: {
      injected: false,
      method: "none",
    },
    notifications: {
      channel: null,
      target: "",
      earningsThreshold: 0,
      dailySummary: false,
    },
    welcomeCredit: 0,
    installedAt: new Date().toISOString(),
  };
}

function buildCapability() {
  const billingType =
    process.env.CLAWRMA_SOLVER_BILLING_TYPE?.trim() || "subscription";
  const fulfillmentPath = requireEnv("CLAWRMA_SOLVER_FULFILLMENT_PATH");

  return {
    task_type: "llm_inference",
    billing_type: billingType,
    fulfillment_path: fulfillmentPath,
    provider_name: requireEnv("CLAWRMA_SOLVER_PROVIDER_NAME"),
    model_name: requireEnv("CLAWRMA_SOLVER_MODEL_NAME"),
  };
}

function buildDetectionResult(capability) {
  return {
    providers: [
      {
        name: capability.provider_name,
        modelName: capability.model_name,
        endpoint: "https://example.invalid",
        billingType: capability.billing_type,
        fulfillmentPath: capability.fulfillment_path,
      },
    ],
    browserAvailable: false,
    notificationChannels: [],
    activeHours: null,
    existingSearchConfig: false,
    existingFirecrawlConfig: false,
  };
}

async function waitForTermination(handle) {
  await new Promise((resolve, reject) => {
    let stopping = false;

    const stop = async (signal) => {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        console.log(`Received ${signal}. Stopping test solver runtime...`);
        await handle.stop();
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    process.once("SIGINT", () => {
      void stop("SIGINT");
    });
    process.once("SIGTERM", () => {
      void stop("SIGTERM");
    });
  });
}

async function main() {
  const capability = buildCapability();
  const config = buildConfig(capability);
  const detection = buildDetectionResult(capability);
  const maxConcurrent = parseIntegerEnv("CLAWRMA_SOLVER_MAX_CONCURRENT", 1);

  if (process.argv.includes("--print-config")) {
    console.log(
      JSON.stringify(
        {
          config,
          capability: {
            ...capability,
            max_concurrent: maxConcurrent,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  const handle = await startSolver(config, {
    configLoader: async () => config,
    detectCapabilitiesImpl: async () => detection,
    resolvedCapabilities: [capability],
  });

  console.log(
    `Clawrma test solver started for ${capability.provider_name}/${capability.model_name}/${capability.fulfillment_path}.`,
  );
  console.log(
    `Connected to ${config.apiBaseUrl} with max concurrency ${maxConcurrent}. Press Ctrl+C to stop.`,
  );

  await waitForTermination(handle);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
