import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  submitLiveTask,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_FIRECRAWL_SOLVER = process.env.CLAWRMA_USE_FIRECRAWL_SOLVER === "1";
const LIVE_SNAPSHOT_TEST_TIMEOUT_MS = 20_000;
const QUALITY_GATE_PASS_URL = "https://www.iana.org/domains/example";
const EXAMPLE_SNAPSHOT_TEXT =
  "Example Domain is used for illustrative examples in documentation and testing. " +
  "This fixture includes enough readable text to satisfy the API quality gate while " +
  "keeping the snapshot contract honest about returning an aria-style object payload. " +
  "It also mentions the example link target and the surrounding explanatory copy that " +
  "a structured snapshot producer might expose alongside role and heading data.";

function assertTaggedSnapshot(result: Record<string, unknown>): void {
  expect(typeof result.snapshot_format).toBe("string");

  if (result.snapshot_format === "markdown") {
    expect(typeof result.snapshot).toBe("string");
    return;
  }

  if (result.snapshot_format === "aria" || result.snapshot_format === "role") {
    expect(result.snapshot).toBeTypeOf("object");
    expect(result.snapshot).not.toBeNull();
    return;
  }

  if (result.snapshot_format === "ai") {
    expect(["string", "object"]).toContain(typeof result.snapshot);
    expect(result.snapshot).not.toBeUndefined();
    return;
  }

  throw new Error(
    `Unexpected snapshot_format: ${String(result.snapshot_format)}`,
  );
}

describeLive("integration snapshot", () => {
  it(
    "submits page_snapshot and receives a tagged snapshot payload",
    async () => {
      if (USE_FIRECRAWL_SOLVER) {
        const { apiKey } = await createLiveAccount();
        const result = await submitLiveTask(apiKey, "page_snapshot", {
          url: QUALITY_GATE_PASS_URL,
        });

        assertTaggedSnapshot(result as Record<string, unknown>);
        expect(result.snapshot_format).toBe("markdown");
        expect(typeof result.title).toBe("string");
        const snapshot =
          typeof result.snapshot === "string" ? result.snapshot : "";
        expect(snapshot.length).toBeGreaterThan(0);
        return;
      }

      await withLiveSolver(
        {
          capabilities: [{ taskType: "page_snapshot" }],
          onTaskAssignment: ({ payload }) => {
            const targetUrl =
              typeof payload.url === "string"
                ? payload.url
                : "https://example.com";
            return {
              result: {
                snapshot: {
                  headings: ["Example Domain"],
                  text: EXAMPLE_SNAPSHOT_TEXT,
                  links: [{ href: "https://www.iana.org/domains/example" }],
                },
                snapshot_format: "aria",
                text: EXAMPLE_SNAPSHOT_TEXT,
                title: "Example Domain",
                url: targetUrl,
              },
            };
          },
        },
        async () => {
          const { apiKey } = await createLiveAccount();
          const result = await submitLiveTask(apiKey, "page_snapshot", {
            url: "https://example.com",
          });

          assertTaggedSnapshot(result as Record<string, unknown>);
          expect(result.snapshot_format).toBe("aria");
          expect(typeof result.title).toBe("string");
          expect(result.title).toContain("Example Domain");
          expect(result.snapshot).toBeDefined();

          if (result.snapshot && typeof result.snapshot === "object") {
            const maybeSnapshot = result.snapshot as {
              text?: unknown;
              headings?: unknown;
            };
            expect(typeof maybeSnapshot.text).toBe("string");
            expect(Array.isArray(maybeSnapshot.headings)).toBe(true);
          }
        },
      );
    },
    LIVE_SNAPSHOT_TEST_TIMEOUT_MS,
  );
});
