# oh-my-pi (omp) — hashline edit contract + "only the harness changed"

- **Source:** https://github.com/can1357/oh-my-pi (MIT; fork of Mario Zechner's `pi`). Blog: "We improved 15 LLMs at coding in one afternoon. Only the harness changed." — Can Bölük, 2026-02-12, pasted by user.
- **Encountered:** 2026-07-17, user pasted the blog + asked what to adapt for interlinked (local + cloud).
- **Verdict:** compound — **PR** (lane 2/3: upgrade the two shipped edit guards to one-round-trip rescue + content-hash staleness) + **pattern notes** (lane 4: anchor provenance, repair-with-warning, error-as-interface) + **cloud-roadmap entries** (lane 5: edit-mechanics telemetry; hashline-native tools in Agent CI sandboxes; mutation-inverse eval methodology).

## 1. Core idea (one sentence, your words)

Stop making the model reproduce file content to express an edit: reads mint a verifiable anchor (content-hash tag + line numbers), edits reference the anchor, and the applier — owning both sides of the contract — deterministically validates freshness/provenance, repairs characteristic LLM slop with warnings, and rejects with errors that teach and carry the context needed to retry in one round trip.

## 2. Anatomy (concrete walkthrough)

Monorepo (~3.5k TS files, Bun): `packages/coding-agent` (the omp CLI — ~32 tools, LSP wired into writes, DAP debugger, typed subagents), `packages/hashline` (the edit engine, standalone), `packages/typescript-edit-benchmark` (the blog's benchmark), `packages/metaharness` (their benchmark manager: experiment → run → trace, SQLite + dashboard, drives per-model tool tuning), plus `snapcompact` (deterministic context compaction: history rasterized into glyph PNGs that vision models read back — no LLM in the loop), `mnemopi` (SQLite memory engine), `agent`, `ai`, `tui`, Rust natives.

The `edit` tool is one tool with four modes — `hashline` (default), `patch`, `apply_patch` (Codex grammar), `replace` (str_replace) — and read output is mode-aware: hashline `[path#TAG]` + numbered rows appear only when the hashline edit mode is active and the reader can edit (`file-display-mode.ts`); read-only scout subagents get plain content, and code reads default to a structural summary (bodies elided, footer naming the exact selector to fetch more). Multi-entry edit failures get explicit accounting — "Entry 1 was already applied. Entries 3–4 were NOT applied; re-read and re-issue only the failed and unapplied entries" — with `isError` set so a proposed-diff preview can't masquerade as success (`src/edit/index.ts`).

**The shipped hashline (v17, July 2026) is NOT the blog's hashline (Feb 2026).** The blog benchmarked per-line 2-hex hashes (`1:a3|function hello() {`); the shipped design dropped per-line hashes entirely. Current contract, from source:

- `format.ts::computeFileHash` — the tag is 4 hex chars = low 16 bits of xxHash32 over whitespace-normalized full-file text (CRLF/trailing-space immune). Reads/searches emit `[path#TAG]` + plain `N:text` rows. 65k values ⇒ collisions expected; handled because the tag is "a fast index, never the identity" — the store keeps full text and resolves collisions by content equality (`snapshots.ts`, issue #4075).
- `snapshots.ts::SnapshotStore` — per-session store: per-path ring of 4 full-text versions, 30 paths LRU, 64 MiB global cap. Records **`seenLines`** — which 1-indexed lines each read actually *displayed* (partial/elided reads leave it sparse). Byte-identical re-reads fuse onto one tag.
- Edit grammar (`prompt.md`, `grammar.lark`): sections `[path#TAG]`; ops `SWAP N.=M:` / `DEL N.=M` / `INS.PRE|POST|HEAD|TAIL` / `SWAP.BLK N` / `DEL.BLK N` / `INS.BLK.POST N` (tree-sitter resolves the block span from its opening line) / `REM` / `MV`. Body rows are `+TEXT` final content only — no context lines, no `-old` rows, ranges never widened over unchanged lines.
- `patcher.ts`/`apply.ts` — preflights multi-section patches (all-or-nothing), validates the tag against live content, **rejects edits anchored on lines the model never saw** (`seenLines` provenance; default-on since 17.0.0 with `enforceSeenLines` escape), then applies with conservative auto-repairs, each surfacing a warning: delimiter-balance boundary repair (drops restated keeper lines / spares deleted closers, only when one repair drives `()[]{}` imbalance to exactly zero, string/comment-aware), indentation-guided landing correction for inserts, echoed `N:`/`+` prefix stripping (`prefixes.ts`), even apply_patch/unified-diff compat parsing.
- `recovery.ts` — stale tag ⇒ resolve tag to the recorded snapshot, diff snapshot↔live into a line map, remap every anchor through unchanged lines requiring one consistent offset + surrounding-context validation (duplicate-line aware), replay on live text; **fails closed** to a `MismatchError`. Distinguishes external drift from in-session chain (model anchored on a pre-edit read).
- `mismatch.ts` — rejections distinguish "file changed between read and edit" from "**hash not from this session**" (fabricated/carried-over tag), and append `*`-marked current-file context around the anchors so the retry doesn't need a re-read (16.3.3 explicitly moved from "re-read required" to "inline the lines so the immediate retry succeeds").
- After a successful apply the response re-grounds: fresh `#TAG` + a compact current-file preview with **post-edit line numbers** (`diff-preview.ts` — removed lines omitted, long added runs elided) "so a follow-up edit can reuse visible concrete lines directly".
- `CHANGELOG.md` is the real moat: ~15 releases, May–July 2026, each a named LLM failure mode found in production issues (#1492 echoed read prefixes, #1664 restated boundary lines, #2292 closer-anchored block ops, #3142 multi-hunk closer repair, #3867 BOM, #4075 tag-collision fusion) answered with a deterministic repair or a teaching rejection. Also: keyword syntax matters (`replace`→`SWAP`, pilcrow→ASCII `[...]`, `..`→`.=` because inclusive-end was misread) — they tune the DSL like a prompt.

**Benchmark** (`packages/typescript-edit-benchmark` + `packages/metaharness/adapters/edit/`, code-verified): mutation-inverse tasks — 20 AST-based mutation operators (operator/equality/logical swaps, boolean flip, off-by-one, removed guard/optional-chain/negation, arg swaps, …) applied to files from *upstream `pi-mono`* by a seeded generator; templated (not model-written) bug descriptions with difficulty-scaled hints (easy = exact line … nightmare = "subtle bug" on a repeated line). Scoring: no tests, no compile — prettier-normalized restoration of the original (whitespace forgiven; a semantically-equivalent different fix **fails**). Task pass = best-of-N with early-stop-on-match; zero-tool/timeout/provider retries don't count against the run; token metrics read off the cheapest passing run. Two findings that reframe the blog:
- **"Only the edit tool changed" is not strictly true.** The read tool is mode-aware (`file-display-mode.ts`), so the hashline condition reads `[path#TAG]` + numbered lines while patch/replace read plain *un-numbered* content (`readLineNumbers` defaults false, never set by the bench). It's a fair whole-editing-loop comparison, not an isolated tool swap — patch/replace never get the line numbers that might have helped them. Also one-sided hygiene: hashline's autocorrect assists are separated out (`Autocorrect-Free Success Rate`) but replace's fuzzy-whitespace assists are baked into its headline.
- **The headline dataset isn't in the repo.** Committed fixtures = 80 tasks (blog: 180); `/runs/` is gitignored; no 16-model matrix config; no v1/v2 toggle exists (the "v2" was a temporal syntax revision — current grammar is internally "v4"). The only committed results file is a 6-model, single-condition, ~20-task snapshot. The blog's exact numbers must be taken on faith or regenerated.
Remaining honest signal: mechanical single-line fixes favor anchor-based editing, the "−61% tokens" (per-model, Grok 4 Fast) mechanism is real (anchors + body-only output, killed retry loops), and gains are not uniform (GPT-5.2 Codex +26% tokens; DeepSeek negative) — per-model fit is an empirical fact, which omp itself concedes in production: `HASHLINE_EXCLUDED_MODEL_MODES` routes Kimi to `replace` (`edit-mode.ts:16`) while the benchmark forces strict mode past that routing.

## 3. Deterministic or agentic?

Fully deterministic edit path: parser, xxHash tags, snapshot store, tree-sitter block resolution, diff-based recovery, balance-gated repairs. No LLM anywhere in the applier. **License: MIT** (both root and the `hashline` package) — code-borrow and paid reuse are clean. Bun-coupled (`Bun.hash.xxHash32`, `Bun.file`) — vendoring into Node means shimming those two seams.

## 3b. Role in its native architecture — and does it transfer?

Natively, hashline IS the write boundary: omp owns read, search, edit, and the session store, so it can enforce "you may only edit what you were shown, as of when you were shown it" as a hard contract. Interlinked does not own any client's tools — we observe and gate someone else's read/edit. The role must therefore shift: **contract enforcement degrades to fast-fail + rescue + drift warnings at the hook layer** (strictly-better error paths for Claude Code's existing str_replace), and the full contract only transfers to surfaces where we own the loop (Agent CI sandboxed agents). Same lesson as `cursor-harness.md` claim 4 (per-model tool provisioning) from the open-source side.

## 4. Substrate vs. surface

`@oh-my-pi/hashline` is deliberately substrate: standalone package, pluggable `Filesystem`/`SnapshotStore` seams, in-memory + disk impls, formal grammar, its own bench/tests. Borrowable without the omp surface. The concepts (snapshot tag, seen-lines provenance, fail-closed recovery, teach-in-the-error) are borrowable without the code.

## 5. Lane (1–6)

Lane 2/3 for the CLI (upgrades to shipped guards — detection + a small session-state substrate addition); lane 4 for the contract patterns; lane 5 for hashline-native cloud tooling, telemetry, and the eval methodology.

## 6. Dependency & displacement

- **Deps:** CLI slices add zero runtime deps (hashing via `node:crypto` or the existing hasher; no hashline import, no tree-sitter). Agent CI could vendor the MIT package (cloud codebase carries its own deps).
- **Displacement / equivalence (capability-by-capability):**
  - Doomed-edit fast-fail — **shipped**: `evaluateEditOldStringGuard` (pre, block) + `[interlinked:edit-near-miss]` (post), Sørensen-Dice near-miss spans in `edit-diagnostics.ts`. Gap vs omp: hint is line numbers + a trimmed 120-char first-line snippet ⇒ still forces a re-read (two round trips); `Edit`-only (MultiEdit unsimulated here despite existing sequential-sim machinery in `pre-tool-helpers-guard-blocks.ts`); the *multiple-matches-without-`replace_all`* doom case isn't checked at all.
  - Staleness — **partial**: `stale_read_then_write` (sequence, warn) is identity-based (fires only when *another tracked agent* wrote the file); reservations are intent-based. Content-based drift (formatter, git pull, build, human, untracked writer) — omp's whole tag mechanism — is **absent**; `session-state` keeps only a `files_read` path set, no content hash at read time.
  - Seen-lines provenance — **absent** (and only worth a warning-tier port; fail-open when reads happen via Bash, exactly like omp's `seenLines === undefined` skip).
  - Repair-with-warning — **N/A by policy** (`feedback_no_autofix_detection_first`): we never rewrite payloads in flight. Our lawful analog is *rescue messages carrying the exact material needed* so the agent authors the correction itself.
  - Post-edit re-grounding — **native in Claude Code** (edit results echo the updated region); nothing to build.
  - Eval — **partial**: `fable-corpus-extraction.md` is observational; controlled harness-as-variable A/B with mutation-inverse tasks is absent (our Stryker mutant infra can mint the fixtures; omp's `metaharness` is the reference shape).
  - Destructive-command guard / approval tiers — **shipped and broader**: their `CRITICAL_BASH_PATTERNS` denylist + `read/write/exec` tier model is a subset of our 119 builtin rules + client permission modes; nothing to import.
  - Typed subagent output — **partial**: `agent-event-capture.ts` records SubagentStop results after the fact; omp's `yield` tool *schema-validates at submission* with bounded retries (3, then drop constraint). Schema-forcing is harness-side ⇒ only portable to Agent CI where we own the loop.

## 7. Smallest spike

≤1 day, all in shipped files, zero deps, zero FP (each mirrors the client's own failure semantics):
1. **One-round-trip rescue**: extend `findClosestSpans`/`formatNearMisses` to return the best span's *full verbatim lines* (exact whitespace) rendered in a fenced block — line numbers outside the fence (omp issue #1492: models echo displayed prefixes into payloads) — so the retry can copy an exact `old_string` without re-reading.
2. Same guard for **MultiEdit** (reuse the sequential simulation) and a new deterministic case: `old_string` present **>1× without `replace_all`** ⇒ block-and-answer listing match sites + context, suggest `replace_all` or a wider anchor.
3. **Content-hash staleness**: record a content hash per file at Read/grep-accelerator display time in `session-state`; at PreToolUse Edit, hash the live file (already read by the guard) and on mismatch warn `[heuristic]` with the drifted region (unified-diff lines, capped) — catches every writer `stale_read_then_write` can't see.
Measure via recurrence rows (`edit_doomed`, `edit_rescued`, `edit_stale_read`) before/after.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | §7: one-round-trip rescue, MultiEdit + multi-match doom cases, content-hash staleness + recurrence wiring | §7 | now |
| Guardrails (P2–3) | Edit-mechanics telemetry as a product signal: doomed/rescued/stale rates per model × client (the taxonomy Cursor treats as its leading regression indicator; no vendor collects it cross-client) | aggregate recurrence rows into `interlinked stats` + one dashboard card | next |
| Agent CI (P4–5) | Own-the-loop adoptions: vendor hashline (MIT) as the edit tool for sandboxed cloud agents; mutation-inverse task generator (from Stryker mutants) for harness-as-variable A/B evals of our own gates | RFC first — pick sandbox runtime + judge (format-normalized compare vs test-run) | parked |

## 9. Artifact

PR for §7; this doc; cloud rows above. Full gap inventory + implementation memo: `docs/design/edit-contract-hardening.md` (LG-1…LG-6 local, CG-1…CG-4 cloud). **Carve-outs (rejected):** (a) an MCP "hashline sidecar" for Claude Code — fights the client's own read-before-edit file-state tracking, splits edit provenance across two tools, and adoption friction defeats the purpose; (b) per-line hashes — superseded by omp's own evolution (whole-file tag + plain numbers won); (c) tree-sitter block ops locally — heavy dep for semantics our clients' tools can't express anyway.

## Notes

- The blog's numbers measure the *February* iteration of the format and are not reproducible from the current checkout (80 committed tasks vs 180 claimed; runs gitignored; 16-model matrix external). The July system is a different, better design whose hard parts (snapshot recovery, seen-lines, boundary repair) a fresh-session-per-task benchmark barely exercises. Read the CHANGELOG, not the blog, before citing capabilities.
- Even the hashline authors ship **per-model edit-format routing** in production (Kimi → `replace`). "Which edit format for which model" is an empirical, per-model question — the strongest argument for the telemetry row in §8: interlinked sits across four clients and could measure it in the wild rather than in a bench.
- Anti-fabrication detail worth copying anywhere we mint tokens the model must echo: distinguish "stale-but-recognized" from "never issued" (`MismatchError.hashRecognized`) — the second gets "never invent the tag" teaching.
- Their prompt discipline: repairs are invisible help (deliberately undocumented in the tool prompt), rules are visible constraints, and every rejection message names the wrong form *and* the right form inline. Matches our warning-text house style; keep it that way.
- 16-bit tag + full-text retention = "short token the model can echo reliably; store resolves ambiguity." The token is for the model; the truth stays server-side.
- TTSR ("time-traveling stream rules"): regex/ast-grep match on in-flight output aborts the stream mid-token, injects the rule, retries from the same point. The upper bound of what a harness that *owns the stream* can do — our socket layer's ceiling is pre-block + next-turn warnings. Pattern note only; not portable.
- omp has its own in-process hook surface (`extensibility/hooks/types.ts`: tool call/result, context rewrite, turn, compaction, retry) — a useful checklist of lifecycle events a mature harness exposes, several of which (compaction, retry, context rewrite) no client we hook currently surfaces to us.
- Related intakes: `cursor-harness.md` (per-model tool provisioning, error-taxonomy-as-signal, Keep Rate), `bun-in-rust.md` (the reservation/`apply_patch` gap this staleness work complements), `sondera-coding-agent-hooks.md`.
