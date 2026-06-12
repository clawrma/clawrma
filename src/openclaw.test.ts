import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_PATH = process.env.PATH;

function okRpcResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

function makeProviderConfig(
  modelName = "gpt-5.3-codex",
): Record<string, unknown> {
  return {
    models: {
      providers: {
        "openai-codex": {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          models: [{ id: modelName }],
        },
      },
    },
  };
}

interface FakeOpenClawCliCapture {
  argv: string[];
  stdin: string;
  env: {
    OPENCLAW_CONFIG_PATH: string | null;
    OPENCLAW_STATE_DIR: string | null;
    OPENCLAW_HOME: string | null;
  };
}

async function installFakeOpenClawCli(
  rootDir: string,
): Promise<{ binDir: string; capturePath: string }> {
  const binDir = join(rootDir, "bin");
  const capturePath = join(rootDir, "openclaw-cli-capture.json");
  const executablePath = join(binDir, "openclaw");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    executablePath,
    `#!${process.execPath}
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const capturePath = process.env.CLAWRMA_OPENCLAW_CAPTURE;
  if (!capturePath) {
    process.exit(64);
  }
  fs.writeFileSync(
    capturePath,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdin: Buffer.concat(chunks).toString("utf8"),
      env: {
        OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH ?? null,
        OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR ?? null,
        OPENCLAW_HOME: process.env.OPENCLAW_HOME ?? null,
      },
    }),
    "utf8",
  );
});
`,
    "utf8",
  );
  await chmod(executablePath, 0o755);
  return { binDir, capturePath };
}

async function readFakeOpenClawCliCapture(
  capturePath: string,
): Promise<FakeOpenClawCliCapture> {
  const raw = await readFile(capturePath, "utf8");
  return JSON.parse(raw) as FakeOpenClawCliCapture;
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

describe("resolveOpenClawConfigCandidates", () => {
  it("uses OPENCLAW_CONFIG_PATH as the only candidate when set", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const stateDir = join(home, "state");
    const openClawHome = join(home, "custom-home");
    const explicitPath = join(home, "custom-config.json5");
    const { resolveOpenClawConfigCandidates } = await loadModuleWithHome(home);

    const candidates = resolveOpenClawConfigCandidates(
      {
        OPENCLAW_CONFIG_PATH: explicitPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_HOME: openClawHome,
      },
      home,
    );

    expect(candidates).toEqual([
      {
        path: explicitPath,
        source: "OPENCLAW_CONFIG_PATH",
        sourceValue: explicitPath,
        relativePath: null,
      },
    ]);
  });

  it("uses OPENCLAW_STATE_DIR as the only candidate source when set", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const stateDir = join(home, "state");
    const { resolveOpenClawConfigCandidates } = await loadModuleWithHome(home);

    const candidates = resolveOpenClawConfigCandidates(
      { OPENCLAW_STATE_DIR: stateDir },
      home,
    );

    expect(
      candidates.map((candidate) => ({
        path: candidate.path,
        source: candidate.source,
        relativePath: candidate.relativePath,
      })),
    ).toEqual([
      {
        path: join(stateDir, "openclaw.json"),
        source: "OPENCLAW_STATE_DIR",
        relativePath: "openclaw.json",
      },
      {
        path: join(stateDir, "clawdbot.json"),
        source: "OPENCLAW_STATE_DIR",
        relativePath: "clawdbot.json",
      },
    ]);
  });

  it("uses OPENCLAW_HOME for OpenClaw home candidates", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const openClawHome = join(home, "custom-openclaw-home");
    const { resolveOpenClawConfigCandidates } = await loadModuleWithHome(home);

    const candidates = resolveOpenClawConfigCandidates(
      { OPENCLAW_HOME: openClawHome },
      home,
    );

    expect(
      candidates.map((candidate) => ({
        path: candidate.path,
        source: candidate.source,
        sourceValue: candidate.sourceValue,
        relativePath: candidate.relativePath,
      })),
    ).toEqual([
      {
        path: join(openClawHome, ".openclaw", "openclaw.json"),
        source: "OPENCLAW_HOME",
        sourceValue: openClawHome,
        relativePath: ".openclaw/openclaw.json",
      },
      {
        path: join(openClawHome, ".openclaw", "clawdbot.json"),
        source: "OPENCLAW_HOME",
        sourceValue: openClawHome,
        relativePath: ".openclaw/clawdbot.json",
      },
      {
        path: join(openClawHome, ".clawdbot", "openclaw.json"),
        source: "OPENCLAW_HOME",
        sourceValue: openClawHome,
        relativePath: ".clawdbot/openclaw.json",
      },
      {
        path: join(openClawHome, ".clawdbot", "clawdbot.json"),
        source: "OPENCLAW_HOME",
        sourceValue: openClawHome,
        relativePath: ".clawdbot/clawdbot.json",
      },
    ]);
  });
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

