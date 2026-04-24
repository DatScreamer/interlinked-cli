# Content scanner — `user_prompt` hook (fifth scan point)

## Context

The four existing scan points — Write/Edit, Bash command, external egress, Read/Grep taint — cover every channel by which the **agent** can emit or ingest PII. They don't cover the one channel by which the **user** can introduce it: the prompt they type in the first place.

A support engineer pastes a customer's JSON record into Claude Code with "help me parse this." That record immediately lands in the agent's context window and is shipped to Anthropic on the next turn. No tool call has happened yet; nothing from this session can undo it. The scanner is blind at exactly the moment it matters most.

Closing this gap is a distinct design problem from the tool-side hooks because the operator on the receiving end of the `ask` decision is the **same person who just typed the prompt**. "Are you sure you want to send this?" is a weird question to ask someone who just pressed Enter. UX matters more here than in the tool path.

Fixture commits have already landed the plumbing: `ContentScanRequest.hook: "user_prompt"` and `scan_points.user_prompt: boolean`. This doc specifies the behavior.

## Design

### Hook wiring

Claude Code fires `UserPromptSubmit` before the prompt is appended to the context and before the model is called. The hook payload includes the submitted text. The existing hook script already proxies these events to the harness — no hook-generator change needed.

`src/harness/evaluator/user-prompt.ts` (new):

```ts
export function evaluateUserPromptSubmit(
  event: HarnessEvent,
  rules: GuardRulesConfig,
): HarnessDecision {
  if (!rules.content_scanner?.enabled) return { decision: "allow" };
  if (!rules.content_scanner.scan_points.user_prompt) return { decision: "allow" };
  const prompt = typeof event.prompt === "string" ? event.prompt : "";
  if (!prompt) return { decision: "allow" };
  return {
    decision: "allow",
    _contentScan: {
      hook: "user_prompt",
      parts: [{ source: "UserPromptSubmit.prompt", text: prompt }],
    },
  };
}
```

`server.ts` dispatches `UserPromptSubmit` to this evaluator alongside the existing PreToolUse dispatch. The same async-scan block that handles `_contentScan` for tool calls handles this too — one code path, two hook shapes.

### Decision semantics: `warn`, not `ask`

The tool-path default is `ask` because the human can meaningfully reconsider the tool call. The prompt path is different:

- The text is already typed. Asking "send this?" is annoying and gets muscle-memory-approved.
- The user *is* the originator — they're not being asked to vet someone else's PII, they're being asked to vet their own.
- Blocking a user prompt is strange UX. The only sensible actions are (a) warn and proceed, or (b) offer an automatic redaction they can accept.

**v1 behavior:** `decision: "allow"` plus a `warnings[]` entry with the same category summary + redacted preview the tool path uses. No confirmation blocking. The user's terminal shows a yellow banner the next time the CLI prints output:

```
⚠️  [content-scanner] Your last prompt contained sensitive content
   [private_email(1), private_person(1)]. Consider <PRIVATE_PERSON>
   and <PRIVATE_EMAIL> already reached the model.
   Full content: .interlinked/scanner/pending/<ts>.json (local-only)
```

**v2 behavior (opt-in):** `decision: "ask"` gated by `content_scanner.prompt_mode: "warn" | "ask" | "redact"`. The `redact` mode auto-substitutes placeholders in the prompt before it goes to the model — requires Claude Code `updated_input` support (which `HarnessDecision.updated_input` already models).

### Config additions

```ts
interface ContentScannerConfig {
  // ...
  scan_points: {
    // ...existing fields
    user_prompt: boolean; // default: true when the scanner is enabled
  };
  /** What happens on a user_prompt detection. Default: "warn" (don't block). */
  prompt_mode: "warn" | "ask" | "redact";
}
```

`redact` is a v2 stretch goal and is explicitly called out as experimental in the config doc.

## The race condition

