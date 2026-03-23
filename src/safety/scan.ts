import rawPatterns from "./patterns.json" with { type: "json" };
import { isRecord } from "../guards.js";

interface PatternRule {
  id: string;
  label: string;
  pattern: string;
}

interface PatternFile {
  version: number;
  rules: PatternRule[];
}

interface CompiledRule {
  ruleId: string;
  label: string;
  regex: RegExp;
}

/**
 * A single sensitive-content match returned by the client-side scanner.
 */
export interface ScanFlag {
  ruleId: string;
  label: string;
}

const PATTERN_FILE = parsePatternFile(rawPatterns);

const COMPILED_RULES: CompiledRule[] = PATTERN_FILE.rules.map((rule) => ({
  ruleId: rule.id,
  label: rule.label,
  regex: new RegExp(rule.pattern),
}));

/**
 * Number of compiled safety rules loaded from `patterns.json`.
 */
export const RULE_COUNT = COMPILED_RULES.length;

/**
 * Scan text for sensitive content using the shared regex rule set.
 */
export function scanPrompt(text: string): ScanFlag[] {
  const flags: ScanFlag[] = [];

  for (const rule of COMPILED_RULES) {
    if (rule.regex.test(text)) {
      flags.push({ ruleId: rule.ruleId, label: rule.label });
    }
  }

  return flags;
}

function parsePatternFile(value: unknown): PatternFile {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !Array.isArray(value.rules)
  ) {
    throw new Error("Invalid safety pattern file.");
  }

  const rules: PatternRule[] = value.rules.map((rule, index) =>
    parsePatternRule(rule, index),
  );
  return {
    version: value.version,
    rules,
  };
}

function parsePatternRule(value: unknown, index: number): PatternRule {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.pattern !== "string"
  ) {
    throw new Error(`Invalid safety pattern rule at index ${index}.`);
  }

  return {
    id: value.id,
    label: value.label,
    pattern: value.pattern,
  };
}
