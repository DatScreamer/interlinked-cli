# Runner adapters

Each adapter normalizes native hook payloads from a coding-agent CLI into the
canonical `UnifiedHookEvent` shape (`cli/src/harness/unified-event.ts`). Adapters
also render installer settings fragments and translate `HarnessDecision` back
into the runner's stdout/stderr/exit-code contract.

**Key docs:**
- `docs/design/cli-hook-normalization.md` — per-runner quirks, decision table
- `docs/design/free-cli-architecture.md` — directory layout, installer manifest
- `docs/design/three-product-architecture.md` — latency budgets

## Runner matrix (as of 2026-04-23)

| Runner         | `id`           | Status       | Native events                                                                    | Decision contract                                  |
| -------------- | -------------- | ------------ | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Claude Code    | `claude-code`  | Stable       | `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, 10 more               | stdout JSON `{decision: "deny"\|"ask"}` or exit 0  |
| Copilot CLI    | `copilot-cli`  | Stable       | `preToolUse`, `postToolUse`, `sessionStart`, `sessionEnd`, `userPromptSubmitted` | stderr + exit 2 = deny; exit 0 = allow             |
| Cursor         | `cursor`       | Stable       | `beforeShellExecution`, `beforeMcpToolExecution`, 4 more                         | stdout JSON `{allow: bool, ask?, reason?}`         |
| Gemini CLI     | `gemini-cli`   | Experimental | `BeforeTool`, `AfterTool`, `AfterModel`, `PreCompress`                           | stdout JSON (provisional)                          |
| Codex CLI      | `codex`        | Experimental | `pre_tool`, `post_tool`, `pre_command`, `post_command`, lifecycle                | stderr + exit codes (provisional)                  |

When a runner ships a 1.0 hook contract that differs from what is in this table,
update the adapter, stamp the file header with today's date, and re-run the
cross-runner equivalence tests in `index.test.ts`.

## Contract

All adapters conform to `RunnerAdapter` in `./types.ts`:

- `detectFromEnv(env)` — heuristic process-env check for auto-detection.
- `nativeEventNames` — the runner's own event names this adapter knows.
- `parseHookInput(nativeJson, nativeEventName)` — returns a `UnifiedHookEvent`.
  Must tolerate unknown fields; runners evolve their payload shapes.
- `classifyToolClass(toolName, toolInput)` — delegates to
  `tool-class-classifier.ts` plus user overrides from
  `.interlinked/tool-class-overrides.json`.
- `renderSettingsFragment(binaryPath, scope)` — produces a merge-safe settings
  fragment. Hook arrays are appended, never replaced.
- `encodeDecision(decision, event)` — translates to runner-specific output.

## Adding a new runner

1. Read the runner's hooks documentation at the time of implementation.
2. Stamp the adapter header comment with today's date.
3. Implement all six methods above.
4. Add the adapter to `buildAllAdapters()` in `index.ts`.
5. Update the matrix above.
6. Co-locate `{runner}.test.ts` covering parse, classify, encode, and the
   settings fragment.
7. Extend `index.test.ts` cross-runner equivalence tests to include the new
   runner.
