import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  LIVE_API_BASE_URL,
  createLiveAccount,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;

describeLive("integration inference cli_codex", () => {
  it("routes llm_inference tasks to cli_codex solver capabilities", async () => {
    await withLiveSolver(
      {
        capabilities: [
          {
            taskType: "llm_inference",
            fulfillmentPath: "cli_codex",
            providerName: "openai-codex",
            modelName: "gpt-5.2-codex",
            minPricePoints: 0,
          },
        ],
        onTaskAssignment: () => ({
          result: { output: { text: "integration-cli-codex" } },
        }),
      },
      async (solver) => {
        const { apiKey } = await createLiveAccount();
        const response = await fetch(
          `${LIVE_API_BASE_URL}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "clawrma/strong",
              stream: false,
              messages: [{ role: "user", content: "Say hello" }],
            }),
          },
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as Record<string, unknown>;
        expect(payload.object).toBe("chat.completion");
        expect(payload.model).toBe("clawrma/strong");
        expect(Array.isArray(payload.choices)).toBe(true);
        expect(solver.assignmentCount()).toBeGreaterThanOrEqual(1);
      },
    );
  });
});
