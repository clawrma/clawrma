import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  submitLiveTask,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_FIRECRAWL_SOLVER = process.env.CLAWRMA_USE_FIRECRAWL_SOLVER === "1";
const QUALITY_GATE_PASS_URL = "https://www.iana.org/domains/example";
const EXAMPLE_FETCH_HTML = `
  <html>
    <body>
      <article>
        <h1>Example Domain</h1>
        <p>
          Example Domain is used in illustrative examples in documents and tutorials.
          This integration fixture intentionally includes enough visible text to satisfy
          the API quality gate while still looking like a realistic HTML page that a
          browser-style fetch solver would return.
        </p>
        <p>
          The page explains reserved-domain usage, linked documentation, and why stable
          sample content matters for end-to-end tests that verify format-tagged fetch
          responses without depending on a live external site during local verification.
        </p>
      </article>
    </body>
  </html>
`.trim();

function extractFetchFormat(result: Record<string, unknown>): string {
  return typeof result.content_format === "string" ? result.content_format : "";
}

function extractOriginalContentType(result: Record<string, unknown>): string {
  return typeof result.original_content_type === "string"
    ? result.original_content_type
    : "";
}

describeLive("integration fetch", () => {
  it("submits proxy_fetch and receives format-tagged fetch output", async () => {
    if (USE_FIRECRAWL_SOLVER) {
      const { apiKey } = await createLiveAccount();
      const result = await submitLiveTask(apiKey, "proxy_fetch", {
        url: QUALITY_GATE_PASS_URL,
      });

      const statusCode =
        typeof result.status_code === "number"
          ? result.status_code
          : typeof result.statusCode === "number"
            ? result.statusCode
            : 0;
      expect(statusCode).toBeGreaterThanOrEqual(200);
      expect(statusCode).toBeLessThan(600);

      const body = typeof result.body === "string" ? result.body : "";
      expect(body.length).toBeGreaterThan(0);
      expect(extractFetchFormat(result)).toBe("markdown");
      return;
    }

    const observedRawHtmlFlags: boolean[] = [];
    await withLiveSolver(
      {
        capabilities: [{ taskType: "proxy_fetch" }],
        onTaskAssignment: ({ payload }) => {
          const targetUrl =
            typeof payload.url === "string"
              ? payload.url
              : "https://example.com";
          observedRawHtmlFlags.push(payload.raw_html === true);
          return {
            result: {
              url: targetUrl,
              status_code: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body: EXAMPLE_FETCH_HTML,
              content_format: "html",
              original_content_type: "text/html; charset=utf-8",
            },
          };
        },
      },
      async () => {
        const { apiKey } = await createLiveAccount();
        const result = await submitLiveTask(apiKey, "proxy_fetch", {
          url: "https://example.com",
        });

        const statusCode =
          typeof result.status_code === "number" ? result.status_code : 0;
        expect(statusCode).toBe(200);

        const body = typeof result.body === "string" ? result.body : "";
        expect(body).toContain("Example Domain");
        expect(extractFetchFormat(result)).toBe("html");
        expect(extractOriginalContentType(result)).toBe(
          "text/html; charset=utf-8",
        );

        const rawHtmlResult = await submitLiveTask(apiKey, "proxy_fetch", {
          url: "https://example.com",
          raw_html: true,
        });
        expect(typeof rawHtmlResult.body).toBe("string");
        expect(extractFetchFormat(rawHtmlResult)).toBe("html");
        expect(observedRawHtmlFlags.length).toBeGreaterThanOrEqual(2);
        expect(observedRawHtmlFlags.at(-1)).toBe(true);
        expect(observedRawHtmlFlags.slice(0, -1)).toContain(false);
        expect(observedRawHtmlFlags.slice(0, -1)).not.toContain(true);
      },
    );
  }, 20_000);
});
