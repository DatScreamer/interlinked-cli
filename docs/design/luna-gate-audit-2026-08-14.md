# Luna gate audit — 2026-08-14

Audit of Codex CLI session `019ffaa5-f290-7963-9b41-7d47cd40b281` (2026-08-13),
which spawned 142 "Luna" (`gpt-5.6-luna`) tests-only sub-agents via
`spawn_agent`. Scope: locate the actual prompts, determine which Interlinked
gates fired on their writes, and evaluate three stricter file-class /
Stop-event gate proposals against the existing registry and
`docs/plans/19-test-receipt-blinded-review-machine.md`.

**Operating conditions.** The Interlinked daemon in this repo was extremely
unstable throughout this audit — heavy concurrent multi-session load (another
session was live-authoring `src/harness/checks/test-legitimacy.ts` while this
audit ran) produced dozens of anti-stomp / startup-failed / RSS-ceiling
restarts. Every blocked read below was a transient-daemon retry, not a
finding; all data in this report comes from successful, bounded reads.

---

## Part 1 — locating the actual prompts

### 1.1 Where the spawns live

`~/.codex/sessions/2026/08/13/rollout-2026-08-13T06-23-27-019ffaa5-f290-7963-9b41-7d47cd40b281.jsonl`
(58.6 MB, 9,328 lines) is the root session. `rg -c '"name":"spawn_agent"'`
against it returns **142** — matching the task's count exactly. Each record
is a `response_item` of `type:"function_call"`, `name:"spawn_agent"`,
`namespace:"collaboration"`, with JSON-string `arguments` containing
`fork_turns`, `message`, `model`, `reasoning_effort`, `task_name`.

`model` is **`"gpt-5.6-luna"` on all 142 spawns** (`rg -c` on the escaped
field, exact match to the spawn count) — "Luna" is the model variant; each
instance additionally gets a random display nickname (e.g. `"Mill"`) recorded
in its own session's `session_meta`.

### 1.2 The critical finding: task payloads are encrypted, structurally

The `message` argument on every spawn is a Fernet-style token
(`"gAAAAAB..."`). This is not incidental noise — the schema names it
explicitly. In the root file, the routing header is plaintext but the payload
is a distinctly-typed content block:

```
"content":[
  {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/sweep_contract_test\nSender: /root\nPayload:\n"},
  {"type":"encrypted_content","encrypted_content":"gAAAAABqfcoPEMjDKmZ7-v7PU086eacV..."}
]
```

This exact block appears **twice** for every task assignment: once as the
`spawn_agent` tool-call argument in root's own file, and again — same
ciphertext — as the `NEW_TASK` message actually delivered into the child's
own rollout file. `rg -c '\\"message\\":\\"gAAAAAB'` over the root file
returns 179 hits (spawn_agent + `followup_task`/`send_message`, all
encrypted); a direct check for any spawn_agent call with a *non*-encrypted
message returns zero. There is no local key material in either file to
decrypt this; decryption was not attempted (out of scope, and structurally
this looks like the same encrypted-reasoning-continuity mechanism vendor
Responses APIs use for `store:false` cross-turn content, which is decrypted
server-side only).

**What this means concretely: the actual task instructions given to a Luna
sub-agent are not recoverable from any local file.** Not from root's log, not
from the child's own log.

### 1.3 What IS recoverable, and where

