import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function okRpcResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

async function loadModuleWithHome(
  home: string,
): Promise<typeof import("./integrations/openclaw.js")> {
  process.env.HOME = home;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
  }
  vi.resetModules();
  return import("./integrations/openclaw.js");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (typeof ORIGINAL_HOME === "string") {
    process.env.HOME = ORIGINAL_HOME;
  } else {
    delete process.env.HOME;
  }
  if (typeof ORIGINAL_USERPROFILE === "string") {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  } else if (process.platform === "win32") {
    delete process.env.USERPROFILE;
  }
});

describe("injectFirecrawlConfig", () => {
  it("returns a disabled result without making Gateway RPC calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { injectFirecrawlConfig } = await loadModuleWithHome(home);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const injected = await injectFirecrawlConfig(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "clawrma-api-key",
    );

    expect(injected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not mutate local OpenClaw config files when disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, '{\n  "existing": true\n}\n', "utf8");

    const { injectFirecrawlConfig } = await loadModuleWithHome(home);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const injected = await injectFirecrawlConfig(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "fallback-key",
    );

    expect(injected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readFile(configPath, "utf8")).resolves.toBe(
      '{\n  "existing": true\n}\n',
    );
  });
});

describe("injectProvider", () => {
  it("injects clawrma/strong fallback and strong model metadata via RPC", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { injectProvider } = await loadModuleWithHome(home);
    const requests: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(
      async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push(body);
        if (body.method === "config.get") {
          return okRpcResponse({
            result: {
              hash: "hash-provider-1",
              config: {
                agents: {
                  defaults: { model: { fallbacks: ["openai/gpt-5.1"] } },
                },
              },
            },
          });
        }
        if (body.method === "config.patch") {
          return okRpcResponse({
            result: {
              config: {
                agents: {
                  defaults: {
                    model: { fallbacks: ["openai/gpt-5.1", "clawrma/strong"] },
                  },
                },
              },
            },
          });
        }
        throw new Error(`Unexpected RPC method: ${String(body.method)}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const injected = await injectProvider(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "clawrma-api-key",
      "https://clawrma.test",
    );

    expect(injected).toEqual({
      injected: true,
      fallbackPosition: 2,
      fallbackTotal: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const patchRequest = requests.find(
      (request) => request.method === "config.patch",
    );
    expect(patchRequest).toBeDefined();
    expect(patchRequest?.params).toMatchObject({ baseHash: "hash-provider-1" });

    const patchParams = patchRequest?.params as { raw: string };
    const rawPatch = JSON.parse(patchParams.raw) as Record<string, unknown>;
    expect(rawPatch).toMatchObject({
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.1", "clawrma/strong"],
          },
        },
      },
      models: {
        providers: {
          clawrma: {
            baseUrl: "https://clawrma.test/v1",
            models: [
              {
                id: "strong",
                name: "Clawrma Strong",
                cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    });
    const providerConfig =
      (
        rawPatch.models as {
          providers?: { clawrma?: Record<string, unknown> };
        }
      ).providers?.clawrma ?? {};
    expect(providerConfig.headers).toBeUndefined();
    expect(providerConfig.defaultHeaders).toBeUndefined();
    expect(providerConfig.trustMode).toBeUndefined();
  });
});

describe("readOpenClawConfig", () => {
  it("extracts concrete provider model IDs for capability detection", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          models: {
            providers: {
              "openai-codex": {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "sk-test",
                models: [{ id: "gpt-5.3-codex" }],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.providers).toEqual([
      {
        name: "openai-codex",
        endpoint: "https://api.openai.com/v1",
        apiKey: "sk-test",
        token: "",
        modelName: "gpt-5.3-codex",
      },
    ]);
  });

  it("falls back to the legacy clawdbot config path when needed", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".clawdbot");
    const configPath = join(configDir, "clawdbot.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          models: {
            providers: {
              "openai-codex": {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "sk-test",
                models: [{ id: "gpt-5.3-codex" }],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.path).toBe(configPath);
    expect(config?.providers).toEqual([
      {
        name: "openai-codex",
        endpoint: "https://api.openai.com/v1",
        apiKey: "sk-test",
        token: "",
        modelName: "gpt-5.3-codex",
      },
    ]);
  });

  it("treats blank built-in search env values as missing existing search config", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({}, null, 2), "utf8");
    vi.stubEnv("BRAVE_API_KEY", "   ");

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.existingSearchConfig).toBe(false);
  });

  it("treats blank tools.web.search.apiKey as missing existing search config", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          tools: {
            web: {
              search: {
                apiKey: "   ",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.existingSearchConfig).toBe(false);
  });
});
