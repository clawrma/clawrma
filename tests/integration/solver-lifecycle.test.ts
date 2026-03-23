import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  isNoSolverAvailableError,
  submitLiveTask,
  type LiveSolverController,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_FIRECRAWL_SOLVER = process.env.CLAWRMA_USE_FIRECRAWL_SOLVER === "1";
const QUALITY_GATE_PASS_URL = "https://www.iana.org/domains/example";
const EXAMPLE_FETCH_HTML = `
  <html>
    <body>
      <article>
        <h1>Lifecycle Integration Fixture</h1>
        <p>
          This fixture includes enough readable content to satisfy the API
          quality gate while keeping the solver lifecycle test focused on pause,
          resume, disconnect, and reconnect behavior.
        </p>
        <p>
          It intentionally uses stable prose instead of a tiny placeholder so
          task completion succeeds consistently before the assignment flow is
          exercised across multiple websocket state transitions.
        </p>
      </article>
    </body>
  </html>
`.trim();

async function expectNoSolverAvailable(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
    throw new Error(
      "Expected no_solvers_available failure but operation succeeded.",
    );
  } catch (error: unknown) {
    if (!isNoSolverAvailableError(error)) {
      throw error;
    }
  }
}

async function waitForLifecycleSolverAssignment(
  solver: LiveSolverController,
  apiKey: string,
  minimumAssignments: number,
): Promise<Record<string, unknown>> {
  let lastResult: Record<string, unknown> | null = null;
  const maxAttempts = 12;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await submitLiveTask(apiKey, "proxy_fetch", {
      url: QUALITY_GATE_PASS_URL,
    });
    lastResult = result as Record<string, unknown>;
    if (solver.assignmentCount() > minimumAssignments) {
      return lastResult;
    }
  }

  throw new Error(
    "Expected lifecycle solver to receive another assignment, but another eligible " +
      "advertised solver kept winning the randomized proxy_fetch match. " +
      `Last result format: ${String(lastResult?.content_format)}`,
  );
}

describeLive("integration solver lifecycle", () => {
  it("supports pause/resume and disconnect/reconnect assignment behavior", async () => {
    await withLiveSolver(
      {
        capabilities: [{ taskType: "proxy_fetch", minPricePoints: 0 }],
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
      async (solver) => {
        const initialRequester = await createLiveAccount();
        const pausedRequester = await createLiveAccount();
        const resumedRequester = await createLiveAccount();
        const disconnectedRequester = await createLiveAccount();
        const reconnectedRequester = await createLiveAccount();

        const initialResult = USE_FIRECRAWL_SOLVER
          ? await waitForLifecycleSolverAssignment(
              solver,
              initialRequester.apiKey,
              0,
            )
          : await submitLiveTask(initialRequester.apiKey, "proxy_fetch", {
              url: QUALITY_GATE_PASS_URL,
            });
        expect(typeof initialResult.body).toBe("string");
        expect(initialResult.content_format).toBe("html");

        await solver.pause("integration-test-pause");
        const assignmentsWhileActive = solver.assignmentCount();
        if (USE_FIRECRAWL_SOLVER) {
          const pausedResult = await submitLiveTask(
            pausedRequester.apiKey,
            "proxy_fetch",
            { url: QUALITY_GATE_PASS_URL },
            { attempts: 1 },
          );
          expect(typeof pausedResult.body).toBe("string");
          expect(pausedResult.content_format).toBe("markdown");
          expect(solver.assignmentCount()).toBe(assignmentsWhileActive);
        } else {
          await expectNoSolverAvailable(() =>
            submitLiveTask(
              pausedRequester.apiKey,
              "proxy_fetch",
              { url: QUALITY_GATE_PASS_URL },
              { attempts: 1 },
            ),
          );
        }

        await solver.resume();
        const resumedResult = USE_FIRECRAWL_SOLVER
          ? await waitForLifecycleSolverAssignment(
              solver,
              resumedRequester.apiKey,
              assignmentsWhileActive,
            )
          : await submitLiveTask(resumedRequester.apiKey, "proxy_fetch", {
              url: QUALITY_GATE_PASS_URL,
            });
        expect(typeof resumedResult.body).toBe("string");
        expect(resumedResult.content_format).toBe("html");

        await solver.disconnect();
        const assignmentsWhileConnected = solver.assignmentCount();
        if (USE_FIRECRAWL_SOLVER) {
          const disconnectedResult = await submitLiveTask(
            disconnectedRequester.apiKey,
            "proxy_fetch",
            { url: QUALITY_GATE_PASS_URL },
            { attempts: 1 },
          );
          expect(typeof disconnectedResult.body).toBe("string");
          expect(disconnectedResult.content_format).toBe("markdown");
          expect(solver.assignmentCount()).toBe(assignmentsWhileConnected);
        } else {
          await expectNoSolverAvailable(() =>
            submitLiveTask(
              disconnectedRequester.apiKey,
              "proxy_fetch",
              { url: QUALITY_GATE_PASS_URL },
              { attempts: 1 },
            ),
          );
        }

        await solver.reconnect();
        const reconnectedResult = USE_FIRECRAWL_SOLVER
          ? await waitForLifecycleSolverAssignment(
              solver,
              reconnectedRequester.apiKey,
              assignmentsWhileConnected,
            )
          : await submitLiveTask(reconnectedRequester.apiKey, "proxy_fetch", {
              url: QUALITY_GATE_PASS_URL,
            });
        expect(typeof reconnectedResult.body).toBe("string");
        expect(reconnectedResult.content_format).toBe("html");

        expect(solver.assignmentCount()).toBeGreaterThanOrEqual(3);
      },
    );
  }, 30_000);
});
