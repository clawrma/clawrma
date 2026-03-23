import { describe, expect, it } from "vitest";
import { RULE_COUNT, scanPrompt } from "./scan.js";

function flaggedRuleIds(text: string): string[] {
  return scanPrompt(text).map((flag) => flag.ruleId);
}

describe("scanPrompt", () => {
  it("loads the expected number of rules", () => {
    expect(RULE_COUNT).toBe(19);
  });

  it("flags each sensitive-content test vector", () => {
    const cases: Array<[string, string]> = [
      ["config AKIAIOSFODNN7EXAMPLE done", "aws-access-key"],
      [
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "aws-secret-key",
      ],
      ["sk-proj-abcdefghijklmnopqrstuvwxyz123456", "openai-project-key"],
      ["sk-admin-abcdefghijklmnopqrstuvwxyz123456", "openai-admin-key"],
      ["sk-ant-api03-abcdefghijklmnopqrstu", "anthropic-key"],
      ["sk-or-v1-abcdefghijklmnopqrstuvwx", "openrouter-key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz1234567890", "github-pat"],
      [`github_pat_${"a".repeat(82)}`, "github-pat"],
      ["-----BEGIN RSA PRIVATE KEY-----", "private-key-block"],
      ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef", "bearer-token"],
      [
        "0x4c0883a69102937d6231471b5dbb6204fe512961708279f23efb3d2c4b4e2a1f",
        "eth-private-key",
      ],
      ["5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ", "btc-wif-key"],
      ["xoxb-123456789012-1234567890123-AbCdEfGhIjKl", "slack-token"],
      [
        "https://hooks.slack.com/workflows/abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890+/",
        "slack-webhook",
      ],
      ["ya29.a0ARrdaM8_something_long_enough", "google-oauth"],
      ["AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe", "google-api-key"],
      [
        "Mabcdefghijklmnopqrstuvwxyz.abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZabc",
        "discord-bot-token",
      ],
      ["postgresql://dbuser:dbpass@localhost:5432/mydb", "postgres-db-url"],
      ["123-45-6789", "ssn"],
      ["API_KEY=abc\nSECRET=def\nTOKEN=ghi\n", "env-file-dump"],
    ];

    for (const [text, expectedRuleId] of cases) {
      expect(flaggedRuleIds(text)).toContain(expectedRuleId);
    }
  });

  it("returns no flags for clean prompts", () => {
    const cases = [
      "Summarize the last 50 messages from the telegram group",
      "What is the mass of Jupiter",
      "Search for restaurants near 123-45 Main Street",
    ];

    for (const text of cases) {
      expect(scanPrompt(text)).toEqual([]);
    }
  });

  it("does not match env-file dumps across double newlines", () => {
    expect(scanPrompt("MODE=dark\n\nTHEME=blue\n\nLANG=en\n")).toEqual([]);
  });
});