Each Luna sub-agent runs as an entirely separate Codex thread with its **own**
rollout file (137 files that day under `2026/08/13/`), keyed by
`agent_thread_id` — a field surfaced in root's log at the `SubAgentActivity`
`"kind":"started"` event, **not** by `turn_id` (root's `turn_id` is shared
across ~1,800 interleaved lines of root's *own* concurrent polling — health
checks, `wait_agent`, `list_agents`, `update_plan` — while children work; it
does not identify a child's activity at all).

Inside a child's own file, plaintext and recoverable:
- **Routing metadata**: `task_name` (e.g. `sweep_contract_test`,
  `kill_taste_smell_mutants`), `model`, `reasoning_effort`, `fork_turns`,
  nickname.
- **The agent's own generated output** — `FINAL_ANSWER` / commentary text and
  every tool call it made (`apply_patch` patch bodies, `exec` shell/JS) —
  these are the model's own generated content, not cross-agent transport, so
  they are stored in plain text.
- **Boilerplate** identical across every agent: base system instructions,
  the multi-agent collaboration-tool primer, AGENTS.md, environment context.
  None of it is task-specific.

Task-name diversity across all 142 spawns (`rg -o` on the escaped field,
prefix histogram): **209 `kill_*`** mentions (mutation-kill work — dominant),
**40 `test_*`** (test-legitimacy/test-quality authoring), remainder
scattered (`verify_*`, `sweep_*`, `mbp_*`, etc.) — consistent with "tests-only
Luna sub-agents."

### 1.4 Storage question — answered explicitly

**What `.interlinked` persists about foreign-runner sub-agent prompts: nothing.**
`spawn_agent` / `wait_agent` / `list_agents` / `send_message` are Codex-internal
collaboration-tool calls — they are never a shell exec or a file edit, so they
never cross the Interlinked hook boundary at all. Confirmed empirically:
`interlinked query checks --where file=...` for every Luna-touched file
returns `"session":"019ffaa5-f290-7963-9b41-7d47cd40b281"` — the **root**
session id — for every one of the 142 sub-agents' writes. Interlinked has no
record that 142 distinct sub-agents exist, let alone their task names or
prompts; it sees one Codex session issuing a long stream of `apply_patch`/
`Bash` tool calls.

**What is lost, layered:**
1. Codex's own local storage never had the plaintext prompt (encrypted at
   rest, both directions) — this is lost before Interlinked could ever see it.
2. Interlinked's cross-runner capture (`collection.jsonl`/`activity.jsonl`)
   captures tool-call *results* (content, decision, findings) attributed to
   the single root session id — it has no sub-agent identity field to lose,
   because Codex's hook payload for these calls carries none.
3. Net effect: reconstructing "what was Luna told to do" is possible **only
   by inference** — from the sub-agent's own final-answer text and the diffs
   it produced — never from a stored instruction. This is a materially
   different (worse) situation than Claude Code subagents, where
   `agent-metrics.ts`/`agent-event-context.ts` at least attach a remembered
   `agent_type` label and `tool_use_ids` join key (per `CLAUDE.md`); Codex
   sub-agents have no analog of either in `.interlinked` today.

### 1.5 Representative Luna "prompts" (necessarily final-answer proxies)

Given §1.2–1.4, these are the closest available substitute — the sub-agent's
own self-report of what it did, trimmed:

> **`sweep_contract_test`** (13:43–13:44 UTC): *"Updated only
> [quality.mutation-kill.test.ts]: Replaced the old `mutation > sweep`
> description expectation. Added exact descriptions for `--all-eligible` and
> `--measured-before`. ... Targeted test passed: `29 passed`."*

> **`kill_taste_smell_mutants`** (~16:05 UTC): *"Added
> [taste-smell-survivors.test.ts] only... 30 new assertions target surviving
> boundary behaviors across: magic-number context/operator..., negated-condition
> branch scanning..., nested/nullish/optional ternary parsing... **No mutation
> measurement was run.**"*

> **`test_legitimacy_check_tests`** (17:15–17:17 UTC): *"Created only
> [test-legitimacy.test.ts], covering: Per-test contract markers for
> mutation-directed files... **Narrow execution is pending the planned
> production module `test-legitimacy.ts`.**"*

---

## Part 2 — which of our gates actually fired on Luna writes

All findings below are bounded queries against `.interlinked/check-results.jsonl`
(4.3 MB — small enough to `rg` directly) and `interlinked query blocks --where
session=019ffaa5-f290-7963-9b41-7d47cd40b281` (activity.jsonl, tool-bounded).
**Attribution caveat**: every row below carries the same root session id
(§1.4) — there is no way to separate "which Luna instance" triggered a given
finding from Interlinked's own data; only file path and timestamp localize it.
Tool-name attribution is also inconsistent: the same class of edit shows up
labeled `apply_patch` in some records and generically `Bash` in others
(the Codex adapter appears to key off the `exec` script's inner call shape,
not a stable tool identity).

### 2.1 What fired

