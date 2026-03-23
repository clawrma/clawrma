import { afterEach, describe, expect, it, vi } from "vitest";
import {
  braveSearchFulfiller,
  defaultWebSearchFulfillers,
} from "./web-search.js";

function makeAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("braveSearchFulfiller.detect", () => {
  it("returns the runnable web_search capability when BRAVE_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", " brave-test-key ");

    expect(braveSearchFulfiller.detect({ taskTypes: ["web_search"] })).toEqual({
      task_type: "web_search",
      billing_type: "local",
      fulfillment_path: "api",
      provider_name: "clawrma-search",
      model_name: "web-search",
    });
    expect(defaultWebSearchFulfillers).toEqual([braveSearchFulfiller]);
  });

  it("returns null when BRAVE_API_KEY is blank", () => {
    vi.stubEnv("BRAVE_API_KEY", "   ");

    expect(
      braveSearchFulfiller.detect({ taskTypes: ["web_search"] }),
    ).toBeNull();
  });

  it("returns null when BRAVE_API_KEY is missing", () => {
    expect(
      braveSearchFulfiller.detect({ taskTypes: ["web_search"] }),
    ).toBeNull();
  });
});

describe("braveSearchFulfiller.fulfill payload validation", () => {
  it("rejects payloads without a query", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");
    const fetchMock = vi.fn() as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {},
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({
      message: "web_search payload must include a non-empty query.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects payloads with an empty query", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");
    const fetchMock = vi.fn() as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: "   ",
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({
      message: "web_search payload must include a non-empty query.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects payloads with a non-integer count", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");
    const fetchMock = vi.fn() as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: "clawrma",
          count: "5",
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({
      message: "web_search payload count must be an integer.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects payloads with an out-of-range count", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");
    const fetchMock = vi.fn() as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: "clawrma",
          count: 11,
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({
      message: "web_search payload count must be between 1 and 10.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("braveSearchFulfiller.fulfill provider behavior", () => {
  it("builds the Brave request and truncates normalized results to the requested count", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.search.brave.com/res/v1/web/search?q=clawrma&count=2",
        );
        expect(init).toMatchObject({
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": "brave-test-key",
          },
        });

        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Clawrma",
                  url: "https://example.com/clawrma",
                  description: "Distributed task execution.",
                },
                {
                  title: "Second",
                  url: "https://example.com/second",
                  description: "Second result.",
                },
                {
                  title: "Ignored",
                  url: "https://example.com/ignored",
                  description: "Should not be returned.",
                },
              ],
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    ) as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: " clawrma ",
          count: 2,
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).resolves.toEqual({
      query: "clawrma",
      results: [
        {
          title: "Clawrma",
          url: "https://example.com/clawrma",
          snippet: "Distributed task execution.",
        },
        {
          title: "Second",
          url: "https://example.com/second",
          snippet: "Second result.",
        },
      ],
    });
  });

  it("surfaces Brave HTTP failures", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");

    const fetchMock = vi.fn(
      async () => new Response("upstream failed", { status: 503 }),
    ) as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: "clawrma",
          count: 3,
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({
      message: "Brave Search returned HTTP 503: upstream failed",
    });
  });

  it("surfaces invalid JSON responses", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");

    const fetchMock = vi.fn(
      async () =>
        new Response("{invalid", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    ) as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: "clawrma",
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({
      message: "Brave Search returned invalid JSON.",
    });
  });

  it("surfaces timeout errors", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-test-key");

    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Missing abort signal."));
            return;
          }

          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(makeAbortError());
            },
            { once: true },
          );
        }),
    ) as typeof fetch;

    await expect(
      braveSearchFulfiller.fulfill(
        {
          query: "clawrma",
          count: 2,
        },
        {
          fetchImpl: fetchMock,
          fetchTimeoutMs: 5,
        },
      ),
    ).rejects.toMatchObject({
      message: "web_search timed out after 5ms.",
      category: "timeout",
    });
  });
});