UserPromptSubmit fires *after* the user hits Enter but *before* the agent receives the prompt. The scan runs on the harness socket. On a cold sidecar this can take 10+ seconds. During that window:

- The user is watching a blinking cursor wondering why nothing happened.
- If the scan fails open (timeout, sidecar crash), the prompt goes through with no warning.
- If the scan succeeds and decides "allow", the prompt goes through.
- If the scan succeeds and decides "warn", the prompt goes through *with* a warning displayed before the agent's first token.

v1 answer: block on the scan up to `scan_timeout_ms` (default 30s — already too long). On timeout, proceed silently. Operators who want better latency deploy the `server_hosted` runtime (warm model, ~100 ms).

v1 mitigation: print a subtle "🔍 scanning..." status line as soon as the scan starts so the user knows why there's a pause. Clear it when the decision lands.

## Files touched

| Path | Change |
|---|---|
| `src/harness/types.ts` | Add `user_prompt` to the `scan_points` type (already reflected in tests; wire the TS interface). Add `prompt_mode` to `ContentScannerConfig`. Add `prompt?: string` field to `HarnessEvent` if not already present. |
| `src/harness/evaluator/user-prompt.ts` | **New.** `evaluateUserPromptSubmit`. |
| `src/harness/evaluator.ts` | Re-export. |
| `src/harness/content-scanner/extractor.ts` | No-op — the evaluator builds the scan request directly since UserPromptSubmit has a simpler shape than tool calls. |
| `src/harness/server.ts` | Dispatch `UserPromptSubmit` events to the new evaluator; reuse the existing async scan block. |
| `src/harness/rules/default-config.ts` | Add `user_prompt: true` to `scan_points`; `prompt_mode: "warn"`. |
| `src/harness/content-scanner/__tests__/user-prompt.test.ts` | **New.** Covers enabled/disabled, toggle off, prompt-mode variants. |
| `.interlinked/hooks/interlinked-activity.mjs` (generator) | Verify UserPromptSubmit matcher is in the set Claude Code forwards. The generator in `src/lib/hooks.ts` may need an entry. |
| `docs/harness.md` | Add `user_prompt` row to the scan-points table, + a "Prompt-time scanning" section. |

Estimate: ~120 LOC source, ~150 LOC tests. A day with the UX check-in.

## Rollout

1. Ship with `prompt_mode: "warn"` default and `scan_points.user_prompt: false` default — opt-in only.
2. Dogfood for a week. Measure: (a) p50/p95 prompt-to-first-token latency hit, (b) warning-to-false-positive ratio.
3. Flip default to `scan_points.user_prompt: true` in a minor release once (b) is under 10%.
4. Land `prompt_mode: "ask"` and `"redact"` as separate v2 PRs, each with its own UX review.

## Verification

- **Unit**: the new evaluator emits `_contentScan` when enabled, honors the toggle, skips when no prompt field.
- **Integration**: extend the existing integration test with a `UserPromptSubmit`-event case asserting the scan request is attached with `hook: "user_prompt"` and the per-source part is `UserPromptSubmit.prompt`.
- **Manual**: enable the feature, paste a fake customer email into a prompt, verify the yellow warning appears in the next CLI output and the pending-prompt file is written.

## Open questions

- **Does Claude Code's `UserPromptSubmit` hook get called for `-p` one-shot prompts** (not just interactive REPL)? If so, same guard applies. If not, we need a second hook point.
- **Multi-turn prompts**: the scanner sees each turn in isolation. A conversation that dribbles PII across multiple prompts won't cross-reference. Session-level accumulation is a v3 concern.
- **Redact-mode UX**: showing the user what was auto-redacted is crucial — they need to see `<PRIVATE_EMAIL>` in their own terminal so they understand what the model will see. Design before implementation.
- **What if the user *intended* to send the PII** (e.g., legitimate customer-support workflow)? A per-session "I know what I'm doing, stop warning me" toggle covers this; ship it with the `redact` mode.
