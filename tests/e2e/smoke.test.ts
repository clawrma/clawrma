import WebSocket, { type ClientOptions } from "ws";
import { describe, expect, it } from "vitest";
import {
  LIVE_API_BASE_URL,
  RUN_LIVE_INTEGRATION,
  authHeader,
  createLiveAccount,
  expectJsonObject,
  solverWebSocketUrl,
} from "./helpers.js";

const describeLive = RUN_LIVE_INTEGRATION ? describe : describe.skip;
const EXPECT_NO_SOLVER_SMOKE_ASSERTION =
  process.env.CLAWRMA_EXPECT_NO_SOLVER !== "0";
const itNoSolver = EXPECT_NO_SOLVER_SMOKE_ASSERTION ? it : it.skip;

interface WsAttemptResult {
  opened: boolean;
  closeCode: number | null;
  unexpectedStatus: number | null;
  timedOut: boolean;
}

async function attemptWebSocketConnection(
  url: string,
  options: ClientOptions,
  closeOnOpen: boolean,
): Promise<WsAttemptResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    let opened = false;
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.terminate();
      resolve({
        opened,
        closeCode: null,
        unexpectedStatus: null,
        timedOut: true,
      });
    }, 7000);

    const finish = (result: WsAttemptResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    socket.once("open", () => {
      opened = true;
      if (closeOnOpen) {
        socket.close();
      }
    });
    socket.once("close", (code) => {
      finish({
        opened,
        closeCode: code,
        unexpectedStatus: null,
        timedOut: false,
      });
    });
    socket.once("unexpected-response", (_request, response) => {
      finish({
        opened: false,
        closeCode: null,
        unexpectedStatus: response.statusCode ?? null,
        timedOut: false,
      });
    });
    socket.once("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

describeLive("e2e smoke", () => {
  it("CORS preflight OPTIONS returns allow-origin headers", async () => {
    const response = await fetch(`${LIVE_API_BASE_URL}/v1/fetch`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "Authorization, Content-Type, X-Clawrma-Trust-Mode",
      },
    });

    expect([200, 204]).toContain(response.status);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(
      response.headers.get("access-control-allow-methods") ?? "",
    ).toContain("POST");
    expect(
      response.headers.get("access-control-allow-headers") ?? "",
    ).toContain("Authorization");
    expect(
      response.headers.get("access-control-allow-headers") ?? "",
    ).toContain("X-Clawrma-Trust-Mode");
  });

  it("GET /health returns HTTP 200", async () => {
    const response = await fetch(`${LIVE_API_BASE_URL}/health`, {
      method: "GET",
    });
    expect(response.status).toBe(200);
    const payload = await expectJsonObject(response);
    expect(payload.status).toBe("ok");
  });

  it("POST /v1/register returns credentials and new balance is 200.00 points", async () => {
    const { apiKey } = await createLiveAccount();
    const response = await fetch(`${LIVE_API_BASE_URL}/v1/balance`, {
      method: "GET",
      headers: authHeader(apiKey),
    });

    expect(response.status).toBe(200);
    const payload = await expectJsonObject(response);
    expect(typeof payload.available).toBe("string");
    const available = Number.parseFloat(String(payload.available));
    expect(available).toBeCloseTo(200.0, 6);
  });

  itNoSolver(
    "convenience endpoints return structured 503 errors when solver is unavailable",
    async () => {
      const { apiKey } = await createLiveAccount();
      const tests: Array<{ path: string; body: Record<string, unknown> }> = [
        { path: "/v1/fetch", body: { url: "https://example.com" } },
        {
          path: "/v1/screenshot",
          body: {
            url: "https://example.com",
            viewport_width: 1280,
            viewport_height: 720,
            full_page: false,
          },
        },
        { path: "/v1/snapshot", body: { url: "https://example.com" } },
        { path: "/v1/search", body: { query: "clawrma", count: 3 } },
      ];

      for (const testCase of tests) {
        const response = await fetch(`${LIVE_API_BASE_URL}${testCase.path}`, {
          method: "POST",
          headers: {
            ...authHeader(apiKey),
            "content-type": "application/json",
          },
          body: JSON.stringify(testCase.body),
        });

        expect(response.status).toBe(503);
        const payload = await expectJsonObject(response);
        expect(typeof payload.detail).toBe("string");
        expect(payload.detail).toBe("no_solvers_available");
      }
    },
  );

  it("solver websocket accepts Bearer auth and rejects query-string api_key auth", async () => {
    const { apiKey } = await createLiveAccount();
    const tlsOptions: ClientOptions = { rejectUnauthorized: false };

    const positiveResult = await attemptWebSocketConnection(
      solverWebSocketUrl(),
      {
        ...tlsOptions,
        headers: authHeader(apiKey),
      },
      true,
    );
    expect(positiveResult.timedOut).toBe(false);
    expect(positiveResult.opened).toBe(true);

    const negativeResult = await attemptWebSocketConnection(
      solverWebSocketUrl(undefined, apiKey),
      tlsOptions,
      false,
    );
    expect(negativeResult.timedOut).toBe(false);

    if (negativeResult.unexpectedStatus !== null) {
      expect([400, 401, 403]).toContain(negativeResult.unexpectedStatus);
      return;
    }

    expect(negativeResult.opened).toBe(true);
    expect(negativeResult.closeCode).toBe(1008);
  });
});
