# Local Runtime Quality Hooks: Assertion Density + Coverage Diff (revision 3)

Two locally-running quality signals that catch test-suite failure modes the harness's existing pipeline doesn't see. This is the third pass on the plan; previous revisions over-applied unrelated registration patterns and assumed APIs that don't exist. This pass is grounded against current source.

## Phase split

| Phase | Scope | Status |
|---|---|---|
| **1** | Assertion density check, plus a server.ts plumbing fix that surfaces behavioral check results to the agent. | Implementation-ready. |
| **2** | Coverage diff. Three sub-precursors plus two open design questions (artifact format, session-dir selection). | Design-in-progress; do not implement until the open questions resolve. |

## Codebase facts this plan respects

Verified by reading source. Each entry shaped a design decision below.

| Fact | Source | Plan implication |
|---|---|---|
| `CheckResultEntry.source` allows `"quality" \| "structural" \| "suggestion" \| "impact" \| "structure"` only | `src/harness/types.ts:209` | Behavioral checks reuse `source: "structural"`. |
| Existing behavioral checks return `source: "structural"`, `determinism: "heuristic"` | `src/harness/behavioral-checks.ts:41-46` | Convention to follow. |
| `runBehavioralChecks` results push into `allCheckResults` only, never into `postDecision.warnings` | `src/harness/server.ts:2200` (push) vs `:2257` (warnings → pending file) | **Existing behavioral checks are invisible to the agent today.** Phase 1 includes a small server.ts change to format behavioral results into warnings, following the `shotgun-surgery` pattern at `src/harness/server.ts:2117-2120`. |
| Recurrence API: `recordHarnessCaught({check_id, agent_source, session_id, file, message?, cwd?, ts?})` | `src/harness/recurrence.ts:251-259` | No `signature` or `context` fields. Use `check_id` for the check name. |
| `RecurrenceKind = "harness_caught" \| "harness_missed" \| "codebase_existing"` | `src/harness/recurrence.ts:10` | No `coverage_gap` kind. Use `harness_caught` with `check_id: "coverage_gap"` rather than inventing a kind. |
| Existing PostToolUse loop already auto-records every actionable `allCheckResults` row to recurrence | `src/harness/server.ts:2237-2252` | Adding to `allCheckResults` is sufficient for recurrence integration. No new wiring. |
| `proposeAction` returns a textual suggestion (`RecurrenceAction`) — does not auto-promote | `src/harness/recurrence.ts:166-188` | Drop "advisory → default → block ratchet" claims. The model is: aggregation surfaces patterns; users act on `interlinked recurrence propose` output manually. |
| `CHECK_REGISTRY.fn: (content, filePath) => InlineMatch[]` — stateless, no pre/post comparison | `src/harness/check-registry/types.ts:52-53` | A session-delta check (needs prior counts) cannot live in `CHECK_REGISTRY`. Drop the six-touchpoint registration. |
| Doc generator imports `STRUCTURAL_CHECK_META` and reads `quality_checks` from config; no behavioral path | `scripts/generate-docs.ts:16-17, 76, 109, 315-316` | "regen `quality-checks.md`" doesn't surface behavioral checks. Drop the claim. |
| `GuardRulesConfig` has no `assertion_density` field | `src/harness/types.ts:565-599` | Don't promise typed config in v1. Only add if helper opt-ins prove necessary during dogfood. |
| `PreEditBaseline` stores counts/sets, not line ranges | `src/harness/types.ts:533-555` | Phase 2 needs a new abstraction for changed lines. |
| Edit-region detection is local to `quality-checks.ts:640` | `src/harness/quality-checks.ts:640-657` | Phase 2 lifts this into a shared helper. |
| `tryTsgoRewrite` is block-and-answer (`spawnSync` + `decision: "block"`) | `src/harness/server-tsgo-bash.ts:60-79` | Original "rewrite" pattern was misread; not a precedent for letting modified commands through. |
| `HarnessDecision` carries `updated_input` only; adapters ignore it on allow paths | `src/harness/types.ts:134`, `src/harness/adapters/claude-code.ts:120` | Phase 2 cannot rely on transparent command rewriting without an adapter change (or a different strategy). |
| Hook fast-path skips harness for non-mutation PostToolUse | `src/lib/hooks-template.ts:825-844` | Phase 2 prerequisite: extend the fast-path filter to forward Bash test commands. |
| Tdd-exempt directive regex is private to `tdd-new-file-gate.ts` | `src/harness/evaluator/tdd-new-file-gate.ts:50` | Phase 1 needs an exported `hasTddExemptDirective(content)` helper to honor it consistently. |

---

## Phase 1: Assertion density + behavioral-warning plumbing fix

A regex check on PostToolUse Write/Edit of any test file. Compares prior `it()`/`test()` block count against `expect()`/`assert*()` call count. Fires when the agent added test blocks without adding assertions. Heuristic; warning severity.

This phase also fixes a gap caught in review: `runBehavioralChecks` results are recorded for recurrence but never surfaced as agent-visible warnings. The fix is one short block in `server.ts` and benefits every existing behavioral check (`checkRepeatedEditWithoutTest`, `checkSuppressionAsWorkaround`, `checkDomainSensitiveTestNudge`, `checkTddCycleViolation`, `checkTddRegression`, `checkTddGreenConfirmation`, `checkPersistentWarningEscalation`).

### Files to change

Tight list. The original plan inflated this with registry/docs entries that don't apply.

