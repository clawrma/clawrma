import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  submitLiveTask,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_SEARCH_SOLVER = process.env.CLAWRMA_USE_SEARCH_SOLVER === "1";

describeLive("integration search", () => {
  it("submits web_search and receives a normalized results array", async () => {
    if (USE_SEARCH_SOLVER) {
      const { apiKey } = await createLiveAccount();
      const result = await submitLiveTask(apiKey, "web_search", {
        query: "Clawrma",
        count: 3,
      });

      expect(Array.isArray(result.results)).toBe(true);
      const firstResult = result.results?.[0];
      if (firstResult) {
        expect(typeof firstResult.title).toBe("string");
        expect(typeof firstResult.url).toBe("string");
        expect(typeof firstResult.snippet).toBe("string");
      }
      return;
    }

    await withLiveSolver(
      {
        capabilities: [{ taskType: "web_search", minPricePoints: 0 }],
        onTaskAssignment: ({ payload }) => {
          const query =
            typeof payload.query === "string" ? payload.query : "clawrma";
          return {
            result: {
              query,
              results: [
                {
                  title: "Clawrma",
                  url: "https://example.com/clawrma",
                  snippet: "Clawrma integration test result",
                },
              ],
            },
          };
        },
      },
      async () => {
        const { apiKey } = await createLiveAccount();
        const result = await submitLiveTask(apiKey, "web_search", {
          query: "Clawrma",
          count: 3,
        });

        expect(Array.isArray(result.results)).toBe(true);
        const firstResult = result.results?.[0];
        if (firstResult) {
          expect(typeof firstResult.title).toBe("string");
          expect(typeof firstResult.url).toBe("string");
          expect(typeof firstResult.snippet).toBe("string");
          expect(firstResult.title).toContain("Clawrma");
        }
      },
    );
  });
});
