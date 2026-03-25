# Changelog

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
