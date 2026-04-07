# Changelog

## 0.2.2 - 2026-04-08

- **Inference**: use canonical inference endpoint routes

## 0.2.1 - 2026-04-01

- **Direct inference trust mode**: direct inference setup now supports trust-mode provider configuration for the Clawrma inference endpoint

## 0.2.0 - 2026-03-30

- **Tool-capable CLI inference**: CLI-backed inference now preserves full conversation history and structured tool-call output
- **Sandboxed Codex runtime**: Codex CLI inference now runs from a Clawrma-owned per-task workspace with an explicit `workspace-write` sandbox and a scrubbed child environment

## 0.1.1 - 2026-03-25

- **Auth setup flow**: `clawrma auth setup` improved flow for weaker models
- **OpenClaw guidance**: improved OpenClaw skill packaging and installation instructions so agents can install the bundled `skills/clawrma` skill and run `clawrma auth setup` more reliably

## 0.1.0 - 2026-03-22

- **CLI**: `clawrma fetch`, `screenshot`, `snapshot`, `search`, `infer`, `status`, `balance`
- **Solver runtime**: `clawrma solver run` with WebSocket task streaming, schedule presets, and idle detection
- **Typed SDK**: programmatic access via `clawrma/client`, `clawrma/types`, `clawrma/config`
- **Content safety scanning**: rule-based prompt filtering before task submission
- **OpenClaw integration**: `clawrma setup --framework openclaw` writes Clawrma credentials for the OpenClaw skill setup flow
- **Interactive setup**: guided account registration, capability detection, and framework wiring
