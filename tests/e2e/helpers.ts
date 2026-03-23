import { DEFAULT_API_BASE_URL } from "../../src/constants.js";
import { isRecord } from "../../src/guards.js";

export const LIVE_API_BASE_URL =
  process.env.CLAWRMA_LIVE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
export const RUN_LIVE_INTEGRATION =
  process.env.CLAWRMA_RUN_LIVE_INTEGRATION === "1";

export function authHeader(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

export function solverWebSocketUrl(
  apiBaseUrl: string = LIVE_API_BASE_URL,
  queryApiKey?: string,
): string {
  const baseUrl = new URL(apiBaseUrl);
  const protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL(`${protocol}//${baseUrl.host}/v1/solver/connect`);
  if (queryApiKey) {
    wsUrl.searchParams.set("api_key", queryApiKey);
  }
  return wsUrl.toString();
}

export async function expectJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Expected JSON response but received non-JSON payload (status=${response.status}): ${rawText}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Expected JSON object response but got ${typeof parsed} (status=${response.status})`,
    );
  }
  return parsed;
}

export async function createLiveAccount(): Promise<{
  accountId: string;
  apiKey: string;
}> {
  const response = await fetch(`${LIVE_API_BASE_URL}/v1/register`, {
    method: "POST",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Register failed with status ${response.status}: ${body || "<empty body>"}`,
    );
  }

  const payload = await expectJsonObject(response);
  const accountId = payload.account_id;
  const apiKey = payload.api_key;
  if (typeof accountId !== "string" || typeof apiKey !== "string") {
    throw new Error("Register response missing account_id or api_key.");
  }
  return { accountId, apiKey };
}
