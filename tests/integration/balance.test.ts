import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  getLiveBalanceValue,
  submitLiveTask,
  waitForBalanceDrop,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const PROXY_FETCH_PRICE_POINTS = 1.2;
const QUALITY_GATE_PASS_URL = "https://www.iana.org/domains/example";
const EXAMPLE_FETCH_HTML = `
  <html>
    <body>
      <article>
        <h1>Balance Integration Fixture</h1>
        <p>
          This HTML payload is intentionally long enough to pass the API quality
          gate so the balance test can observe a successful task settlement
          instead of an early empty-content rejection.
        </p>
        <p>
          The text stays deterministic and local to the test harness, which
          keeps the balance delta assertion stable while still exercising the
          real requester debit and solver credit path.
        </p>
      </article>
    </body>
  </html>
`.trim();

describeLive("integration balance", () => {
  it("deducts settled task price from requester balance", async () => {
    await withLiveSolver(
      {
        capabilities: [{ taskType: "proxy_fetch" }],
        onTaskAssignment: ({ payload }) => {
          const targetUrl =
            typeof payload.url === "string"
              ? payload.url
              : "https://example.com";
          return {
            result: {
              url: targetUrl,
              status_code: 200,
              body: EXAMPLE_FETCH_HTML,
              content_format: "html",
              original_content_type: "text/html; charset=utf-8",
            },
          };
        },
      },
      async () => {
        const { apiKey } = await createLiveAccount();
        const openingBalance = await getLiveBalanceValue(apiKey);

        await submitLiveTask(apiKey, "proxy_fetch", {
          url: QUALITY_GATE_PASS_URL,
        });

        const settledBalance = await waitForBalanceDrop(
          apiKey,
          openingBalance,
          PROXY_FETCH_PRICE_POINTS,
          { timeoutMs: 10_000, intervalMs: 250 },
        );

        const delta = openingBalance - settledBalance;
        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeCloseTo(PROXY_FETCH_PRICE_POINTS, 6);
      },
    );
  }, 20_000);
});