| Check / rule | Kind | Phase (registry) | Evidence this session |
|---|---|---|---|
| `typescript` | proven, tool-quality | `post` (surfaces as `guard_decision:"block"`) | 3× on `test-legitimacy.test.ts` (17:15:16–17:16:06 UTC): `TS1005 ',' expected`, `TS1127 Invalid character`, etc.; 2× on `package-install-guard.test.ts` (23:06 UTC) |
| `persistent_warning_escalation` | proven | escalator | fired alongside the 2nd `typescript` block on `package-install-guard.test.ts`: *"Warning \"typescript\" persists after re-edit (issued 2 times)"* |
| `biome_lint` | proven, advisory | `post` | cascaded with the typescript parse failures on the same file |
| `cyclomatic-cap` | proven, monotonic ratchet | PreToolUse block | fired on `workspace-effects.ts` (22:43 UTC) — non-test file, same session, proves the ratchet reaches Codex `apply_patch` |
| `test_missing_sut_import` | partially_deterministic | `pre_warn` (`check-registry/entries-warnings/test-and-demo.ts:97-109`) | 29 fires session-wide; direct hit on `taste-smell-survivors.test.ts` (16:03:57 UTC) |
| `mock_only_test` | heuristic | `pre_warn` (same file) | 33 fires session-wide |
| `conditional_in_test` | heuristic, taste family | `post` | 77 fires session-wide |
| `assertion_roulette` | heuristic, taste family | `post` | 70 fires session-wide |
| `assertion_density` | heuristic, **behavioral/TDD family** (`behavioral-checks-tdd-assertions.ts`) | `post` | direct hit on `taste-smell-survivors.test.ts` (16:05:44 UTC) |
| `builtin-file-dump-large-file` | proven, command-shape | PreToolUse block | 3× — unrelated to file content, guards raw shell reads |
| `npm_run_then_curl_to_localhost` | proven, sequence | PreToolUse block | 1× — taint-tracking, unrelated to test content |

Session-wide aggregate (`interlinked query checks --where session=... --by
checks.id`, 14,776 records scanned, `truncated:false`): 2,382 clean edits
(`(none)`), then `unjustified_cast` (215), `cognitive_complexity` (127),
`function_arg_count` (104) as the top non-test findings — confirming the
session was dominated by ordinary quality-check traffic, not a single
pathological file.

**Zero fires, entire `check-results.jsonl` history** (not just this session):
`assertion_free_test`, `tautological_assertion`, `mocking_the_sut`,
`introverted_test` — the existing `pre_block` hard rails around test
legitimacy (`check-registry/entries-taste.ts:32-60`, per the design doc's
§2.1 table) and the introverted-test detector have never fired once in this
repo's recorded history. Per the repo's own stated philosophy
(`CLAUDE.md`: *"fire rate measures the AGENT, not the check"*), this is
evidence the agent population clears that bar, not that the checks are dead.

### 2.2 What could not have fired, and why (build vintage)

`test_legitimacy` (`checks/test-legitimacy.ts`, the design doc's §2.1
subject) **could not have fired on Aug-13**, confirmed three independent ways:

1. `git log --follow --diff-filter=A -- src/harness/checks/test-legitimacy.ts`
   returns **zero commits**; `git status --porcelain` shows it `??`
   (untracked) **right now** — it is being actively authored by a different,
   concurrent session while this audit ran (a stray PostToolUse warning on
   that exact file landed mid-audit as a side effect of that other session's
   edits).
2. Git HEAD was `61e04b9` (2026-08-11 13:42 EDT) throughout and after the
   Aug-13 session — no commits have landed since, which is also why the
   entire Luna campaign's output (dozens of modified files) is still sitting
   uncommitted in the working tree right now.
3. Luna's own `test_legitimacy_check_tests` final answer says it directly:
   *"Narrow execution is pending the planned production module
   `test-legitimacy.ts`"* (§1.5) — the sub-agent that was, per its task name,
   building the test-legitimacy check's tests, confirms in its own words that
   the production module did not exist yet.

Whatever daemon build actually served PreToolUse/PostToolUse during the
Aug-13 window, it traces to commit `61e04b9` or earlier — no build assembled
from that lineage could contain `test_legitimacy`. Everything downstream of
it in `docs/plans/19` (receipt store, per-test mutant attribution, blinded
review) is explicitly **UNVERIFIED SKETCH** with no `src/` changes, so none
of it could have fired either — this is a documentation fact, not something
this audit needed to re-derive.

---

## Part 3 — stricter, extensible gates

### 3(a) File-class severity profile

**Grounding.** The file-self-declaration primitive already exists:
`MUTATION_DIRECTED_PATH = /(?:\.mutation-(?:kill|hardening)\.|\.survivors?\.)/i`
at `checks/test-legitimacy.ts:13`, already used today to gate the
contract-marker requirement (`:126-129` per the design doc). Live population
confirmed: **57 distinct mutation-directed files** have recorded
`check-results.jsonl` entries repo-wide. `pre-block-gate.ts` already provides
the introduced-only multiset-diff mechanism (`:8-19`) that any stricter
promotion must route through, and `CheckPhase` (`check-registry/types.ts:30`)
is a fixed three-value enum — a file-class profile is a *dispatch-time
override table*, not a fourth phase.

