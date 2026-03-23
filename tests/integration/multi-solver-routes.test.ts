import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  LIVE_API_BASE_URL,
  createLiveAccount,
  retryWithBackoff,
  submitLiveTask,
} from "./helpers.js";

const RUN_MULTI_SOLVER_ROUTES =
  process.env.CLAWRMA_RUN_MULTI_SOLVER_ROUTES === "1";
const describeLive =
  CAN_RUN_LIVE_INTEGRATION && RUN_MULTI_SOLVER_ROUTES
    ? describe
    : describe.skip;

function extractFetchStatusCode(result: Record<string, unknown>): number {
  if (typeof result.status_code === "number") {
    return result.status_code;
  }
  if (typeof result.statusCode === "number") {
    return result.statusCode;
  }
  return 0;
}

function extractFetchBody(result: Record<string, unknown>): string {
  return typeof result.body === "string" ? result.body : "";
}

function extractFetchFormat(result: Record<string, unknown>): string {
  return typeof result.content_format === "string" ? result.content_format : "";
}

function extractSnapshotContent(result: Record<string, unknown>): string {
  if (typeof result.snapshot === "string") {
    return result.snapshot;
  }
  return "";
}

function normalizeBase64(value: string): string {
  const marker = "base64,";
  const markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) {
    return value.slice(markerIndex + marker.length).trim();
  }
  return value.trim();
}

describeLive("integration multi-solver routes", () => {
  it("validates web_search, proxy_fetch, screenshot, page_snapshot, llm_inference end-to-end", async () => {
    const { apiKey } = await createLiveAccount();

    const searchResult = await submitLiveTask(apiKey, "web_search", {
      query: "Clawrma OpenAI",
      count: 3,
    });
    expect(Array.isArray(searchResult.results)).toBe(true);

    const fetchResult = await submitLiveTask(apiKey, "proxy_fetch", {
      url: "https://example.com",
    });
    const fetchStatusCode = extractFetchStatusCode(fetchResult);
    expect(fetchStatusCode).toBeGreaterThanOrEqual(200);
    expect(fetchStatusCode).toBeLessThan(600);
    expect(extractFetchBody(fetchResult).length).toBeGreaterThan(0);
    expect(["html", "markdown", "text"]).toContain(
      extractFetchFormat(fetchResult),
    );

    const screenshotResult = await submitLiveTask(apiKey, "screenshot", {
      url: "https://example.com",
      viewport: { width: 1280, height: 720 },
      full_page: false,
      format: "png",
    });
    const rawImage =
      typeof screenshotResult.image_base64 === "string"
        ? screenshotResult.image_base64
        : "";
    const imageBytes = Buffer.from(normalizeBase64(rawImage), "base64");
    expect(imageBytes.byteLength).toBeGreaterThan(0);

    const snapshotResult = await submitLiveTask(apiKey, "page_snapshot", {
      url: "https://example.com",
    });
    expect(typeof snapshotResult.title).toBe("string");
    expect(extractSnapshotContent(snapshotResult).length).toBeGreaterThan(0);

    const inferencePayload = await retryWithBackoff(
      "multi_solver_llm_inference",
      async () => {
        const response = await fetch(
          `${LIVE_API_BASE_URL}/v1/inference/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "clawrma/strong",
              stream: false,
              messages: [
                { role: "user", content: "Reply with one short sentence." },
              ],
            }),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Inference request failed with status ${response.status}: ${body || "<empty body>"}`,
          );
        }

        return (await response.json()) as Record<string, unknown>;
      },
    );

    expect(inferencePayload.object).toBe("chat.completion");
    expect(inferencePayload.model).toBe("clawrma/strong");
    expect(Array.isArray(inferencePayload.choices)).toBe(true);
    const choices = inferencePayload.choices;
    if (Array.isArray(choices)) {
      expect(choices.length).toBeGreaterThan(0);
    }
  }, 180_000);
});
