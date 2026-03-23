# Contributing

## Requirements

- Node.js 22 or newer (repo `.nvmrc` pins 22 - run `nvm use` if you use nvm)
- npm

## Setup

```bash
npm install
npm run build
npm run lint
npm run typecheck
npm test
```

For live integration coverage, copy `.env.test.example` to `.env.test`, uncomment the values you need, and run:

```bash
npm run test:live
```

Use `NODE_TLS_REJECT_UNAUTHORIZED=0` only for local self-signed HTTPS during development.

## Before Submitting a PR

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

If your change affects setup, packaging, OpenClaw integration, or the public CLI surface, update the relevant docs in `README.md`.

## Pull Requests

- Keep changes scoped to the public package and skill surface.
- Add or update tests with behavior changes.
- Avoid committing `dist/`, `node_modules/`, or local tarballs.
- Keep exported APIs and CLI behavior documented.

## Code Style

TypeScript, enforced by ESLint ([`eslint.config.js`](./eslint.config.js)) and formatted with Prettier. Run `npm run format` to auto-format.

## Reporting Bugs

Open a GitHub issue with reproduction steps, expected vs actual behavior, and your Node.js version.