| File | Status | Purpose |
|---|---|---|
| `src/harness/types.ts` | edit | (a) Declare `AssertionCounts` immediately above `SessionTrajectory` (around `:765`). Declaring it here rather than in `behavioral-checks.ts` avoids an import cycle — `behavioral-checks.ts` already imports from `types.ts`. (b) Add `assertion_counts: Map<string, AssertionCounts>` to `SessionTrajectory`. |
| `src/harness/session-state.ts` | edit | Three coordinated changes — all three required to avoid a runtime crash: **(a)** Initialize `assertion_counts: new Map()` in `SessionTracker.recordEvent` at `:27` alongside the other field initializers (fresh-session path). **(b)** Add `assertion_counts: Object.fromEntries([...s.assertion_counts.entries()].map(([k, v]) => [k, { ...v }]))` to `serialize()` at `:185` (snapshot path — `<id>.live.json` and `<id>.trajectory.json` would silently lose the field otherwise). **(c)** Add `assertion_counts: readAssertionCountsMap(snapshot.assertion_counts)` to `hydrate()` at `:267`, with a small reader helper that returns an empty Map on missing/malformed input (defensive, matches the pattern of `readNumberMap` etc. already in the file). The hydration path is the load-bearing one — without it, on harness restart mid-session, `checkAssertionDensity`'s `session.assertion_counts.get(...)` will throw `Cannot read properties of undefined`. |
| `src/harness/behavioral-checks.ts` | edit | Add `checkAssertionDensity(session, filePath, content)` + `countAssertions` + `importedAssertNames` helpers. Imports `AssertionCounts` from `./types.js`. ~70 LOC. Does **not** modify `runBehavioralChecks`'s signature — see plumbing note below. |
| `src/harness/evaluator/tdd-new-file-gate.ts` | edit | Export `hasTddExemptDirective(content): boolean` so behavioral checks can honor the same convention without duplicating the regex. |
| `src/harness/server.ts` | edit | (a) Capture `fileContent` from the existing read at `:2185-2188` into a local rather than inlining; same I/O. (b) After the existing `runBehavioralChecks` call at `:2193`, add an **unconditional** `checkAssertionDensity(session, editedFilePath, fileContent)` call when `fileContent !== undefined`. The internal `TEST_FILE_RE` short-circuit (`behavioral-checks.ts:16`, module-private) handles the test-file gate — the call site doesn't need to duplicate the regex or import an `isTestFile` helper. (c) Replace the bulk `allCheckResults.push(...behavioralResults)` at `:2200` with a filter-first loop: walk results, skip ack-suppressed *warnings* (errors always fire per the `severity === "error" \|\| !isAcknowledged(...)` pattern at `server.ts:1615` / `:1924`), then push *only-shown* results into both `allCheckResults` *and* `postDecision.warnings`. Mirrors shotgun-surgery at `:2107-2127`. (d) Recurrence and effectiveness loops at `:2237-2252` then see only shown findings — no acknowledged-but-recorded drift. ~25 LOC delta. |
| **All typed `SessionTrajectory` fixtures across the codebase** | edit | Adding a required field to `SessionTrajectory` breaks every typed fixture that doesn't use a cast. At minimum update: `src/harness/__tests__/fixtures/evaluator.ts:21` (`makeSession()`), `src/harness/evaluator/active-when.test.ts:9`, `src/harness/evaluator/tdd-new-file-gate.test.ts`, `src/harness/server-tdd-cycle.test.ts`, `src/harness/__tests__/behavioral-checks.test.ts`, `src/harness/__tests__/active-skills.test.ts`, `src/harness/__tests__/supply-chain-defense.test.ts`, `src/harness/__tests__/feedback-effectiveness.test.ts`, `src/harness/__tests__/taint-tracker.test.ts`, `src/harness/__tests__/evaluator.test.ts`. Use `grep -rln 'tdd_cycles:\s*new Map' src --include='*.ts'` to enumerate the full set before the PR — one-line addition per file. Same treatment will apply to Phase 2's `dirty_lines`. |
| `src/harness/__tests__/server-warnings.test.ts` | new (or extend existing server tests) | Verify behavioral check results land in `postDecision.warnings` end-to-end **and** acknowledged-skipped findings do *not* land in `allCheckResults` (so recurrence doesn't count them). |

Notably absent: `check-registry/`, `check-metadata.ts`, `verify.ts`, `DEFAULT_ADVISORY_SKIPS`, `quality-checks.md` regen. Those are the static-check pipeline. This is a session-delta behavioral check, separate path.

### Detection (corrected)

```typescript
// src/harness/behavioral-checks.ts

import { stripCommentsAndStrings } from "./checks/shared.js";
import { hasTddExemptDirective } from "./evaluator/tdd-new-file-gate.js";
import type { AssertionCounts, SessionTrajectory, CheckResultEntry } from "./types.js";

// Matches plain `it(`, `test(`, `specify(` AND the chained variants vitest /
// jest expose: `.each`, `.only`, `.skip`, `.concurrent`, `.skipIf`,
// `.runIf`, `.todo`, `.failing`, `.sequential`. Also accepts the
// table-form `it.each([...])\`...\`(` so each tagged-template case counts
// as one block. Matching is on the call-site, not the chain — `.each`
// followed by `(...)` is one block; without that we'd miss every
// data-driven test in the repo.
const TEST_BLOCK_RE =
  /\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*(?:\([^)]*\)\s*)?\(\s*['"`]/g;

// Default regex stays narrow on purpose — bare `ok(`, `match(`, `equal(`,
// `fail(` would false-positive on jQuery's `.match()`, lodash's `_.equal`,
// business-logic helpers, etc. The detector below adds named-import
// awareness for `node:assert` so projects using it via named imports get
// proper credit.
//
// Covers without import-detection:
//   - Vitest / Jest: expect(x).toX()
//   - Chai (qualified): chai.assert.X(), should.X()
//   - Sinon (qualified): sinon.assert.X()
//   - Node:assert (qualified): assert(...) and assert.X(...)
//   - Snapshot: toMatchSnapshot, toMatchInlineSnapshot
const ASSERTION_RE =
  /\b(?:expect|assert|chai\.assert|should\.|sinon\.assert|toMatchSnapshot|toMatchInlineSnapshot)\s*[(.]/g;

// Names that are unambiguous as Node:assert calls only when imported from
// `node:assert` / `assert`. Detected from the import statement, then matched
// in the body. Drops the bare-name FP risk.
const NODE_ASSERT_NAMES = [
  "strictEqual",
  "deepStrictEqual",
  "notStrictEqual",
  "notDeepStrictEqual",
  "deepEqual",
  "notEqual",
  "ifError",
  "doesNotThrow",
  "doesNotMatch",
  "throws",
  "rejects",
  "fail",
  "match",
  "ok",
  "equal",
] as const;

const NODE_ASSERT_IMPORT_RE =
  /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"](?:node:)?assert(?:\/strict)?['"]/g;

function importedAssertNames(content: string): Set<string> {
  const out = new Set<string>();
  NODE_ASSERT_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null = NODE_ASSERT_IMPORT_RE.exec(content);
  while (m !== null) {
    for (const raw of m[1].split(",")) {
      // Handle `strictEqual as eq` rename — credit the local binding.
      const local = (raw.split(/\s+as\s+/i)[1] ?? raw).trim();
      if (local && NODE_ASSERT_NAMES.includes(local as (typeof NODE_ASSERT_NAMES)[number])) {
        out.add(local);
      } else if (local) {
        // Renamed binding — count it too if its source name was in the set.
        const src = raw.split(/\s+as\s+/i)[0]?.trim();
        if (src && NODE_ASSERT_NAMES.includes(src as (typeof NODE_ASSERT_NAMES)[number])) {
          out.add(local);
        }
      }
    }
    m = NODE_ASSERT_IMPORT_RE.exec(content);
  }
  return out;
}

export function countAssertions(rawContent: string): AssertionCounts {
  // Strip comments + strings so a comment that mentions `expect(` or a
  // string containing `assert.ok(` doesn't inflate counts. Shared helper
  // already handles TS / JS quoting nuances.
  const stripped = stripCommentsAndStrings(rawContent);

  TEST_BLOCK_RE.lastIndex = 0;
  ASSERTION_RE.lastIndex = 0;

  const blocks = (stripped.match(TEST_BLOCK_RE) || []).length;
  let assertions = (stripped.match(ASSERTION_RE) || []).length;

  // Named-import credit — only for names actually imported from node:assert.
  // Use the *raw* content for import detection (strip can mangle import
  // specifier strings); use the *stripped* content for call-site matching.
  const named = importedAssertNames(rawContent);
  if (named.size > 0) {
    const namedRe = new RegExp(`\\b(?:${[...named].join("|")})\\s*\\(`, "g");
    assertions += (stripped.match(namedRe) || []).length;
  }

  return { blocks, assertions };
}

export function checkAssertionDensity(
  session: SessionTrajectory,
  filePath: string,
  content: string,
): CheckResultEntry | null {
  if (!TEST_FILE_RE.test(filePath)) return null;
  if (hasTddExemptDirective(content)) return null;

  const after = countAssertions(content);
  const before = session.assertion_counts.get(filePath);

  // Always refresh the cache — every visit becomes the new baseline for the
  // *next* edit's delta.
  session.assertion_counts.set(filePath, after);

  // First time we see this file in the session: silently establish baseline.
  // We have no reliable way to distinguish "agent just wrote this brand-new
  // test file with no assertions" from "agent edited a pre-existing
  // assertion-free test file" — PostToolUse runs after the write applies,
  // and `session.files_written` only tells us first-write-this-session, not
  // brand-new-on-disk. Firing on `before === undefined` would false-positive
  // on every pre-existing assertion-free test the agent touches.
  //
  // Trade-off: we miss the literal "agent created a new test file with zero
  // assertions" case until the agent re-edits it. Mutation testing (Plan 10)
  // catches it asynchronously. `tdd_new_file_gate` does NOT — it exempts
  // test files (gate.ts:35-48) since its job is to demand companion tests
  // for new SOURCE files, not police the test files themselves.
  if (before === undefined) return null;

  const dBlocks = after.blocks - before.blocks;
  const dAssertions = after.assertions - before.assertions;

  // Only fire when blocks grew and assertions did not.
  if (dBlocks > 0 && dAssertions <= 0) {
    const assertionPart =
      dAssertions === 0
        ? "0 new assertions"
        : `${-dAssertions} fewer assertion${-dAssertions === 1 ? "" : "s"}`;
    return {
      source: "structural",
      name: "assertion_density",
      severity: "warning",
      message: `Added ${dBlocks} test block(s) with ${assertionPart}. Each it()/test() block typically needs at least one expect()/assert*() call.`,
      file: filePath,
      determinism: "heuristic",
    };
  }

  return null;
}
```

Two intentional simplifications relative to earlier revisions:

1. **No `prevContent` parameter.** The harness can't reliably reconstruct pre-edit content for Write/MultiEdit/apply_patch. Instead, cache prior `AssertionCounts` per file on the session — much smaller (two numbers vs full content) and avoids the reconstruction problem.
2. **No typed config.** `assertion_density.helpers` is a future addition only if dogfood reveals real custom-helper FPs. Inline regex first; add config later if warranted.

**The accepted blind spot, stated honestly**: the check is purely *delta-based*. The first edit of any test file in a session establishes baseline and is silent — including new files the agent just created with zero assertions. The check fires from the second same-session edit onward, when an agent adds an `it()` block without an accompanying assertion. We deliberately give up the brand-new-file signal to avoid false-positives on pre-existing assertion-free tests. Plans 10 (mutation testing) and `tdd_new_file_gate` cover the new-file failure mode from different angles.

### Server.ts plumbing fix (filter-first; recurrence consistency)

The current behavioral-check block has two issues this plan must fix together:

1. Behavioral results push into `allCheckResults` at `:2200` but never reach `postDecision.warnings`, so the agent never sees them. The pending-output writer at `:2257` only reads `postDecision.warnings`.
2. The recurrence loop at `:2237-2252` walks `allCheckResults` to record `harness_caught` rows. If we push acknowledged-skipped findings into `allCheckResults`, recurrence treats them as if they were shown — drifting the count and tripping ratchet thresholds incorrectly.

The fix is one filter-first loop replacing the bulk push. Match the shotgun-surgery pattern at `:2107-2127`: only-shown findings go into both `allCheckResults` and `postDecision.warnings`.

**Replace** the existing block at `server.ts:2193-2200`:

```typescript
const behavioralResults = runBehavioralChecks(
  session,
  editedFilePath,
  allCheckResults,
  previousSuppressionCount,
  currentSuppressionCount,
);
allCheckResults.push(...behavioralResults);  // unconditional — the bug
```

**With** a content-aware variant that calls `checkAssertionDensity` directly and filters acknowledged findings out before recording:

```typescript
const behavioralResults = runBehavioralChecks(
  session,
  editedFilePath,
  allCheckResults,
  previousSuppressionCount,
  currentSuppressionCount,
);

// Phase 1 addition: assertion density needs file content. Reuse the read
// already happening at :2185-2188 for suppression count rather than reading
// twice.
//
// `fileContent` here is the same string that `countSuppressionDirectives`
// just ran against — captured into a local at :2185 so we don't double-read.
//
// No `TEST_FILE_RE` gate at the call site: the regex is module-private to
// behavioral-checks.ts (`:16`) and not exported, and `checkAssertionDensity`
// already short-circuits internally on its own test-file check. Calling
// unconditionally is cheap (one regex test on the path string) and saves us
// from either exporting an `isTestFile` helper or duplicating the regex.
if (fileContent !== undefined) {
  const r = checkAssertionDensity(session, editedFilePath, fileContent);
  if (r) behavioralResults.push(r);
}

// Filter-first: only push shown results into allCheckResults so recurrence
// and effectiveness loops don't see acknowledged-skipped findings.
//
// Errors bypass the ack check by design — match the structural-check
// pattern at server.ts:1615 / :1924 (`r.severity === "error" ||
// !isAcknowledged(...)`). Acknowledging an error is treated as "I saw it";
// it should still surface until actually fixed. Only warnings are
// suppressible by ack.
if (behavioralResults.length > 0 && editedFilePath) {
  if (!postDecision.warnings) postDecision.warnings = [];
  for (const r of behavioralResults) {
    if (r.severity !== "warning" && r.severity !== "error") {
      // Info-level — record but don't surface. Match existing pipeline.
      allCheckResults.push(r);
      continue;
    }
    const shouldShow =
      r.severity === "error" || !isAcknowledged(session, editedFilePath, r.name);
    if (!shouldShow) continue;

    allCheckResults.push(r);
    const tag = r.determinism === "fully_deterministic" ? "[proven]" : "[heuristic]";
    postDecision.warnings.push(`${tag} ${r.name}: ${r.message}`);
  }
}
```

The existing block at `:2218-2227` continues to call `acknowledgeChecks` for warning-level results in `allCheckResults` — now correctly limited to results actually shown.

The file-content read at `:2185-2188` already runs unconditionally for suppression counts; capture its output into a `fileContent` local instead of inlining the read. Roughly: `let fileContent: string | undefined; if (existsSync(editedFilePath)) { fileContent = readFileSync(editedFilePath, "utf-8"); currentSuppressionCount = countSuppressionDirectives(fileContent); }`. No new I/O.

Side effect: warning- and error-severity behavioral checks become agent-visible — `checkRepeatedEditWithoutTest`, `checkSuppressionAsWorkaround`, `checkDomainSensitiveTestNudge`, `checkTddCycleViolation`, `checkTddRegression` (error), `checkPersistentWarningEscalation` (error). The info-severity ones (`checkTddGreenConfirmation`) continue to skip the warning surface per the snippet's `if (r.severity !== "warning" && r.severity !== "error")` guard — they only land in `allCheckResults`. Worth flagging in the PR description; dogfood window will reveal any warning/error checks that were inadvertently relying on invisibility.

### Testing

| Case | Expectation |
|---|---|
| First sight of any test file (incl. brand-new file with no assertions) | Silent — establishes baseline only |
| Same session, 2nd edit adds 3 blocks + 3 expects | Silent |
| Same session, 2nd edit adds 3 blocks + 0 expects | Fires |
| Same session, 2nd edit adds 0 blocks + 5 expects | Silent |
| Same session, 2nd edit removes 2 expects, adds 1 block | Fires (`-2 fewer assertions`) |
| Source file (non-test) edit | Silent |
| File with `// interlinked-tdd: exempt` | Silent |
| Test using `node:assert.strictEqual` (named import) | Counts as assertion |
| Test using `chai.assert.deepEqual` | Counts as assertion |
| Snapshot-only test (`toMatchSnapshot()`) | Counts as assertion |
| `describe()` block alone (no `it()`) | Silent |
| Hydrated session (harness restart mid-session) preserves `assertion_counts` | Integration test against `serialize`/`hydrate` round-trip |
| End-to-end: behavioral result lands in `postDecision.warnings` with `[heuristic]` prefix | Integration test |
| Within a single edit, a fired result is *not* re-recorded if `isAcknowledged` returns true | Integration test |
| Across two edits to the same file, the warning may re-fire — `SessionTracker.recordEvent` clears acks at `session-state.ts:147` on each write so genuinely persistent issues stay visible | Integration test (assert re-fire is allowed) |

### Performance

Two regex passes on test-file post-edit content. 100µs–1.5ms for typical-to-large test files. Source-file edits short-circuit on `TEST_FILE_RE.test`. Marginal; in the noise relative to existing PostToolUse cost.

### Failure modes

| Failure | Mitigation |
|---|---|
| Custom assertion helpers not detected | Document the supported regex set; add helper config in a follow-up iff dogfood shows real FPs. |
| Whole-file rewrite that preserves counts | Accepted FN (silent). Mutation testing (Plan 10) catches what density misses. |
| First-sight-of-any-test-file blind spot (incl. brand-new files) | Accepted by design; the check is delta-only. Second same-session edit catches the failure mode. **`tdd_new_file_gate` does NOT cover this case** — it explicitly exempts `.test.tsx?` / `.spec.tsx?` / `__tests__/` paths at `evaluator/tdd-new-file-gate.ts:35-48` (`EXEMPT_PATH_RES`), since its job is to demand a companion test for a new source file, not to police the test file itself. The brand-new-assertion-free-test-file case is currently uncaught at the harness level until the agent re-edits. Plan 10 (mutation testing) catches it asynchronously. If dogfood shows this is a frequent real failure mode, follow-up work is a separate first-write-test-file check (e.g., `checkBrandNewTestFile` keyed off `event.tool_name === "Write" && !session.files_written.has(filePath)` at PreToolUse-baseline-capture time, where the harness *can* know the file didn't exist before). Out of scope for v1. |
| Helper convention divergence with TDD-exempt | Phase 1 exports `hasTddExemptDirective` from `tdd-new-file-gate.ts`; both checks use the same regex. |
| Behavioral plumbing fix unintentionally surfaces some legacy check that was never meant to fire | Dogfood window; if any noise appears, demote that check via existing `acknowledgeChecks` patterns. |

### Acceptance criteria

| Criterion | Verification |
|---|---|
| First-edit-of-test-file is silent (baseline only); second same-session edit that adds blocks without assertions produces a `[heuristic] assertion_density` warning visible to the agent | Manual: two-edit session on `src/foo.test.ts` |
| Existing warning/error-severity behavioral checks (`checkRepeatedEditWithoutTest`, etc.) now appear in `postDecision.warnings`; info-level `checkTddGreenConfirmation` continues to be silent | Manual on a contrived session |
| Per-edit p99 latency unchanged | Bench |
| Recurrence rows for `assertion_density` appear via `interlinked recurrence list` | Manual after dogfood |
| `interlinked recurrence propose` for a recurring `assertion_density` row returns a textual ratchet suggestion | Manual |
| FP rate over a week of dogfooding stays below the existing harness baseline | Track. **If exceeded, demotion path is a code-level change**: either remove the direct `checkAssertionDensity` call from `server.ts` (full disable) or wrap it in a per-rule severity downgrade. There is no typed config for this check in v1 — `GuardRulesConfig` (`types.ts:565`) doesn't have an `assertion_density` field, and we deliberately defer adding one until dogfood proves it's needed. Demoting is therefore a one-line PR, not a config knob. The acceptance criterion is "we're prepared to delete the call if it's noisy," not "we have a switch." |

---

## Phase 2: Coverage diff (design in progress)

Phase 2 is **not implementation-ready**. The prior revision claimed it was; review surfaced two structural gaps that need design decisions before code lands. This section sketches the architecture and lists the open questions; treat each "OPEN" entry as a blocker for implementation start.

### What's settled

#### 2.0 — Bash PostToolUse delivery

Same as the previous revision and still right. Two file changes:

- `src/harness/adapters/claude-code.ts:112` and `src/harness/adapters/codex.ts:62`: extend the PostToolUse matcher regex to include `Bash`.
- `src/lib/hooks-template.ts:825-844`: extend the fast-path predicate so Bash commands matching a Node-test runner pattern fall through to the harness rather than fast-pathing.

The fast-path filter:

```typescript
// Node-only because NODE_V8_COVERAGE / vitest --coverage are Node-specific.
// `npm test` and `npm run test` resolve to whatever the project defines;
// most TS projects' npm test is `vitest run`, so we forward optimistically
// and let the harness re-check on its side.
const NODE_TEST_BASH_RE =
  /\b(?:npx\s+)?(?:vitest|jest|mocha|node\s+(?:--test|--experimental-test-runner))\b|\bnpm\s+(?:run\s+)?test\b|\bpnpm\s+(?:run\s+)?test\b|\byarn\s+(?:run\s+)?test\b/;

const isHarnessRelevantBash =
  postToolName === "Bash" &&
  hookEvent === "PostToolUse" &&
  NODE_TEST_BASH_RE.test((rawInput.tool_input?.command as string) || "");
```

The pattern intentionally over-matches `npm test` (could resolve to a non-Node script) — the harness re-confirms on receipt and no-ops on miss. Cheaper than missing real test runs.

Pytest, cargo-test, go-test are explicitly excluded. Per-language support is a separate plan.

#### 2.1 — Lift `computeEditRegion` into a shared helper

Lift the line-range computation currently embedded in `quality-checks.ts:640-657` into `src/harness/edit-region.ts`. Existing caller refactored to use the helper. Pure refactor; behavior-equivalent.

The helper signature:

```typescript
export interface EditRegion {
  startLine: number;
  endLine: number;
}

export function computeEditRegion(
  event: HarnessEvent,
  postEditContent: string,
): EditRegion | null;
```

Returns `null` when the heuristic can't resolve a region (Bash edit, MultiEdit with multiple non-contiguous targets, Write of a brand-new file — caller treats this as "all lines dirty").

#### 2.1.b — `dirty_lines` shape + per-line de-dup state (corrected)

Two prior errors were entangled here. The first revision used one `edited_at` per file, which can't represent lines edited at different times. The second revision keyed de-dup on `${filePath}:${ln}:${runTs}`, which means every new test run mints a new key and duplicate recurrence rows still append. Both fixed:

```typescript
// In SessionTrajectory (in types.ts, alongside Phase 1's assertion_counts):
export interface DirtyLineEntry {
  edited_at: number;            // ms since epoch — when this line was last edited
  recorded_uncovered: boolean;  // de-dup flag — see below
  /**
   * The end timestamp of the test run that recorded this line as uncovered.
   * Set when `recorded_uncovered` flips to true; remains until the entry
   * is overwritten (re-edit) or deleted (line covered). Powers the
   * "lines you edited aren't covered by the most recent test run" message
   * — without it, the surfacing layer can't honestly state run timing.
   */
  last_uncovered_run_ended_at?: number;
}

dirty_lines: Map<string /* abs file path */, Map<number /* line number */, DirtyLineEntry>>;
```

Phase 2 needs the same three-step session-state treatment as Phase 1's `assertion_counts`, **plus** a separate field for run-start timestamps (see #### 2.1.c below).

| `src/harness/session-state.ts` | edit | (a) Init `dirty_lines: new Map()` *and* `test_runs_in_flight: new Map()` in `recordEvent` at `:27`. (b) Serialize both in `serialize()` at `:185`. (c) Hydrate via new `readDirtyLines` and `readTestRunsInFlight` readers in `hydrate()` at `:267` (defensive, return empty Maps on missing/malformed input). Same load-bearing reason as `assertion_counts`: without hydration, daemon restart mid-session loses tracker state and the surfacing layer goes silent on previously-recorded gaps. |
| **All typed `SessionTrajectory` fixtures** | edit | Same enumeration as Phase 1; add `dirty_lines: new Map()` and `test_runs_in_flight: new Map()` to each. Land coordinated with Phase 2's main PR. |

#### 2.1.c — Run-start timestamp (`test_runs_in_flight`)

The surfacing flow above relies on `T2`, the test-run *start* timestamp, to gate which dirty lines were truly editable-before-the-run (`entry.edited_at < T2`). The existing `SessionTrajectory.test_runs` (`types.ts:822-823`) is shaped `Map<filePath, { status: "pass" | "fail"; at_step: number }>` — captured at PostToolUse, no start timestamp. There's no source for `T2` today.

Fix: a new in-flight map populated at PreToolUse and consumed at PostToolUse.

```typescript
// In SessionTrajectory:
export interface InFlightTestRun {
  started_at: number;       // ms — captured at PreToolUse Bash for the test command
  command: string;          // raw command string (for debugging / target inference)
  target_file?: string;     // resolved via detectTestRunFile() if pinpointable; else undefined
}

test_runs_in_flight: Map<string /* tool_use_id (when available) else command-hash */, InFlightTestRun>;
```

Lifecycle:

```
[PreToolUse Bash with NODE_TEST_BASH_RE match]
  → key = event.tool_use_id ?? hashCommand(event.tool_input.command)
  → session.test_runs_in_flight.set(key, {
      started_at: Date.now(),
      command: event.tool_input.command,
      target_file: detectTestRunFile(...) ?? undefined,
    })
  → allow

[PostToolUse Bash — same tool_use_id / command]
  → key = event.tool_use_id ?? hashCommand(...)
  → const inFlight = session.test_runs_in_flight.get(key)
  → if not found: T2 = T3 - 100ms (best-effort fallback; record warning)
  → else: T2 = inFlight.started_at
  → continue with the test-run handler in the surfacing flow
  → session.test_runs_in_flight.delete(key)   // free state
```

Two notes:

- **Key choice**: `tool_use_id` is the canonical key when the agent platform provides one (Claude Code, Codex, copilot all do). The command-hash fallback handles platforms that don't, accepting that two simultaneous identical test commands can collide — rare; not worth more invariant-machinery in v1.
- **Fallback when start is missing**: if PostToolUse arrives without a matching in-flight entry (PreToolUse hook crashed, daemon restarted between Pre and Post), default `T2 = T3 - 100ms` and emit a one-line warning. Accuracy degrades to "lines edited <100ms before the run completed are excluded"; in practice the agent doesn't edit a file in that window anyway, so the practical FP rate stays near zero.

The `recorded_uncovered` flag is the de-dup mechanism: once a line has been recorded as uncovered (via `recordHarnessCaught`) for the *current* `edited_at`, subsequent test runs that fail to cover the same line no-op — they don't re-record. The flag implicitly de-dups by `(filePath, line, edited_at)` because:

- Re-running tests without re-editing → same entry, flag set, no-op.
- Re-editing the line → the update step at line 350-ish overwrites the entry with a fresh `edited_at` and `recorded_uncovered: false`, so the next failing run records again. That's correct: a new edit is a new "the test should have caught this" event.
- Test run covers the line → `dirty_lines.get(file).delete(line)` removes the entry entirely; future scans don't see it; if the agent edits the line again, a brand-new entry is created.

No separate `Set<string>` is needed. The live map is the de-dup state.

Update on every PostToolUse Write/Edit/MultiEdit/apply_patch:

```typescript
const region = computeEditRegion(event, postContent);

// Resolve the line range to mark dirty. When computeEditRegion returns
// null (Write of a brand-new file, MultiEdit with non-contiguous targets
// in the same file, Bash edit, apply_patch we can't pin), fall back to
// "all lines of the post-edit content." Earlier draft only mutated
// `if (region)`, which silently dropped brand-new writes — exactly the
// case where every line is freshly dirty.
let startLine: number;
let endLine: number;
if (region) {
  startLine = region.startLine;
  endLine = region.endLine;
} else {
  startLine = 1;
  endLine = postContent.split("\n").length;
}

let perFile = session.dirty_lines.get(filePath);
if (!perFile) {
  perFile = new Map();
  session.dirty_lines.set(filePath, perFile);
}
const now = Date.now();
for (let ln = startLine; ln <= endLine; ln++) {
  // Re-edit resets recorded_uncovered: a new edit is a new "the test
  // should have caught this" event and should be allowed to record again.
  perFile.set(ln, { edited_at: now, recorded_uncovered: false });
}
```

The "all lines" fallback is honest about uncertainty: when we can't pin the edit region, we don't know which specific lines are new, so we treat every line as a fresh edit. The next test run that doesn't cover line N will record that gap — not a false-positive, just a coarser claim.

#### 2.1.d — Known limitation: line-number staleness across edits

`dirty_lines` keys are raw post-edit line numbers at the moment of capture. A later edit that inserts/deletes lines *above* a dirty entry shifts the actual code on disk but does not shift the stored line number. The surfacing message can then point at a stale line ("lines [42, 47] not covered" — but after a 5-line insertion above, those lines are now at 47 and 52).

Three options to address this, in order of cost:

1. **Accept the staleness for v1.** The warning still names the file and the original edited lines; the agent can read the file and find the actual code. Acceptable as long as the staleness window is short (single-session usage, no multi-day persistence).
2. **Track per-edit insert/delete offsets** and shift dirty entries above each edit's start line. Doable from `event.tool_input.old_string` / `new_string` (the line-count delta is `newLines - oldLines` and the offset is the matched-prefix line). Adds bookkeeping to every PostToolUse Write/Edit; bounded cost.
3. **Replay-the-line-on-read.** When surfacing, search for the original line's content (cached at capture time) in the current file. Heuristic; brittle when the agent rewrites the line.

**v1 chooses option 1.** Phase 2.b can add option 2 if dogfood shows real confusion. The plan does not promise line accuracy after subsequent edits, and the warning text should *not* claim "currently at line N" — it claims "lines you edited" which is locally true at edit time and degrades gracefully.

Per-line timestamps make the post-test-run intersection precise: we only flag a line as `coverage_gap` if its edit timestamp predates the test run's start, i.e., the line was already there when the tests ran.

### What's open (blocks implementation)

#### OPEN 2.A — Coverage artifact format

Two distinct artifacts, with different properties, were conflated in the prior revision:

| Artifact | Shape | Pros | Cons |
|---|---|---|---|
| **`NODE_V8_COVERAGE` raw dumps** | Per-process JSON of v8 block-level counters; one file per worker | Works across any Node test runner; framework-agnostic; native; near-zero overhead | We have to walk source maps ourselves; merging multi-process dumps is non-trivial; dependency on `convert-source-map` + `source-map` |
| **Vitest `--coverage` report** | Processed JSON (`coverage-final.json` or v8 reporter output); already source-mapped | Easier to consume; vitest does the work | Vitest-specific; doesn't help for jest / mocha / node:test; users must run with `--coverage` flag (or have vitest config emit it) |

The prior plan tried to use NODE_V8_COVERAGE *and* vitest's coverage report interchangeably. They are not interchangeable. Plan 2 must pick one.

**Tentative direction (still open)**: vitest coverage report only in v1, gated on the project being a vitest project (detected by `vitest.config.*` presence). Jest / mocha / node:test users get nothing from coverage in v1. Per-runner support added in follow-on plans.

**Decision needed before implementation**: confirm vitest-only is acceptable, or commit to NODE_V8_COVERAGE as the universal artifact and budget the source-map work.

#### OPEN 2.B — Session-coverage-dir selection

How does the test runner know to emit coverage to a session-scoped directory? Three options, none fully clean:

| Option | Mechanism | Issue |
|---|---|---|
| **Static config** | `interlinked coverage init` writes `vitest.config.ts` with `coverage.reportsDirectory: ".interlinked/cov/last"` (no session id). | Loses cross-session isolation; concurrent sessions clobber each other. Acceptable for single-developer repos; broken for multi-agent. |
| **Env-var-driven config** | `vitest.config.ts` reads `process.env.INTERLINKED_SESSION_ID` and uses it in the path. | Requires the env var to reach the spawned vitest process. Hook can't set env on agent-spawned subprocesses without an `updated_input` adapter change (currently ignored on allow paths — see Plan 08 dep). |
| **Out-of-band rotation** | Always emit to `.interlinked/cov/last`; harness moves it to `.interlinked/cov/<session>` on receipt. | Race between vitest finishing the write and harness reading; needs a sentinel-file convention. |

**Tentative direction (still open)**: Option 1 (static config, no session scoping) for v1, accepted as a single-session limitation. Multi-session isolation is a Phase 2.b problem, gated on `updated_input` plumbing through adapters (which depends on Plan 08).

**Decision needed before implementation**: confirm single-session is acceptable for v1, or commit to one of the other options.

### Recurrence integration (corrected)

Use the existing `recordHarnessCaught` API (`recurrence.ts:251-259`) — no new kind. The check name carries the semantics:

```typescript
recordHarnessCaught({
  check_id: "coverage_gap",
  agent_source: event.agent_source ?? "unknown",
  session_id: event.session_id,
  file: relative(CWD, filePath),
  message: `Lines [${uncovered.join(", ")}] not covered by test run completed at ${runEndedAt}`,
  cwd: CWD,
});
```

`proposeAction` then returns a `RecurrenceAction` describing a ratchet suggestion when this check_id recurs across sessions. Users surface that via `interlinked recurrence propose coverage_gap` and decide whether to ratchet manually. **There is no automatic promotion** — drop that claim from the plan.

### Surfacing flow (when 2.A and 2.B resolve)

**Single user-facing surface: PostToolUse Edit on the affected file.** Earlier drafts double-surfaced (warn at test-run-completion *and* warn on next edit) which produced noise without a "consumed" model. This revision picks the next-edit surface as primary because:

- The agent rarely edits during/right-after a test run; the next-edit moment is when they're actually working on the file and can act.
- It composes with the existing PostToolUse Edit warning channel (no new hook surface).
- It naturally de-duplicates via the same `acknowledgeChecks` flow Phase 1 uses.

The test-run-completion handler does *not* push to `postDecision.warnings`. It only writes durable state (the recurrence row + per-line tracking). The agent sees it on the next edit.

A "consumed/resolved" state on the dirty-line tracking handles the inverse path — once a previously-dirty line is covered by a subsequent test run, drop it from the tracker so we stop warning about it.

**Source of truth for "uncleared" is `session.dirty_lines`, not `recurrences.jsonl`.** `recordHarnessCaught` stores only `{check_id, agent_source, session_id, file, message}` (`recurrence.ts:251-259`) — there's no structured per-line state in the recurrence row. The JSONL is append-only and computed on demand. So the live session map is the only place that knows "is this line still uncovered right now." Recurrence is for cross-session aggregation; live state is for the current session's surfacing.

```
[Edit src/foo.ts at T1]
  → PostToolUse hook (Edit, reachable today)
  → computeEditRegion → lines [42-49] (or null → mark all lines dirty)
  → STEP A (surface FIRST, before mutating): consult the *existing*
    session.dirty_lines["foo.ts"] for any line in the edit's region where
    recorded_uncovered === true:
      → if any: emit `[heuristic] coverage_gap: lines [...] you edited
        weren't covered by the test run that ended at
        ${last_uncovered_run_ended_at}` — the timestamp comes from the
        DirtyLineEntry, set by the test-run handler below. Without it the
        message can't honestly claim "most recent" — multiple lines may
        have been recorded across different runs.
      → push to postDecision.warnings ONLY (NOT to allCheckResults — see
        "Recurrence write paths" below for why this matters).
  → STEP B (then mutate): for ln in 42..49:
      session.dirty_lines["foo.ts"].set(ln,
        { edited_at: T1, recorded_uncovered: false })
    The order matters — overwriting first would clobber the very evidence
    we're surfacing. Step A reads, Step B writes. Re-edits in scope reset
    `recorded_uncovered` to `false` so the next failed test run can record
    a fresh row for the new edit timestamp.

[Bash: vitest at T2 > T1]
  → PreToolUse hook → allow (no rewrite — see OPEN 2.B)

[Bash completes at T3]
  → PostToolUse Bash hook (reachable via 2.0)
  → harness reads coverage artifact (per OPEN 2.A)
  → no agent-visible warning here. Just durable state updates:
      for each (filePath, perLineMap) in session.dirty_lines:
        for [ln, entry] in perLineMap:
          if entry.edited_at >= T2: continue       // edit during/after run, skip
          if covered(filePath, ln):
            perLineMap.delete(ln)                  // line now covered → clear
            continue
          if entry.recorded_uncovered: continue    // already recorded for this edit_at
          recordHarnessCaught({ check_id: "coverage_gap",
                                agent_source, session_id, file, message, cwd })
          entry.recorded_uncovered = true          // de-dup mark on the live entry
          entry.last_uncovered_run_ended_at = T3   // power the next-edit message

[Next Edit on foo.ts at T4]
  → PostToolUse hook (Edit) — same surface as the T1 edit above.
  → re-edit of any line in the dirty region overwrites its entry to
    { edited_at: T4, recorded_uncovered: false }, allowing the next failing
    test run to record again (correct: a new edit is a new opportunity for
    tests to catch it).
```

Three load-bearing details:

- **Timing guard**: `entry.edited_at < T2` means the edit happened *before* the test run started — the run *should have* covered the line if the test suite were faithful.
- **De-dup guard**: the `recorded_uncovered` flag on each `DirtyLineEntry` (described in 2.1.b) is the de-dup state. Re-running tests N times without re-editing produces at most one recurrence row per (file, line, edit). Re-editing resets the flag, allowing a new row on the next failed run. Coverage clears the entry entirely. The append-only `recurrences.jsonl` doesn't need cleanup — aggregation is computed on demand and old rows naturally age out of relevance once the agent moves on.
- **Recurrence write paths — exactly one.** The test-run handler is the *only* place that calls `recordHarnessCaught({ check_id: "coverage_gap" })`. The next-edit surfacing layer (STEP A above) pushes its warning into `postDecision.warnings` *only*, NOT into `allCheckResults`. This matters because the existing PostToolUse loop at `server.ts:2237-2252` walks `allCheckResults` and writes a `harness_caught` row for every actionable entry — if STEP A pushed `coverage_gap` into `allCheckResults`, every subsequent edit would re-record the same finding, and `interlinked recurrence list` counts would inflate without bound. Implementation note: STEP A constructs the warning string directly via `postDecision.warnings.push(...)` rather than using a `CheckResultEntry` shape. Phase 1's filter-first plumbing only auto-pushes to `allCheckResults` when a `CheckResultEntry` exists — STEP A's "remind only" surface bypasses that path by not creating one. Verified at write time: a unit test asserts that two consecutive `coverage_gap`-bearing edits produce one and only one new line in `recurrences.jsonl`.

### Phase 2 acceptance criteria (when implementation starts)

| Criterion | Verification |
|---|---|
| OPEN 2.A and 2.B have a documented, agreed resolution | Plan revision pinning the choice |
| Bash PostToolUse for `vitest`, `jest`, `mocha`, `node --test`, `npm test`, `npm run test`, `pnpm test`, `yarn test` reaches the harness | `interlinked harness test` fixtures |
| Non-test Bash continues to fast-path; per-edit p99 unchanged | Bench |
| `dirty_lines` populates correctly across Edit / Write / MultiEdit / apply_patch | Unit |
| Lines covered by a subsequent test run get cleared from `dirty_lines` | Unit |
| `recordHarnessCaught` written exactly once per `(file, line, edited_at)` triple — re-runs without re-editing don't double-record | Unit |
| Re-editing a line resets `recorded_uncovered`, so the next failing run can record a fresh row | Unit |
| Warning fires on next Edit when any line in the edit's region has `recorded_uncovered === true` in `session.dirty_lines` | Integration |
| Surfacing reads from `session.dirty_lines`, not `recurrences.jsonl` (which has no structured line state) | Code review |
| Pytest / cargo-test / go-test commands are silently no-ops; no NODE_V8_COVERAGE / vitest coverage attempt | Manual |

---

## Cross-cutting

### Determinism per check

| Check | Determinism | Severity | Default tier |
|---|---|---|---|
| `assertion_density` | `heuristic` | `warning` | default |
| `coverage_gap` | `heuristic` | `warning` | default if Phase 2 ships clean. Demotion path same as `assertion_density`: code-level — drop or downgrade the call in `server.ts`. Typed config (`rules.coverage_gap?.enabled`) only if dogfood proves a real need. |

Both render with `[heuristic]` prefix per `quality-checks.ts::classifyDeterminism`.

### Build order

1. **Phase 1 standalone PR.** Behavioral check + server.ts plumbing fix + tests.
2. **Resolve OPEN 2.A and 2.B.** Plan revision documenting the chosen artifact and dir-selection strategies.
3. **Phase 2 prerequisite PRs (independently shippable):**
   - 2.0 hook delivery change.
   - 2.1 lift `computeEditRegion` + add `dirty_lines` to session state.
4. **Phase 2 main PR.** Coverage instrumentation, intersection, surfacing.

### Relationship to other plans

| Plan | Relationship |
|---|---|
| `08-hook-server-protocol-mismatch.md` | Phase 1 doesn't depend. Phase 2 is sensitive to Option B/C in OPEN 2.B; an `updated_input`-based session-dir strategy depends on the framed-RPC fix landing first. |
| `10-mutation-testing.md` | Hard dep on Phase 1 (the recurrence-driven warning surface and behavioral plumbing fix are reused). Don't ship Plan 10 before Phase 1 is dogfood-validated. |

### Out of scope

- Per-language coverage (pytest, cargo-mutants, go-test) — separate plan.
- Branch-coverage diff — additive once line coverage lands.
- Coverage trend aggregation across sessions — server-side concern.
- Mutation testing — Plan 10.
- Typed config for assertion density helpers — only if dogfood reveals real FPs that warrant it.
