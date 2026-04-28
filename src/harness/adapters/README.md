# Runner adapters

Each adapter normalizes native hook payloads from a coding-agent CLI into the
canonical `UnifiedHookEvent` shape (`cli/src/harness/unified-event.ts`). Adapters
also render installer settings fragments and translate `HarnessDecision` back
into the runner's stdout/stderr/exit-code contract.

**Key docs:**
- `docs/design/cli-hook-normalization.md` — per-runner quirks, decision table
- `docs/design/free-cli-architecture.md` — directory layout, installer manifest
- `docs/design/three-product-architecture.md` — latency budgets

## Runner matrix (as of 2026-04-27)

| Runner         | `id`           | Status       | Native events                                                                    | Decision contract                                  | Native ask | Post→model |
| -------------- | -------------- | ------------ | -------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- | ---------- |
| Claude Code    | `claude-code`  | Stable       | `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, 10 more               | stdout JSON `{decision: "deny"\|"ask"}` or exit 0  | ✅          | ✅ `additionalContext` |
| Copilot CLI    | `copilot-cli`  | Stable       | `preToolUse`, `postToolUse`, `sessionStart`, `sessionEnd`, `userPromptSubmitted` | stderr + exit 2 = deny; exit 0 = allow             | ❌ → deny  | ❌ stderr only |
| Cursor         | `cursor`       | Stable       | `beforeShellExecution`, `beforeMcpToolExecution`, 4 more                         | stdout JSON `{permission: "allow"\|"deny"\|"ask"}` | ✅          | ❌ stderr only |
| Codex CLI      | `codex`        | Stable       | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest` | stdout JSON `{decision: "block"}` or `additionalContext` | ❌ → block | ✅ `additionalContext` |
| Gemini CLI     | `gemini-cli`   | Experimental | `BeforeTool`, `AfterTool`, `AfterModel`, `PreCompress`                           | stdout JSON (provisional)                          | 🚧 prov    | 🚧 prov    |

**Native ask** = runner has a user-confirm primitive (Claude `permissionDecision: "ask"`, Cursor `permission: "ask"`). When absent, the harness collapses our canonical `decision: "ask"` to a hard deny so the user still sees the reason and can refine.

**Post→model** = `additionalContext` from PostToolUse is echoed back into the model's next-turn context. When absent, post-event warnings only land in the user's terminal stderr — `pre_warn` and `post` checks deliver no model-visible signal on those runners. Prefer `pre_block` for anything that must drive agent behavior across all four stable runners.

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
