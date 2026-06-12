import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ClawrmaOpenClawSearchEnvelope,
  createClawrmaWebSearchProvider,
} from "./openclaw-web-search-provider.js";

function makeConfig(webSearch: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: {
      entries: {
        clawrma: {
          enabled: true,
          config: {
            webSearch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function makeTool(webSearch: Record<string, unknown>) {
  const tool = createClawrmaWebSearchProvider().createTool({
    config: makeConfig(webSearch),
  });

  if (!tool) {
    throw new Error("Expected Clawrma web_search tool.");
  }

  return tool;
}

function expectWrapped(value: unknown, expectedText: string): void {
  expect(typeof value).toBe("string");
  expect(value).toContain(expectedText);
  expect(value).toContain("EXTERNAL_UNTRUSTED_CONTENT");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createClawrmaWebSearchProvider", () => {
  it("exposes OpenClaw provider metadata and credential hooks", () => {
    const provider = createClawrmaWebSearchProvider();
    const config = makeConfig({
      apiKey: "cr_test",
    });

    expect(provider.id).toBe("clawrma");
    expect(provider.credentialPath).toBe(
      "plugins.entries.clawrma.config.webSearch.apiKey",
    );
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("cr_test");
  });
});

describe("Clawrma OpenClaw web_search execution", () => {
  it("posts to /v1/search with auth and normalizes snippets to descriptions", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("http://127.0.0.1:8787/v1/search");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          Accept: "application/json",
          Authorization: "Bearer cr_test",
          "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          query: "openclaw managed search",
          count: 2,
        });

        return new Response(
          JSON.stringify({
            query: "ignored upstream query",
            elapsed_ms: 12,
            _content_warning: "do not leak",
            results: [
              {
                title: "Clawrma",
                url: "https://example.com/clawrma",
                snippet: "Distributed solver search.",
                siteName: "Example",
              },
              {
                title: "OpenClaw",
                url: "https://example.com/openclaw",
                snippet: "Managed tools.",
                published: "2026-06-12",
                content: "Fetched page text.",
              },
            ],
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
    vi.stubGlobal("fetch", fetchMock);

    const tool = makeTool({
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "cr_test",
      count: 4,
      timeoutSeconds: 10,
    });

    const result = (await tool.execute({
      query: " openclaw managed search ",
      count: 2,
    })) as ClawrmaOpenClawSearchEnvelope;

    expect(result).toMatchObject({
      query: "openclaw managed search",
      provider: "clawrma",
      count: 2,
      tookMs: 12,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "clawrma",
        wrapped: true,
      },
    });
    expect(result).not.toHaveProperty("elapsed_ms");
    expect(result).not.toHaveProperty("_content_warning");
    expect(result.results[0]).not.toHaveProperty("snippet");
    expectWrapped(result.results[0]?.title, "Clawrma");
    expect(result.results[0]?.url).toBe("https://example.com/clawrma");
    expectWrapped(result.results[0]?.description, "Distributed solver search.");
    expect(result.results[0]?.siteName).toBe("Example");
    expectWrapped(result.results[1]?.content, "Fetched page text.");
  });

  it("falls back to plugin count when args omit count", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          query: "clawrma",
          count: 3,
        });

        return new Response(
          JSON.stringify({
            query: "clawrma",
            results: [],
          }),
        );
      },
    ) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeTool({
        apiKey: "cr_test",
        count: 3,
      }).execute({
        query: "clawrma",
      }),
    ).resolves.toMatchObject({
      query: "clawrma",
      provider: "clawrma",
      count: 0,
      results: [],
    });
  });

  it("keeps missing snippets as an empty description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              query: "clawrma",
              results: [
                {
                  title: "No snippet",
                  url: "https://example.com/no-snippet",
                },
              ],
            }),
          ),
      ) as typeof fetch,
    );

    const result = (await makeTool({
      apiKey: "cr_test",
    }).execute({
      query: "clawrma",
    })) as ClawrmaOpenClawSearchEnvelope;

    expectWrapped(result.results[0]?.title, "No snippet");
    expect(result.results[0]?.description).toBe("");
  });

  it("rejects malformed result items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              query: "clawrma",
              results: [
                {
                  title: "Bad URL",
                  url: "ftp://example.com/file",
                  snippet: "Unsupported URL scheme.",
                },
              ],
            }),
          ),
      ) as typeof fetch,
    );

    await expect(
      makeTool({
        apiKey: "cr_test",
      }).execute({
        query: "clawrma",
      }),
    ).rejects.toThrow(
      "Clawrma web_search requires results[0].url to be an HTTP URL.",
    );
  });

  it("surfaces upstream error envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "no_solver",
                message: "no_solvers_available",
              },
            }),
          ),
      ) as typeof fetch,
    );

    await expect(
      makeTool({
        apiKey: "cr_test",
      }).execute({
        query: "clawrma",
      }),
    ).rejects.toThrow(
      "Clawrma web_search API error: no_solver: no_solvers_available",
    );
  });

  it("surfaces invalid JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{invalid")) as typeof fetch,
    );

    await expect(
      makeTool({
        apiKey: "cr_test",
      }).execute({
        query: "clawrma",
      }),
    ).rejects.toThrow("Clawrma web_search returned invalid JSON.");
  });

  it("surfaces non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("bad gateway", { status: 502 }),
      ) as typeof fetch,
    );

    await expect(
      makeTool({
        apiKey: "cr_test",
      }).execute({
        query: "clawrma",
      }),
    ).rejects.toThrow("Clawrma web_search returned HTTP 502: bad gateway");
  });

  it("passes OpenClaw abort signals through to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal);
        return new Response(
          JSON.stringify({
            query: "clawrma",
            results: [],
          }),
        );
      },
    ) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await makeTool({
      apiKey: "cr_test",
    }).execute(
      {
        query: "clawrma",
      },
      {
        signal: controller.signal,
      },
    );
  });

  it("enforces configured request timeouts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              {
                once: true,
              },
            );
          }),
      ) as typeof fetch,
    );

    await expect(
      makeTool({
        apiKey: "cr_test",
        timeoutSeconds: 0.001,
      }).execute({
        query: "clawrma",
      }),
    ).rejects.toThrow("Clawrma web_search timed out after 0.001 seconds.");
  });
});