describe("ensureClawrmaOpenClawPluginInstalled", () => {
  it("links the installed Clawrma package through the OpenClaw plugin CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { binDir, capturePath } = await installFakeOpenClawCli(home);
    vi.stubEnv("CLAWRMA_OPENCLAW_CAPTURE", capturePath);
    vi.stubEnv("PATH", `${binDir}${delimiter}${ORIGINAL_PATH ?? ""}`);

    const { ensureClawrmaOpenClawPluginInstalled } =
      await loadModuleWithHome(home);

    const result = await ensureClawrmaOpenClawPluginInstalled();

    expect(result.installed).toBe(true);
    expect(result.pluginRoot).toMatch(/clawrma$/);
    const capture = await readFakeOpenClawCliCapture(capturePath);
    expect(capture.argv).toEqual([
      "plugins",
      "install",
      "--link",
      result.pluginRoot,
    ]);
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

  it("falls back to OpenClaw CLI patch with stdin and current environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { binDir, capturePath } = await installFakeOpenClawCli(home);
    const configPath = join(home, "openclaw.json5");
    await writeFile(
      configPath,
      `{
        agents: {
          defaults: {
            model: {
              fallbacks: ["openai/gpt-5.1"],
            },
          },
        },
      }\n`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("CLAWRMA_OPENCLAW_CAPTURE", capturePath);
    vi.stubEnv("PATH", `${binDir}${delimiter}${ORIGINAL_PATH ?? ""}`);

    const { injectProvider } = await loadModuleWithHome(home);
    const fetchMock = vi.fn(async () =>
      okRpcResponse({ error: { message: "gateway unavailable" } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await injectProvider(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "clawrma-api-key",
      "https://clawrma.test",
    );

    expect(result).toEqual({
      injected: true,
      fallbackPosition: 2,
      fallbackTotal: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const capture = await readFakeOpenClawCliCapture(capturePath);
    expect(capture.argv).toEqual(["config", "patch", "--stdin"]);
    expect(capture.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
    const patch = JSON.parse(capture.stdin) as Record<string, unknown>;
    expect(patch).toMatchObject({
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.1", "clawrma/strong"],
          },
        },
      },
      skills: {
        entries: {
          clawrma: {
            env: {
              CLAWRMA_API_KEY: "clawrma-api-key",
            },
          },
        },
      },
    });
  });

  it("builds CLI fallback patches from OPENCLAW_STATE_DIR instead of home config", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { binDir, capturePath } = await installFakeOpenClawCli(home);
    const stateDir = join(home, "missing-state");
    const homeConfigDir = join(home, ".openclaw");
    const homeConfigPath = join(homeConfigDir, "openclaw.json");
    await mkdir(homeConfigDir, { recursive: true });
    await writeFile(
      homeConfigPath,
      JSON.stringify(
        {
          agents: {
            defaults: {
              model: {
                fallbacks: ["home/model"],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("CLAWRMA_OPENCLAW_CAPTURE", capturePath);
    vi.stubEnv("PATH", `${binDir}${delimiter}${ORIGINAL_PATH ?? ""}`);

    const { injectProvider } = await loadModuleWithHome(home);
    const fetchMock = vi.fn(async () =>
      okRpcResponse({ error: { message: "gateway unavailable" } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await injectProvider(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "clawrma-api-key",
      "https://clawrma.test",
    );

    expect(result).toEqual({
      injected: true,
      fallbackPosition: 1,
      fallbackTotal: 1,
    });

    const capture = await readFakeOpenClawCliCapture(capturePath);
    expect(capture.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    const patch = JSON.parse(capture.stdin) as Record<string, unknown>;
    expect(patch).toMatchObject({
      agents: {
        defaults: {
          model: {
            fallbacks: ["clawrma/strong"],
          },
        },
      },
    });
  });
});

describe("injectClawrmaWebSearchProvider", () => {
  it("configures Clawrma managed web_search and selects it when no provider is selected", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { injectClawrmaWebSearchProvider } = await loadModuleWithHome(home);
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
              hash: "hash-web-search-1",
              config: {},
            },
          });
        }
        if (body.method === "config.patch") {
          return okRpcResponse({
            result: {
              config: {
                plugins: {
                  entries: {
                    clawrma: {
                      enabled: true,
                      config: {
                        webSearch: {
                          apiBaseUrl: "https://clawrma.test",
                          apiKey: "cr_sk_search",
                        },
                      },
                    },
                  },
                },
                tools: {
                  web: {
                    search: {
                      enabled: true,
                      provider: "clawrma",
                    },
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

    const result = await injectClawrmaWebSearchProvider(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "cr_sk_search",
      "https://clawrma.test/",
    );

    expect(result).toEqual({
      configured: true,
      selected: true,
      selectedProvider: "clawrma",
      preservedProvider: null,
      replacedProvider: null,
    });
    const patchRequest = requests.find(
      (request) => request.method === "config.patch",
    );
    expect(patchRequest?.params).toMatchObject({
      baseHash: "hash-web-search-1",
    });
    const patchParams = patchRequest?.params as { raw: string };
    expect(JSON.parse(patchParams.raw)).toEqual({
      plugins: {
        entries: {
          clawrma: {
            enabled: true,
            config: {
              webSearch: {
                apiBaseUrl: "https://clawrma.test",
                apiKey: "cr_sk_search",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "clawrma",
          },
        },
      },
    });
  });

  it("preserves an existing non-Clawrma web_search provider unless replacement is requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { injectClawrmaWebSearchProvider } = await loadModuleWithHome(home);
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
              config: {
                tools: {
                  web: {
                    search: {
                      provider: "brave",
                    },
                  },
                },
              },
            },
          });
        }
        if (body.method === "config.patch") {
          return okRpcResponse({
            result: {
              config: {
                plugins: {
                  entries: {
                    clawrma: {
                      enabled: true,
                      config: {
                        webSearch: {
                          apiBaseUrl: "https://clawrma.test",
                          apiKey: "cr_sk_search",
                        },
                      },
                    },
                  },
                },
                tools: {
                  web: {
                    search: {
                      provider: "brave",
                    },
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

    const result = await injectClawrmaWebSearchProvider(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "cr_sk_search",
      "https://clawrma.test",
    );

    expect(result).toEqual({
      configured: true,
      selected: false,
      selectedProvider: "brave",
      preservedProvider: "brave",
      replacedProvider: null,
    });
    const patchRequest = requests.find(
      (request) => request.method === "config.patch",
    );
    const patchParams = patchRequest?.params as { raw: string };
    const patch = JSON.parse(patchParams.raw) as Record<string, unknown>;
    expect(patch).toEqual({
      plugins: {
        entries: {
          clawrma: {
            enabled: true,
            config: {
              webSearch: {
                apiBaseUrl: "https://clawrma.test",
                apiKey: "cr_sk_search",
              },
            },
          },
        },
      },
    });
  });

  it("replaces an existing web_search provider only when explicitly requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const emptyBinDir = join(home, "empty-bin");
    await mkdir(configDir, { recursive: true });
    await mkdir(emptyBinDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          tools: {
            web: {
              search: {
                enabled: true,
                provider: "firecrawl",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    vi.stubEnv("PATH", emptyBinDir);

    const { injectClawrmaWebSearchProvider } = await loadModuleWithHome(home);
    const fetchMock = vi.fn(async () =>
      okRpcResponse({ error: { message: "gateway unavailable" } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await injectClawrmaWebSearchProvider(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "cr_sk_search",
      "https://clawrma.test",
      undefined,
      { replaceExistingProvider: true },
    );

    expect(result).toEqual({
      configured: true,
      selected: true,
      selectedProvider: "clawrma",
      preservedProvider: null,
      replacedProvider: "firecrawl",
    });
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written).toMatchObject({
      plugins: {
        entries: {
          clawrma: {
            enabled: true,
            config: {
              webSearch: {
                apiBaseUrl: "https://clawrma.test",
                apiKey: "cr_sk_search",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "clawrma",
          },
        },
      },
    });
  });
});

describe("writeClawrmaApiKey", () => {
  it("writes CLAWRMA_API_KEY via Gateway RPC before fallbacks", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const { writeClawrmaApiKey } = await loadModuleWithHome(home);
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
              hash: "hash-api-key-1",
              config: {},
            },
          });
        }
        if (body.method === "config.patch") {
          return okRpcResponse({ result: { config: {} } });
        }
        throw new Error(`Unexpected RPC method: ${String(body.method)}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await writeClawrmaApiKey(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "cr_sk_rpc",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const patchRequest = requests.find(
      (request) => request.method === "config.patch",
    );
    expect(patchRequest?.params).toMatchObject({ baseHash: "hash-api-key-1" });
    const patchParams = patchRequest?.params as { raw: string };
    expect(JSON.parse(patchParams.raw)).toEqual({
      skills: {
        entries: {
          clawrma: {
            env: {
              CLAWRMA_API_KEY: "cr_sk_rpc",
            },
          },
        },
      },
    });
  });

  it("falls back to direct file editing for strict JSON config", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const emptyBinDir = join(home, "empty-bin");
    await mkdir(configDir, { recursive: true });
    await mkdir(emptyBinDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          skills: {
            entries: {
              clawrma: {
                env: {
                  EXISTING_VALUE: "keep",
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    vi.stubEnv("PATH", emptyBinDir);

    const { writeClawrmaApiKey } = await loadModuleWithHome(home);
    const fetchMock = vi.fn(async () =>
      okRpcResponse({ error: { message: "gateway unavailable" } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await writeClawrmaApiKey(
      "https://gateway.example.com/rpc",
      "gateway-token",
      "cr_sk_direct",
    );

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written).toMatchObject({
      skills: {
        entries: {
          clawrma: {
            env: {
              EXISTING_VALUE: "keep",
              CLAWRMA_API_KEY: "cr_sk_direct",
            },
          },
        },
      },
    });
  });

  it("refuses direct file editing when the active config is JSON5-only", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configPath = join(home, "openclaw.json5");
    const emptyBinDir = join(home, "empty-bin");
    const original = `{
      // Strict JSON cannot preserve this safely.
      skills: {
        entries: {},
      },
    }\n`;
    await mkdir(emptyBinDir, { recursive: true });
    await writeFile(configPath, original, "utf8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("PATH", emptyBinDir);

    const { writeClawrmaApiKey } = await loadModuleWithHome(home);
    const fetchMock = vi.fn(async () =>
      okRpcResponse({ error: { message: "gateway unavailable" } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      writeClawrmaApiKey(
        "https://gateway.example.com/rpc",
        "gateway-token",
        "cr_sk_json5",
      ),
    ).rejects.toThrow(
      /gateway-rpc: .*openclaw-cli: .*strict-json-file: .*JSON5 syntax.*Start the OpenClaw Gateway or ensure the openclaw CLI is on PATH/s,
    );
    await expect(readFile(configPath, "utf8")).resolves.toBe(original);
  });

  it("reports config-not-found candidates after all write fallbacks fail", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const missingConfigPath = join(home, "missing-openclaw.json");
    const emptyBinDir = join(home, "empty-bin");
    await mkdir(emptyBinDir, { recursive: true });
    vi.stubEnv("OPENCLAW_CONFIG_PATH", missingConfigPath);
    vi.stubEnv("PATH", emptyBinDir);

    const { writeClawrmaApiKey } = await loadModuleWithHome(home);
    const fetchMock = vi.fn(async () =>
      okRpcResponse({ error: { message: "gateway unavailable" } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      writeClawrmaApiKey(
        "https://gateway.example.com/rpc",
        "gateway-token",
        "cr_sk_missing",
      ),
    ).rejects.toThrow(
      new RegExp(
        `gateway-rpc: .*openclaw-cli: .*strict-json-file: .*OpenClaw config not found.*${missingConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "s",
      ),
    );
  });
});

describe("readOpenClawConfig", () => {
  it("reads OPENCLAW_CONFIG_PATH before default candidates", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const explicitPath = join(home, "openclaw.json5");
    const defaultConfigDir = join(home, ".openclaw");
    const defaultConfigPath = join(defaultConfigDir, "openclaw.json");
    await mkdir(defaultConfigDir, { recursive: true });
    await writeFile(
      defaultConfigPath,
      JSON.stringify(makeProviderConfig("default-model"), null, 2),
      "utf8",
    );
    await writeFile(
      explicitPath,
      JSON.stringify(makeProviderConfig("explicit-model"), null, 2),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", explicitPath);

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.path).toBe(explicitPath);
    expect(config?.providers[0]?.modelName).toBe("explicit-model");
  });

  it("reads OPENCLAW_STATE_DIR before home candidates", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const stateDir = join(home, "state");
    const homeConfigDir = join(home, ".openclaw");
    const stateConfigPath = join(stateDir, "openclaw.json");
    const homeConfigPath = join(homeConfigDir, "openclaw.json");
    await mkdir(stateDir, { recursive: true });
    await mkdir(homeConfigDir, { recursive: true });
    await writeFile(
      homeConfigPath,
      JSON.stringify(makeProviderConfig("home-model"), null, 2),
      "utf8",
    );
    await writeFile(
      stateConfigPath,
      JSON.stringify(makeProviderConfig("state-model"), null, 2),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.path).toBe(stateConfigPath);
    expect(config?.providers[0]?.modelName).toBe("state-model");
  });

  it("does not read home config when OPENCLAW_STATE_DIR is set and missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const stateDir = join(home, "missing-state");
    const homeConfigDir = join(home, ".openclaw");
    const homeConfigPath = join(homeConfigDir, "openclaw.json");
    await mkdir(homeConfigDir, { recursive: true });
    await writeFile(
      homeConfigPath,
      JSON.stringify(makeProviderConfig("home-model"), null, 2),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config).toBeNull();
  });

  it("reads OPENCLAW_HOME candidates", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const openClawHome = join(home, "custom-openclaw-home");
    const configDir = join(openClawHome, ".openclaw");
    const configPath = join(configDir, "clawdbot.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(makeProviderConfig("openclaw-home-model"), null, 2),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_HOME", openClawHome);

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.path).toBe(configPath);
    expect(config?.providers[0]?.modelName).toBe("openclaw-home-model");
  });

  it("parses OpenClaw JSON5 config syntax", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `{
        // OpenClaw accepts JSON5 config.
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-test",
              models: [{ id: "json5-model", }],
            },
          },
        },
      }\n`,
      "utf8",
    );

    const { readOpenClawConfig } = await loadModuleWithHome(home);
    const config = await readOpenClawConfig();

    expect(config?.path).toBe(configPath);
    expect(config?.providers[0]?.modelName).toBe("json5-model");
  });

  it("loads OPENCLAW_CONFIG_PATH for direct write fallback reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configPath = join(home, "write-target.json5");
    await writeFile(
      configPath,
      `{
        skills: {
          entries: {},
        },
      }\n`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    const { loadOpenClawConfigForWrite } = await loadModuleWithHome(home);
    const loaded = await loadOpenClawConfigForWrite();

    expect(loaded.path).toBe(configPath);
    expect(loaded.config).toEqual({ skills: { entries: {} } });
  });

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

  it("distinguishes selected managed search providers from Clawrma plugin config", async () => {
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
                enabled: true,
                provider: "brave",
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

    expect(config?.existingSearchConfig).toBe(true);
    expect(config?.existingClawrmaSearchConfig).toBe(false);
    expect(config?.selectedSearchProvider).toBe("brave");
  });

  it("detects complete Clawrma managed search plugin config", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrma-openclaw-home-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugins: {
            entries: {
              clawrma: {
                enabled: true,
                config: {
                  webSearch: {
                    apiBaseUrl: "https://api.clawrma.com",
                    apiKey: "cr_sk_test",
                  },
                },
              },
            },
          },
          tools: {
            web: {
              search: {
                enabled: true,
                provider: "clawrma",
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

    expect(config?.existingSearchConfig).toBe(true);
    expect(config?.existingClawrmaSearchConfig).toBe(true);
    expect(config?.selectedSearchProvider).toBe("clawrma");
  });
});
