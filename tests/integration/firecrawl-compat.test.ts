import { describe, expect, it } from "vitest";
import { isRecord } from "../../src/guards.js";
import {
  CAN_RUN_LIVE_INTEGRATION,
  LIVE_API_BASE_URL,
  createLiveAccount,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_FIRECRAWL_SOLVER = process.env.CLAWRMA_USE_FIRECRAWL_SOLVER === "1";
const QUALITY_GATE_PASS_URL = "https://www.iana.org/domains/example";
const EXAMPLE_MARKDOWN = `
# Example Domain

Example Domain is reserved for use in documentation and integration tests. This
fixture intentionally includes enough readable text to satisfy the API quality
gate while still looking like a realistic markdown payload from a browser fetch
solver. It mentions stable sample content, external documentation, and the
reason end-to-end tests should avoid tiny placeholder pages when quality
validation requires substantive visible text.
`.trim();

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("Expected JSON object response.");
  }
  return payload;
}

describeLive("integration firecrawl compat", () => {
  it("returns Firecrawl-compatible success shape", async () => {
    const assertSuccessShape = async (apiKey: string): Promise<void> => {
      const response = await fetch(
        `${LIVE_API_BASE_URL}/v1/compat/firecrawl/scrape`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url: QUALITY_GATE_PASS_URL,
            formats: ["markdown"],
          }),
        },
      );

      expect(response.status).toBe(200);
      const payload = await readJsonObject(response);
      expect(payload.success).toBe(true);

      const data = isRecord(payload.data) ? payload.data : null;
      expect(data).not.toBeNull();
      expect(typeof data?.markdown).toBe("string");
      expect(String(data?.markdown).length).toBeGreaterThan(0);

      const metadata = isRecord(data?.metadata) ? data.metadata : null;
      expect(metadata).not.toBeNull();
      expect(typeof metadata?.sourceURL).toBe("string");
      expect(metadata?.statusCode).toBe(200);
    };

    if (USE_FIRECRAWL_SOLVER) {
      const { apiKey } = await createLiveAccount();
      await assertSuccessShape(apiKey);
      return;
    }

    await withLiveSolver(
      {
        capabilities: [{ taskType: "proxy_fetch", minPricePoints: 0 }],
        onTaskAssignment: ({ payload }) => {
          const targetUrl =
            typeof payload.url === "string"
              ? payload.url
              : QUALITY_GATE_PASS_URL;
          return {
            result: {
              body: EXAMPLE_MARKDOWN,
              content_format: "markdown",
              sourceURL: targetUrl,
              status_code: 200,
              title: "Example Domain",
            },
          };
        },
      },
      async () => {
        const { apiKey } = await createLiveAccount();
        await assertSuccessShape(apiKey);
      },
    );
  });

  it("returns Firecrawl-compatible error shape for unsupported format", async () => {
    const { apiKey } = await createLiveAccount();
    const response = await fetch(
      `${LIVE_API_BASE_URL}/v1/compat/firecrawl/scrape`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com", formats: ["html"] }),
      },
    );

    expect(response.status).toBe(400);
    const payload = await readJsonObject(response);
    expect(payload.success).toBe(false);
    expect(typeof payload.error).toBe("string");
  });
});
