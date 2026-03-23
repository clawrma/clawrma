import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const contents = readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = dirname(currentFilePath);
const rootDirPath = resolve(currentDirPath, ".");
const envFilePath = resolve(rootDirPath, ".env.test");

function shouldLoadTestEnv(): boolean {
  return process.argv.some(
    (value) =>
      value.includes("tests/e2e") || value.includes("tests/integration"),
  );
}

const runningLiveSuites = shouldLoadTestEnv();

if (runningLiveSuites) {
  loadEnvFile(envFilePath);
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    fileParallelism: !runningLiveSuites,
  },
});
