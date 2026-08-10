---
name: interlinked-verify
description: "Run `interlinked verify`, understand the PostToolUse quality checks, and land multi-file edits through the content gate. Load this when you want to check your changes (`interlinked verify` — the on-demand whole-project check run), when a `pre_block` check refused an edit, when you need to land a cross-file refactor without transient tsc errors (`interlinked write --batch` / `multi-edit` / `verify-changeset` and the exporter-before-importers rule), when deciding whether a finding is default-gate or advisory, or when you need to know where to put probe/scratch scripts (`interlinked scratch`). Note: `interlinked verify` reports findings but exits 0 — it is not a pass/fail gate."
---

# interlinked-verify — check your work & land edits through the gates

Interlinked gates edits at **three moments**, and they run different check sets:
- **PreToolUse content gate** (real Edit/Write, and `interlinked write`/`verify-changeset`):
  runs `pre_block` registry checks → **biome** overlay → **tsc** overlay. Blocking findings stop
  the write. **No coverage/complexity/`post` checks here.** (`interlinked multi-edit` is the
  exception — it runs **only biome + tsc**, not `pre_block`; see the ordering section.)
- **Other PreToolUse guards** (real Edit/Write only): coverage, cyclomatic, CRAP, baseline —
  see **interlinked-quality-gates**; package/allowlist — see **interlinked-supply-chain**.
- **PostToolUse** (after the write lands): external tools (tsc/biome/eslint/semgrep/gitleaks/…)
  plus the inline check registry. **Warn only** — surfaced to you next turn.

`interlinked verify` is the **on-demand, whole-project** run of that same check catalog.

## Load this when
- You want to verify a batch of edits before declaring done.
- A `pre_block` check blocked an edit (see also **interlinked-harness** for how blocks read).
- You're landing a cross-file refactor and hitting transient `tsc` errors.
- You're unsure whether a finding is default-gate or advisory-only.
- You need to write a probe/analysis script and want it in the right place.

## `interlinked verify`
```
interlinked verify [target]
  --all-checks        add the advisory smell/complexity/dead-code tier to the default gate
  --only <tool>       run only one external tool (e.g. --only tsc)
  --skip <ids>        comma-separated check ids to skip
  --suggestions       also run scored regex heuristics (sql-injection/perf/quality)
  --structure         also run artifact-structure checks
  --adoption-gate     fail when adopted structure categories drop below thresholds
  --suppress <e...>   add a suppression (file:check or file:check:reason)
  --json --details    machine-readable / per-file detail
```
`target` may be a local path, a GitHub/git URL (cloned to a tmpdir, scanned, deleted), or
omitted (scans cwd). Narrow with `--subdir <path>` in monorepos.

**Two tiers.** Default = high-signal gate: tsc, biome, oxlint/eslint, semgrep, gitleaks,
dep-audit (+ language tools as available) **plus** the FP-safe inline checks. `--all-checks`
adds the advisory tier (complexity, taste/smell, DRY clones, most `ubs_*`, test heuristics) —
a **review tool, expect noise, not a gate**.

> **`interlinked verify` exits 0 even with findings.** It is a *reporting* tool, not a
> pass/fail gate — do not `&&`-chain on its exit status. To gate programmatically, parse
> `--json`, or use `interlinked write` / `verify-changeset` (which **do** exit nonzero on
> blocking findings). (Exceptions that *do* exit nonzero: usage errors, and
> `--structure-only` / `--adoption-gate`.)

There is **no** `--file`/`--changed`/`--staged` flag — verify always walks the whole discovered
set (or `target`/`--subdir`). Diff-awareness lives at the *edit-time* gate, not in verify.
Run verify to see **pre-existing** findings in a file you're about to touch (the edit gate
hides those as warnings).

## Check families & phases
Two catalogs, both surfaced by verify + PostToolUse: the **tool wrappers** (`typescript`,
`biome_lint`, `eslint`, `semgrep`, `gitleaks`, `dependency_audit`, `secrets_in_source`,
`affected_tests`, per-language tools…) and the **inline families** in
`src/harness/checks/<family>.ts` (security/injection, PII/secrets, async/promises,
correctness/bug-class, agent-clarity, complexity, test-quality, comment/spec drift, …). Use
`interlinked harness checks` for the authoritative current inventory.

