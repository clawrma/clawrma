import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBalance,
  getCapabilities,
  getStatus,
  requestChatCompletions,
  submitTask,
  truncateKey,
  updateAccountSettings,
} from "./client.js";

describe("truncateKey", () => {
  it("truncates long keys and leaves short keys unchanged", () => {
    const truncated = truncateKey("cr_sk_1234567890");
    expect(truncated.startsWith("cr_s")).toBe(true);
    expect(truncated.endsWith("7890")).toBe(true);
    expect(truncated.length).toBeGreaterThanOrEqual(9);
    expect(truncateKey("short")).toBe("short");
  });
});

describe("client API behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses API detail payloads into structured errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "payload invalid" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      getBalance("https://api.clawrma.com", "cr_sk_test"),
    ).rejects.toThrow("payload invalid");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses standard failure envelopes into structured errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "FAILED",
          error: {
            type: "task_failed",
            category: "internal",
            detail: "no_solvers_available",
          },
          charged: false,
          elapsed_ms: 9,
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      getBalance("https://api.clawrma.com", "cr_sk_test"),
    ).rejects.toThrow("no_solvers_available");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects unsupported URL protocols for browser tasks before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "proxy_fetch", {
        url: "ftp://example.com",
      }),
    ).rejects.toThrow(
      "Unsupported URL protocol 'ftp:'. Use http:// or https://.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs for browser tasks before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "screenshot", {
        url: "not-a-url",
      }),
    ).rejects.toThrow(
      "Invalid URL 'not-a-url'. Expected http:// or https:// URL.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-boolean raw_html values for proxy_fetch before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "proxy_fetch", {
        url: "https://example.com",
        raw_html: "yes" as unknown as boolean,
      }),
    ).rejects.toThrow(
      "Task 'proxy_fetch' payload field 'raw_html' must be a boolean when provided.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks proxy_fetch payloads with sensitive content before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "proxy_fetch", {
        url: "https://example.com?key=sk-ant-api03-realKey1234567890abcdef",
      }),
    ).rejects.toThrow("Sensitive content detected (Anthropic API Key).");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits clean proxy_fetch payloads after the safety scan passes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "proxy_fetch", {
        url: "https://example.com",
      }),
    ).resolves.toEqual({ content: "ok" });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("submits proxy_fetch raw_html requests without altering the JSON payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ body: "<html>ok</html>", content_format: "html" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "proxy_fetch", {
        url: "https://example.com",
        raw_html: true,
      }),
    ).resolves.toEqual({ body: "<html>ok</html>", content_format: "html" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clawrma.com/v1/fetch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "https://example.com", raw_html: true }),
      }),
    );
  });

  it("allows callers to skip the local safety scan explicitly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask(
        "https://api.clawrma.com",
        "cr_sk_test",
        "proxy_fetch",
        { url: "https://example.com?key=sk-ant-api03-realKey1234567890abcdef" },
        true,
      ),
    ).resolves.toEqual({ content: "ok" });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks llm_inference payloads with sensitive content before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "llm_inference", {
        messages: [
          { role: "user", content: "sk-ant-api03-realKey1234567890abcdef" },
        ],
      }),
    ).rejects.toThrow("Sensitive content detected (Anthropic API Key).");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks multiline env dumps in llm_inference payloads before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "llm_inference", {
        messages: [
          { role: "user", content: "API_KEY=abc\nSECRET=def\nTOKEN=ghi\n" },
        ],
      }),
    ).rejects.toThrow(
      "Sensitive content detected (Environment Variable Dump).",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks web_search payloads with sensitive content before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      submitTask("https://api.clawrma.com", "cr_sk_test", "web_search", {
        query: "find docs for sk-ant-api03-realKey1234567890abcdef",
      }),
    ).rejects.toThrow("Sensitive content detected (Anthropic API Key).");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty capabilities when endpoints are not supported", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "method not allowed" }), {
          status: 405,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      getCapabilities("https://api.clawrma.com", "cr_sk_test"),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("patches account settings with the provided prompt safety value", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ prompt_safety_scan: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      updateAccountSettings("https://api.clawrma.com", "cr_sk_test", {
        prompt_safety_scan: false,
      }),
    ).resolves.toEqual({ prompt_safety_scan: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clawrma.com/v1/account/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ prompt_safety_scan: false }),
      }),
    );
  });

  it("does not send a per-request safety bypass header for inference requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestChatCompletions("https://api.clawrma.com", "cr_sk_test", {
      model: "clawrma/strong",
      stream: true,
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clawrma.com/v1/inference/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "clawrma/strong",
          stream: true,
          messages: [{ role: "user", content: "hello world" }],
        }),
      }),
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cr_sk_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-Safety-Scan"]).toBeUndefined();
    expect(headers["x-safety-scan"]).toBeUndefined();
    expect(headers["X-Clawrma-Trust-Mode"]).toBeUndefined();
  });

  it("sends an explicit visible-warning trust-mode header for direct inference when requested", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestChatCompletions(
      "https://api.clawrma.com",
      "cr_sk_test",
      {
        model: "clawrma/strong",
        stream: false,
        messages: [{ role: "user", content: "hello world" }],
      },
      { trustMode: "visible-warning" },
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Clawrma-Trust-Mode"]).toBe("visible-warning");
  });

  it("sends an explicit clean-output trust-mode header for direct inference when requested", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestChatCompletions(
      "https://api.clawrma.com",
      "cr_sk_test",
      {
        model: "clawrma/strong",
        stream: true,
        messages: [{ role: "user", content: "hello world" }],
      },
      { trustMode: "clean-output" },
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Clawrma-Trust-Mode"]).toBe("clean-output");
  });

  it("preserves structured inference messages and tool config in chat-completions requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const payload: Parameters<typeof requestChatCompletions>[2] = {
      model: "clawrma/strong",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Run ls",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "exec",
            parameters: {
              type: "object",
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "exec",
        },
      },
      parallel_tool_calls: false,
    };

    await requestChatCompletions(
      "https://api.clawrma.com",
      "cr_sk_test",
      payload,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clawrma.com/v1/inference/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  it("allows typed input_text inference content parts in chat-completions requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const payload: Parameters<typeof requestChatCompletions>[2] = {
      model: "clawrma/strong",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              input_text: "Stay concise.",
            },
            {
              type: "text",
              text: "Use bash syntax.",
            },
          ],
        },
        {
          role: "user",
          content: "Run pwd",
        },
      ],
    };

    await requestChatCompletions(
      "https://api.clawrma.com",
      "cr_sk_test",
      payload,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clawrma.com/v1/inference/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  it("surfaces non-404 capability errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      getCapabilities("https://api.clawrma.com", "cr_sk_test"),
    ).rejects.toThrow("unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses authoritative solver connection fields from solver stats", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ balance: "2.500000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            active_tasks: 3,
            tasks_solved_today: 4,
            tasks_solved_total: 12,
            earnings_today: "0.900000",
            earnings_total: "3.250000",
            connected: true,
            paused: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      getStatus("https://api.clawrma.com", "cr_sk_test"),
    ).resolves.toEqual({
      balance: 2.5,
      solverState: {
        activeTasks: 3,
        tasksSolvedToday: 4,
        tasksSolvedTotal: 12,
        earningsToday: 0.9,
        earningsTotal: 3.25,
        connected: true,
        paused: false,
      },
      recentActivity: {
        tasksSolvedToday: 4,
        earningsToday: 0.9,
      },
      uptimeSeconds: null,
      capabilities: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
