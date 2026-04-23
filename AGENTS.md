# Repository Guidelines

## Project Structure & Module Organization
This package is the TypeScript source for **Interlinked CLI**.
- **Interlinked MCP Server** refers to the remote Cloudflare Worker system that the CLI optionally talks to; it lives in a separate repo (`QuentinCody/mcp-agent-chat`).
- **Interlinked CLI** refers to this package.
- `src/index.ts`: CLI entry point and command registration.
- `src/commands/*.ts`: command handlers (`enable`, `status`, `doctor`, `workspace`, etc.).
- `src/lib/*.ts`: shared logic (auth, config, hooks, API client, formatting).
- `src/templates/`: generated/template assets used by setup flows.
- `src/**/*.test.ts` and `src/commands/__tests__/`: Vitest unit/regression tests.
- `docs/architecture.md`: architecture notes.
- `dist/`: build output (generated).

## Build, Test, and Development Commands
- `npm run dev`: run the CLI directly with `tsx` for local development.
- `npm run build`: bundle `src/index.ts` to `dist/` with type declarations (`tsup`).
- `npm run typecheck`: run strict TypeScript checks (`tsc --noEmit`).
- `npm run test`: run tests once (`vitest run`).
- `npm run test:watch`: run tests in watch mode.

Example:
```bash
npm run dev -- status --short
```

## Coding Style & Naming Conventions
- Language: TypeScript (ESM, strict mode).
- Style in this repo: 4-space indentation, double quotes, semicolons.
- File names: use descriptive kebab-case where practical (for example, `activity-utils.ts`).
- Exports: use `camelCase` for functions and `PascalCase` for types/interfaces.
- Command handlers should stay in `src/commands/`; reusable logic belongs in `src/lib/`.

## Testing Guidelines
- Framework: Vitest (`environment: node`, configured in `vitest.config.ts`).
- Test file pattern: `src/**/*.test.ts`.
- Prefer colocated regression tests for command behavior under `src/commands/__tests__/`.
- Add tests for bug fixes, especially around config merging, auth flows, and CLI output modes.

## Commit & Pull Request Guidelines
- Follow conventional commit style seen in history: `feat: ...`, `fix: ...`, `refactor: ...` (optional scope is fine).
- Keep commit subjects short and imperative.
- PRs should include:
  - What changed and why.
  - Commands run (`npm run typecheck`, `npm run test`).
  - Linked issue/task, if applicable.
  - Terminal output snippets when user-facing CLI behavior changes.

## Security & Configuration Tips
- Never commit secrets from `.interlinked/config.local.json` (tokens are local-only).
- Prefer environment variables for automation (for example, `INTERLINKED_ACCESS_TOKEN`).
- Treat `clean`/`reset` operations as destructive; validate target workspace/project context first.