**Mechanism.** Not a new check phase. A small profile resolver, keyed by
`MUTATION_DIRECTED_PATH.test(filePath)`, that remaps specific check ids'
*effective* phase upward for that file only, evaluated where the PreToolUse
dispatcher currently reads a check's static `phase` field:

| Sub-proposal | Existing primitive reused | New plumbing needed |
|---|---|---|
| `test_missing_sut_import` pre_warn→pre_block | check + `pre-block-gate.ts` ask/block path | phase-override lookup only |
| `BROAD_TRUTHINESS` ban | already fires file-wide today (warning) | phase-override lookup only |
| assertion-removal delta blocked | `pre-block-gate.ts`'s multiset diff — but that diff detects **added** bad lines, not **removed** good ones | a genuinely new comparison direction (baseline-has, proposed-lacks) |
| receipt-missing warn→block | plan 19's `test_receipt_missing` | **not reachable at all** — 19 designed it `VERIFY_ONLY_CHECKS` (plan 19 §3.8) because it needs the receipt store (M1) and can't satisfy the registry's pure `(content, filePath)` contract; this sub-proposal is gated on 19's M0–M1 landing first, not a standalone add |

**Why file-class scoping is what makes this defensible, not just convenient.**
`test_missing_sut_import`'s own registration says `determinism:
"partially_deterministic"` — promoting it to `pre_block` *globally* would
violate the "reserved for zero-FP" contract (`check-registry/types.ts:16-18`)
outright. Scoped to files the agent itself named `*.mutation-kill.*`, the
promotion is defensible: the agent opted the file into the stricter bar by
its own naming choice, and the other ~95% of test files keep today's
forgiving `pre_warn`. This is the same "self-declared scope" logic
`isCappableFile` already uses for the line-cap gate.

**FP risk.** Low for promoting already-shipped, already-measured checks
(`test_missing_sut_import` 29 fires, `mock_only_test` 33 fires this session
alone — a real, sampled population to calibrate against, not a fixture).
Medium for the `BROAD_TRUTHINESS` ban specifically: it already fires
file-wide as a heuristic; flipping "warn" to "reject the write" is a real
behavior change and — per `CLAUDE.md`'s own `halstead_difficulty` precedent
(25→80 after a corpus run) — should get a corpus pass before flipping, not be
assumed safe from the pre_warn fire rate alone.

**Evidence-contract obligation.** Promotion to `pre_block` moves the check
into the strictest tier: 3/3 labeled cases, 100% branch coverage, corpus
required, mutation required, adversarial required (`check-evidence/obligations.ts`
tiers, per `CLAUDE.md`'s table). The existing `pre_warn`-tier evidence for
`test_missing_sut_import` does **not** automatically satisfy this — the
mutation/adversarial columns are new work, specific to the new file-scoped
code path.

**Codex/foreign-runner applicability.** The profile evaluates PROPOSED CONTENT
at PreToolUse — runner-agnostic by construction, and this audit is itself the
cross-runner validation case: `test_missing_sut_import` and `mock_only_test`
both already fire on Codex's `apply_patch`-via-`exec` writes (§2.1), proving
the detector reaches that hook surface today. The real open question is
**decision semantics, not detection**: `pre_block` fires
`decision:"ask"` (user-confirmed bypass) per `check-registry/types.ts:16`.
Whether Codex CLI's hook contract supports an ask/confirm round-trip, or
degrades to fire-and-forget block/warn, was not verified in this audit (would
require reading `src/lib/hook-installers.ts`'s Codex path specifically) — flag
as a pre-ship verification item, not an assumption.

### 3(b) Stop-event kill-evidence check

**Grounding.** `verification-stop-checks.ts`'s existing pattern — `string |
null` formatters called from the server's Stop branch, never blocking
(`CLAUDE.md`'s table: unverified-code / UI-not-interacted / stubs-introduced)
— is the exact seam plan 19 (§4) already proposes reusing for its own M4
receipt-histogram nudge: *"A new `string | null` formatter in the
`verification-stop-checks.ts` style... called from the server's Stop branch.
Never blocks."* This proposal is a buildable-today subset of that same seam,
independent of 19's receipt store.

**Detection signal (no new infrastructure required).** At Stop: for every
file touched this session matching `MUTATION_DIRECTED_PATH` where the diff
*added* new test-case blocks (reuse the case-parser.ts walker plan 19 (§2.3)
already cites), check whether the mutation manifest's `measuredAt` for that
file is newer than the edit. This session supplies the exact justification in
the agent's own words: `kill_taste_smell_mutants` self-reported *"No mutation
measurement was run"* — a Stop nudge built from nothing but "session-touched
mutation-directed file, no fresh manifest measurement" would have caught that
exact session, using a sentence the agent already emitted and nothing acted
on.

**Phase / FP risk.** Stop, warn-only, never blocks — matches plan 19 (§3.4)'s
latency/cost/evidence-completeness rationale. Scoping to **new test-case
introduction only** (not any edit) is required to avoid punishing drive-by
maintenance: `sweep_contract_test` touched a `*.mutation-kill.test.ts` file
only to fix a stale CLI-description string (§1.5) — under a naive "any edit
to a mutation-directed file" trigger this would false-fire; scoped to
new-`it()` detection it correctly stays silent.

**Evidence-contract obligation.** Stop-phase nudges sit outside
`CHECK_REGISTRY` and the tier table entirely — none of the four existing
nudges in `verification-stop-checks.ts` are evidence-gated — so no tier
obligation applies structurally. A labeled positive/negative fixture pair is
still good practice; the pin simply won't enforce it.

**Codex/foreign-runner applicability.** Stop is a session-lifecycle hook, not
per-tool-call — requires Codex to fire an equivalent end-of-session hook.
**Not verified in this audit** (would require reading Codex's hook
registration in `src/lib/hook-installers.ts`); the memory note on
per-runner hook capability (`pre_warn` is stderr-only on Cursor/Copilot)
suggests capability gaps between runners are real and specific, not
assumable — flag as an open verification item before relying on this for
Codex sessions specifically.

### 3(c) What the Luna prompt gaps show

Two concrete misses surfaced directly by this audit, both already anticipated
by plan 19 rather than novel:

1. **The self-report-with-nowhere-to-land gap** (motivates 3b directly):
   `kill_taste_smell_mutants` wrote 30 new assertions and stated outright that
   no mutation measurement backed them. That sentence is exactly the
   "unfalsifiable prose" plan 19 §1.1 names as the core problem — the
   difference here is the prose was never even unfalsifiable-by-necessity, it
   was sitting in plain text in the agent's own final answer with nothing
   downstream reading it.
2. **The scope-bleed risk in a naive file-class ban** (constrains 3a's
   design): `sweep_contract_test`'s legitimate maintenance edit to a
   mutation-kill file shows why proposal (a) must inherit
   `pre-block-gate.ts`'s introduced-only semantics rather than file-wide
   semantics — a file-wide `BROAD_TRUTHINESS` ban would fire on that edit even
   though it touched zero assertions.

No evidence of an actual reward-hacked assertion (e.g., asserting the literal
a mutant would have produced) turned up in the three sampled final answers —
but this audit is structurally unable to rule that in or out, because the
only channel that could show it (the task instructions and the model's private
reasoning) is encrypted end-to-end (§1.2). That inability is itself the
strongest argument for plan 19's actual thesis: only a receipt + independent
review layer, not a smarter static check, can close this gap — this audit
corroborates that framing rather than finding a new one.

---

## Sources

- `~/.codex/sessions/2026/08/13/rollout-2026-08-13T06-23-27-019ffaa5-f290-7963-9b41-7d47cd40b281.jsonl` (root, 58.6 MB)
- Three per-agent rollout files: `...T09-43-43-019ffb5d...` (`sweep_contract_test`, 60 lines), `...T11-58-41-019ffbd8...` (`kill_taste_smell_mutants`, 202 lines), `...T13-14-01-019ffc1d...` (`test_legitimacy_check_tests`, 124 lines)
- `.interlinked/check-results.jsonl` (4.3 MB, direct `rg` + `interlinked query checks`)
- `.interlinked/activity.jsonl` via `interlinked query blocks --where session=...` (bounded)
- `src/harness/check-registry/types.ts`, `src/harness/pre-block-gate.ts`, `src/harness/checks/test-legitimacy.ts` (live, §2.2), `src/harness/check-registry/entries-warnings/test-and-demo.ts`, `src/harness/check-registry/entries-taste.ts`
- `docs/plans/19-test-receipt-blinded-review-machine.md` (full read)
- `git log` / `git status --porcelain` (read-only)