**Phase determines what blocks:**
- `pre_block` — the **only inline checks that BLOCK** an edit. Zero-FP,
  deterministic (`eval`, `nan_comparison`, `throw_literal`, `promise_reject_non_error`,
  `child_process_exec_user_input`, `cookie_missing_security_flags`, most `ubs_*` blockers…).
  Introduced-only. (Merge-conflict markers also block, but via a separate write-guard on real
  Edit/Write — not the `pre_block` registry, so `interlinked write` won't catch them in a new file.)
- `pre_warn` — PreToolUse warning, never blocks (e.g. `floating_promises`, `broad_object_types`).
- `post` — PostToolUse warning + surfaced by verify (the bulk: `nan_coercion_guard`,
  `write_without_mkdir`, `unvalidated_json_boundary`, `magic_literal_in_conditional`,
  `non_null_assertion` ratchet, `introverted_test`, …).

**Default vs advisory.** Default-gate checks fire on every edit + default verify. Advisory
checks (the `DEFAULT_ADVISORY_SKIPS` list — complexity, CRAP, DRY clones, `boolean_trap`,
`write_without_mkdir`, `homedir_write_escape`, most `ubs_*`, Swift/test heuristics…) fire
**only** under `verify --all-checks`. `unvalidated_json_boundary` was PROMOTED to the
default gate 2026-08-10 after the boundary-parser sweep took the repo to 0 fires — expect
it on ordinary edits: route parsed JSON through a local `parseX(v: unknown): X | null`
(or an `isX` guard / `Array.isArray` gate) before field access. **"Advisory" ≠ silent** — an advisory check that fires at PostToolUse
still warns; demoting a check doesn't stop it warning on edits. Fix the detector, not the list.

Every finding is tagged `[proven]` (a real tool ran it — fix it) or `[heuristic]` (regex/AST
shape — evaluate it). See **interlinked-harness** for the suppression grammar
(`// interlinked-ignore: <check> — reason` / `verify-suppressions.json`).

## Landing multi-file edits (the ordering rule)
Three agent-callable commands gate proposed content **without** running coverage/complexity/post
checks. `interlinked write` and `verify-changeset` run `pre_block → biome → tsc`; `interlinked
multi-edit` runs **biome + tsc only** (no `pre_block` — it does *not* screen for eval/injection/etc.):

```bash
interlinked write <path> --stdin                 # single gated write, content on stdin
interlinked write --batch <manifest.json>        # atomic multi-file write
interlinked multi-edit <path> --stdin            # single-file old→new edits
interlinked multi-edit --manifest <file>         # single- or multi-file edits
interlinked verify-changeset --file <cs.json>    # preview the gate, write nothing
```
- **`write --batch` manifest:** `{ "version": 1, "writes": [ { "path", "content" }, … ] }`.
  Transactional — the gate sees all files before any write; any blocking failure ⇒ nothing
  written.
- **`multi-edit` manifest:** `{ "version": 1, "edits": [ { "old_string", "new_string" }, … ] }`
  (path = positional arg), or `{ "version": 1, "batches": [ { "path", "edits": […] } ] }`.
  Edits apply in order to an in-memory buffer; the gate runs once on the final content.
  **Ambiguity is judged after prior edits** — each `old_string` must match exactly one location
  in the *current* buffer state.
- **`verify-changeset`** previews (Write/Edit/MultiEdit shapes), enforces nothing; exit 1 =
  "would be blocked".

> **CRITICAL — exporter before importers.** The tsc overlay blocks *newly-introduced* type
> errors per file, so importing a not-yet-exported symbol is a `TS2305`/`TS2304` the overlay
> blames on your edit. Either (a) put the exporter **and** every importer in **one atomic
> `write --batch` / `multi-edit --manifest`** (the gate sees the whole consistent final state),
> or (b) if sequencing with real Edits, **land the exporter first**, then the importers — never
> the reverse. (Batch editing skips the coverage ratchet, so a batch can land under-covered;
> the coverage gate re-asserts on the next real Edit.)

## Scratch — where probe/draft code goes
The scratchpad guard **blocks** agent-authored **code** aimed at the host session scratchpad and
redirects you to **`<repo>/scratch/`** (rg-searchable, quality-gated, survives the session;
coverage/companion-test ratchets are exempt there, like `scripts/`).
```bash
interlinked scratch init     # provision scratch/ (README + .gitignore carve-out + .ignore negation)
interlinked scratch status
```
Convention: one date-prefixed subdir per effort (`scratch/2026-07-19-<slug>/`). Downloads and
`npm pack` extractions still belong in the host scratchpad (non-code bulk). Softening:
`scratchpad_guard.code_write_mode: "warn"|"off"`; bypass `INTERLINKED_DISABLE_SCRATCH_GUARD=1`
(placement only — the secrets scan on temp paths is never bypassed).

## Common workflows
- **Verify-after-edit:** make edits → `interlinked verify` → fix `[proven]` findings first, then
  triage `[heuristic]`. Read the output; don't rely on `$?`.
- **Pre-flight a risky change:** build a changeset → `interlinked verify-changeset --file cs.json
  --json` → fix until `ok:true` → submit as `write --batch` (or real edits, exporter-first).
- **Cross-file rename:** author all files → one `write --batch` with `{writes:[exporter,
  …importers]}` → single gate pass, no transient tsc error.
- **One-off script:** `interlinked scratch init` (once) → write under `scratch/<date>-<slug>/`.

## Gotchas
- Batch gate ≠ full edit gate — `write`/`multi-edit`/`verify-changeset` skip coverage,
  cyclomatic, CRAP, and `post` checks. A batch that passes can still trip those on the next real
  Edit, and verify will still flag `post` findings.
- New files skip the biome/tsc overlay (no baseline to diff) but run `pre_block` strictly —
  run `verify` to type-check them.
- `--all-checks` re-enables high-FP heuristics; it's for periodic audits, not CI gating.

## Quick reference
```bash
interlinked verify                       # default gate, whole project (reports, exits 0)
interlinked verify --all-checks --details # deep audit with per-file detail
interlinked verify --only tsc            # just typecheck
interlinked write --batch changes.json --json
interlinked verify-changeset --file cs.json --json
```

## Related skills
- **interlinked-harness** — how blocks read, suppression grammar, determinism tags.
- **interlinked-quality-gates** — the coverage/complexity/line-cap ratchets the content gate does NOT run.
- **interlinked-supply-chain** — the package-install gate.
