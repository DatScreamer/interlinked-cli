# anti-slop (Oxlint plugin)

- **Source:** https://github.com/dmmulroy/anti-slop (cloned to scratchpad for this
  intake; no npm release yet — README: "The plugin is source-distributed for
  now")
- **Encountered:** 2026-08-14, repo-recon dispatch
- **Verdict:** **PR** (port 2 genuinely-new rules as advisory `checks/` detectors)
  + **memory note** (two rules directly contradict validated design decisions we
  already shipped — record the collision, don't adopt). Compound — see §9.

## 1. Core idea (one sentence, my words)

An Oxlint plugin — 10 hand-written TypeScript AST rules, each a pure syntactic
pattern match (no `ts.TypeChecker`, despite several rule names sounding
type-aware) — that bans specific shapes of "the type checker was satisfied but
the evidence was fabricated": broad annotations papering over a known value,
casts that launder a type past the checker, and a few narrower lexical bans
(a forbidden identifier substring, unconditional `typeof`). Distributed by
copy-paste: an installer skill vendors the rule source into the target repo's
own tree rather than publishing an npm package.

## 2. Anatomy (concrete walkthrough)

```
anti-slop/
├── src/
│   ├── index.ts                        — definePlugin, registers all 10 rules
│   ├── rules/*.ts                      — the 10 rules (canonical)
│   ├── rules/{3 files}.test.ts         — RuleTester coverage for 3 of the 10
│   └── shared/dictionary-types.ts      — hand-rolled type-alias-graph resolver
│                                          shared by 2 of the 10 rules
├── skills/install-anti-slop/
│   ├── SKILL.md                        — installer agent-skill
│   ├── scripts/install.mjs             — cpSync src → target repo tree
│   └── assets/anti-slop/               — byte-identical mirror of src/ (rules
│                                          dir + shared/ + index.ts), synced by
│                                          scripts/sync-skill-assets.mjs and
│                                          CI-pinned (`pnpm check:skill-assets`)
├── AGENTS.md                            — 6 lines: keep rules generic, use
│                                          Oxlint's ESTree API, no 2nd parser
└── package.json                         — deps: `@oxlint/plugins` (runtime)
```

`git log` shows exactly one commit (`b5d2288 feat: extract anti-slop Oxlint
plugin`) — this is a freshly-extracted repo with no independent revision
history to read for design evolution.

**What the user invokes:** `npx skills add dmmulroy/anti-slop --skill
install-anti-slop`, then asks their coding agent to run the skill. The skill
copies `assets/anti-slop/` to `tools/oxlint/anti-slop/` in the target repo,
installs `oxlint` + `@oxlint/plugins` as devDependencies, registers the plugin
in `oxlint.config.ts`, and enables all 10 rules at `"error"`. From then on the
rules run as part of that repo's own `oxlint` invocation — anti-slop's own CI
is never involved again.

**The 10 rules** (verified against `src/rules/*.ts`, not the README — two of
the ten diverge from their own doc string; flagged below):

| Rule | What it actually detects (source, not marketing) | Tests |
|---|---|---|
| `no-chained-type-assertions` | `x as A as B` (or `<A><B>x`) where ≥1 assertion in the chain is not `as const` — a **syntactic** ban independent of whether `A`/`B` overlap | 0 |
| `no-conditional-empty-object-spread` | `{ ...(cond ? {} : { field: v }) }` — ternary spread used to conditionally omit one field; autofixes to a direct property when the ternary's null-check target textually matches the property value | 0 |
| `no-known-value-widening` | A syntactically-known value (object/array/function literal, or a const traced through ≤N hops) flowing into an explicitly-annotated `unknown`/`object`/open-dictionary/anonymous-object target, across var decls, class fields, returns, arrow bodies, and `as`/`<>` | 32 (best of the 3 tested) |
| `no-object-parameters` | Bare `object` type (or a zero-arg local alias resolving to it) on a function/method/constructor **parameter** specifically | 8 |
| `no-runtime-typeof` | **Every** `typeof` `UnaryExpression`, unconditionally — README says "ad hoc `typeof` narrowing"; the source (`src/rules/no-runtime-typeof.ts:16-24`) has no ad-hoc-vs-canonical distinction at all. **Marketing-vs-reality flag.** | 0 |
| `no-shape-in-symbol-names` | The case-insensitive substring `"shape"` anywhere in any `Identifier`/`PrivateIdentifier`/`JSXIdentifier` — README frames it as generic "low-signal" hygiene; the source bans one specific English word, project-wide, with no escape hatch | 0 |
| `no-unknown-parameters` | `unknown`-typed function parameter, except one literally named `cause` | 0 |
| `no-unknown-type-aliases` | A `type X = …` declaration whose resolved type (chased through same-file alias references) is exactly `unknown` | 0 |
| `no-unsafe-dictionary-type` | `Record<K,V>` / index signature / mapped-type **value** position resolving (through aliases, `Readonly`/`Partial`/`Required`/`NonNullable`, `Pick`/`Omit`, generics) to `unknown`/`any`/`object`/`{}`/a union containing one | 38 (heaviest-tested rule) |
| `no-widen-then-assert` | A local `const` whose declared/inferred type is broad but whose initializer has known-value evidence, later re-asserted (in a **separate** statement) back to a narrower type — the split-statement version of a smuggling cast | 0 |

Only 3 of 10 rules have any automated test (`package.json`'s `test` script
runs exactly `no-unsafe-dictionary-type.test.ts`, `no-known-value-widening.test.ts`,
`no-object-parameters.test.ts` — `pnpm check` runs `lint && test && typecheck &&
check:skill-assets`, so CI is green with 7 rules carrying zero regression
coverage). `AGENTS.md` says "Add focused RuleTester coverage for semantic rule
changes" but nothing enforces it project-wide the way our own Check Evidence
Contract does.

**Duplication model / drift risk.** Inside anti-slop's own repo, drift is
prevented: `scripts/sync-skill-assets.mjs` does a full `rmSync` + `cpSync` from
`src/` → `skills/install-anti-slop/assets/anti-slop/` (excluding `*.test.ts`),
and `--check` mode byte-compares the two trees — CI fails if they differ
(confirmed: `diff -rq` between the two trees in this clone shows only the
excluded test files differ). **But that only covers anti-slop's own repo.**
Once `install.mjs` copies `assets/anti-slop/` into a *third* repo at
`tools/oxlint/anti-slop/`, there is no version pin, no lockfile entry, and no
update mechanism at all — it is a plain file copy. `install.mjs:13-16` refuses
to overwrite an existing destination without `--force`, and `SKILL.md`'s only
guidance for a later resync is "compare its rules and diagnostics before
overwriting" (`SKILL.md:68-70`) — a manual, human-triggered, per-repo diff. N
repos that install anti-slop today will each silently drift from upstream (and
from each other) the moment upstream fixes a bug or adds a rule, with no
signal to any of them that a drift occurred. This is the structural difference
from our own model — see §6.

## 3. Deterministic or agentic?

**Fully deterministic**, and simpler than several rule names suggest: every
rule is `defineRule`/`createOnce` over Oxlint's ESTree AST plus its own scope
manager (`context.sourceCode.getScope`/`scopeManager`) — **no
`ts.TypeChecker` anywhere in the plugin.** `no-known-value-widening` and
`no-unsafe-dictionary-type` look like semantic type analysis (they talk about
"known evidence" and resolve `Record`/`Readonly`/`Pick` generics) but the
resolution is a **hand-rolled syntactic alias graph**
(`src/shared/dictionary-types.ts`) built by walking `TSTypeAliasDeclaration`
nodes in the same file — not asking a real type checker. That's a meaningful
capability boundary: it can't see across files, can't resolve imported type
aliases beyond "trust it, don't flag" (`TypeEnvironment.aliases` is
same-Program only), and has no notion of structural assignability the way
`checker.isTypeAssignableTo` does.

**License:** MIT (`LICENSE`, `package.json`, `README.md` all agree). No
code-borrow restriction.

## 3b. Role in its native architecture — and does it transfer?

Native role: a **CI-blocking lint gate** in whatever repo installs it — every
rule ships at Oxlint severity `"error"`, and the install skill enables all 10
unconditionally (`SKILL.md:43-58`). There is no advisory tier in this model;
Oxlint's rule severities are `error`/`warn`/`off`, and the skill's own
instructions pick `error` for everything, so a downstream repo's first `oxlint`
run after installing gets a hard failure on every match, all 10 rules at once,
regardless of each rule's actual FP profile.

**Does that transfer to us?** Not as-is, and the two most aggressive rules
(`no-runtime-typeof`, `no-shape-in-symbol-names`) demonstrate why: we already
tried something adjacent to both and walked it back. `checkBroadObjectTypes`
(`src/harness/checks/agent-safety-js-correctness.ts:198-211`) explicitly
documents "finding 2026-06: it was firing on legitimate `Record<string,
unknown>`" as the reason `unknown` is deliberately exempt from that check —
`no-unsafe-dictionary-type` bans exactly that shape
(`no-unsafe-dictionary-type.test.ts:35`, `type A = Record<string, unknown>;`
→ `errors: [error]`). Several of our own detectors carry an explicit comment
that `typeof x === "string"` is "THE canonical TS narrowing idiom"
(`agent-safety-js-correctness.ts:85`; also `exhaustiveness.ts:15,260`) —
`no-runtime-typeof` bans every `typeof`, canonical or not. A rule that is
safe-as-a-blocking-gate in a repo the author controls (they can tune it
against their own codebase's usage) becomes unsafe-as-a-blocking-gate in a
harness that ships to *any* repo — exactly the transplant risk
`three-product-architecture.md`'s "role transfer" question exists to catch.
Our role for anything worth adopting from here must be **advisory, phase-post,
with corpus evidence against our own tree before it ever gates** — never
`error`-equivalent on day one.

## 4. Substrate vs. surface

- **Surface:** the Oxlint plugin binding (`definePlugin`/`defineRule` from
  `@oxlint/plugins`) plus the copy-paste install skill. Neither is something
  we'd adopt — we don't want an Oxlint dependency, and we don't want a
  copy-into-repo distribution model (see §6).
- **Substrate:** the 10 detection algorithms themselves — AST pattern matching
  over TS syntax, in a few cases (`no-known-value-widening`,
  `no-unsafe-dictionary-type`, `no-widen-then-assert`) combined with local
  scope/variable resolution. This is the borrowable part, and it borrows as
  **algorithm**, not as **code** — the target AST shape (Oxlint's ESTree +
  scope manager) differs from what our `checks/*.ts` functions consume
  (`(content, filePath) => InlineMatch[]`, built on regex/`stripCommentsAndStrings`
  for lexical checks or the real `typescript` compiler API for anything
  needing actual type information, per `type-smuggling.ts`).

## 5. Lane (1–6)

**Lane 2 (detection technique)**, primary, for all 10 rules — each is a
candidate `checks/<family>.ts` entry. A thin **lane 6 (skip)** sliver for
`no-shape-in-symbol-names` and `no-runtime-typeof` specifically: see the
"not applicable" list below.

## 6. Dependency & displacement

**Deps:** Adopting any of these adds **zero runtime dependency** to us.
`@oxlint/plugins` is a dependency of *their* plugin surface (it supplies
`defineRule`/`definePlugin`/the ESTree types) — none of that is needed once
the detection logic is reimplemented against our own `checks/` contract.
Where a rule needs real scope/variable resolution (`no-known-value-widening`,
`no-widen-then-assert`), the closest existing pattern in our tree is
`type-smuggling.ts`'s runtime-loaded `typescript` compiler API
(`createRequire`-based, already an optionalDependency), not a new package.

**Displacement — the Oxlint-plugin-vs-inline-check tradeoff.** Their model:
one plugin process, invoked by a separate `oxlint` binary the target repo must
install and run (a new devDependency + a new CI step + a new config file per
target repo). Our model: detectors live *inside* the harness daemon itself —
one binary already resident on the hook path, zero additional process, zero
additional dependency in the guarded repo, and the detector code has exactly
one copy (the daemon's own `src/harness/checks/`) rather than one copy per
guarded repo. Porting a rule here means writing its detection logic as a
`checks/<family>.ts` function and a `check-registry/entries-*.ts` entry — it
does **not** mean depending on `oxlint` or `@oxlint/plugins`, and it does not
introduce the vendored-copy drift risk documented in §2: our guarded repos run
*our* daemon build (reinstalled/restarted per the CLAUDE.md staleness
protocol), not a byte-copy of detector source frozen at install time.

**Equivalence, capability-by-capability** — cited both sides, `file:line`.
This is the load-bearing table; each row's verdict is the per-rule column in
the structured output.

| # | Rule | Their evidence | Our evidence | Verdict |
|---|---|---|---|---|
| 1 | `no-chained-type-assertions` | `anti-slop/src/rules/no-chained-type-assertions.ts:39-51` (`isForbiddenAssertionChain` — syntactic chain-length ban, independent of type overlap) | `src/harness/checks/type-smuggling.ts:230-244` (double-cast detector, but scoped to the specific `as unknown as T` shape and gated on real type non-overlap via `isSmugglingCast` at `:129-160`); `src/harness/checks/cast-justification.ts:22,62-81` (any cast needs a `// SAFETY:` comment, chained or not, regardless of type relationship) | **PARTIAL** — we catch the canonical `as unknown as T` chain with real type evidence and require justification for any cast, but a chain of two *type-overlapping* assertions (which anti-slop still bans on sight) passes both of ours cleanly, and a justified chain satisfies `cast-justification` even though `no-chained-type-assertions` would still reject it |
| 2 | `no-conditional-empty-object-spread` | `anti-slop/src/rules/no-conditional-empty-object-spread.ts:42-57,92-131` (ternary-spread-to-omit-field, with an autofix) | none found. Nearest neighbors are mechanism mismatches, not equivalents: `src/harness/checks/agent-safety-advanced-style.ts:264` `checkAccumulatingSpread` (targets O(n²) spread-in-`reduce`, a performance concern); `src/harness/checks/flow-safety.ts:193,241-245` (targets spreading *external input* into a typed slot, a validation concern) | **NEW** |
| 3 | `no-known-value-widening` | `anti-slop/src/rules/no-known-value-widening.ts` (whole file — `hasKnownEvidence` at `:58-78` traces const-bound/literal values across var decls, class fields, returns, arrow bodies, assertions); `anti-slop/src/shared/dictionary-types.ts:336-377` (`classifyWideningTarget`, alias-graph resolution) | `src/harness/quality-checks/ratchet-metrics.ts:110-148` (`countTypeDensity` / `UNKNOWN_ANNOTATION_PATTERN = /:\s*unknown\b/g` — textual annotation count, no dataflow); `src/harness/quality-checks/ratchet-comparison.ts:264-295` (`checkTypeDensityRatchet` — regression-only, fires only when a file's count rises across one edit, not an absolute ban); `src/harness/checks/agent-safety-js-correctness.ts:213-250` (`checkBroadObjectTypes` — same annotation-site idea but explicitly excludes `unknown`, see §3b) | **PARTIAL** — we ratchet the surface symptom (annotation counts, net-new-per-edit only); nothing in our registry does the known-value dataflow trace that is this rule's actual mechanism |
| 4 | `no-object-parameters` | `anti-slop/src/rules/no-object-parameters.ts:35-112` (parameter-scoped, resolves zero-arg local aliases through a same-file alias map) | `src/harness/checks/agent-safety-js-correctness.ts:213-250`, `BARE_OBJECT = /(?::\|\bas)\s+object\b/` at `:236` — fires on `: object`/`as object` at **any** annotation site (broader surface: params, properties, returns, casts), but pure regex-literal with **no alias resolution** (`type Alias = object; function f(v: Alias)` is invisible to us, caught by theirs); registered `pre_warn`, default gate (`entries-warnings/agent-clarity.ts:514-527`), not advisory | **PARTIAL** — location-agnostic-but-literal (ours) vs. parameter-scoped-but-alias-resolving (theirs) |
| 5 | `no-runtime-typeof` | `anti-slop/src/rules/no-runtime-typeof.ts:16-24` (every `typeof`, no exceptions) | Nothing bans `typeof`. Multiple detectors explicitly **exempt** the narrowing idiom by design: `src/harness/checks/agent-safety-js-correctness.ts:85`, `src/harness/checks/exhaustiveness.ts:15,260`, plus test-pinned exemptions in `error-handling.test.ts:1717`, `tainted-sink.test.ts:106`. Empirical: **1,533 `typeof` occurrences across 381 non-test files** in our own tree (measured this session, `rg -c '\btypeof\b'` over `src/`, test files excluded) | **NEW** (no equivalent exists) — but see §9: this is a reject, not a port |
| 6 | `no-shape-in-symbol-names` | `anti-slop/src/rules/no-shape-in-symbol-names.ts:4-8,33-37` (case-insensitive substring, all identifier kinds, no escape hatch) | `src/harness/checks/taste-leaf-checks.ts:22-49` (`checkNarrativeNaming` — exact-match blocklist of `data/result/temp/tmp/val/value/obj/item/stuff/thing/info/ret/output`, `const`/`let`/`var` declarations only, exempts a variable that carries a non-vague type annotation). Different mechanism (exact-match vs. substring-anywhere), different scope (declarations only vs. every identifier kind), and "shape" is not on our list. Empirical: **68 distinct identifiers, 164 occurrences** containing "shape" in our own non-test `src/` (e.g. `diffByValueShape` ×10 in `manifest-edit-guard.ts`, `SchemaShape` ×8 in `cross-file.ts`, `MAX_SHAPE_MEMBERS`/`describeShape` in `payload-key-census.ts`) | **NEW** (mechanism) — but see §9: reject, not port |
| 7 | `no-unknown-parameters` | `anti-slop/src/rules/no-unknown-parameters.ts:43-83`, `cause` exception at `:61` | `ratchet-metrics.ts:111` `UNKNOWN_ANNOTATION_PATTERN = /:\s*unknown\b/g` folded into `countTypeDensity` — whole-file count, not parameter-scoped, regression-only, no `cause` exception | **PARTIAL** |
| 8 | `no-unknown-type-aliases` | `anti-slop/src/rules/no-unknown-type-aliases.ts:16-69` (`resolvesToUnknown`, alias-chain resolution) | None. `UNKNOWN_ANNOTATION_PATTERN` requires a literal `:` immediately before `unknown` (`ratchet-metrics.ts:111`) — a bare `type Foo = unknown;` alias declaration has no such colon and is invisible to every check we have | **NEW** |
| 9 | `no-unsafe-dictionary-type` | `anti-slop/src/rules/no-unsafe-dictionary-type.ts:48-94`; `anti-slop/src/shared/dictionary-types.ts` full alias/generic/`Pick`/`Omit`/`Readonly` resolution; heaviest-tested rule (38 invalid cases) | `agent-safety-js-correctness.ts:213-250` — `RECORD_ANY`/`INDEX_ANY` regex already does the `any`-branch job with equivalent scope (`Record<K, any>`, `{[k]: any}`); `unknown`-branch is **explicitly, deliberately excluded** with a cited 2026-06 production-FP fix (`:207-211`) — direct contradiction of anti-slop's own test suite (`no-unsafe-dictionary-type.test.ts:35`); `object`/`{}`-as-dictionary-value and the alias/generic resolution machinery have no equivalent at all | **PARTIAL** (any-branch ≈ already-have; unknown-branch contradicted, not missing; object/{}-branch + resolution depth genuinely new) |
| 10 | `no-widen-then-assert` | `anti-slop/src/rules/no-widen-then-assert.ts:263-312` (`widenedBinding`/`assertionIsNarrower` — cross-**statement** dataflow: declare broad-with-known-evidence, later re-assert narrower) | `type-smuggling.ts:139-140` explicitly **exempts** casts *from* a statically-`unknown` source ("`x as unknown` is the recommended pattern after `JSON.parse`") — which is exactly the source type a widen-then-assert variable has by the time it's re-asserted, so our nearest tool is designed to walk past this pattern, not catch it. `cast-justification.ts` only inspects the assertion line itself, never the variable's declaration | **NEW** — and unlike rows 5/6, this is a real gap worth closing (see §7) |

## 7. Smallest spike (≤1 day)

Port **`no-conditional-empty-object-spread`** (row 2) as a new
`checks/<family>.ts` detector, `post`/advisory:

1. AST walk (reuse the `typescript` optionalDependency parser, parse-only —
   no checker needed) for `SpreadElement` whose argument is a
   `ConditionalExpression` with `{}` on one branch and a single-property
   object on the other.
2. Port `undefinedCheckedExpression`/`canAutofixConditionalEmptyObjectSpread`
   (`anti-slop/src/rules/no-conditional-empty-object-spread.ts:59-90`) for the
   optional "the ternary's undefined-check target textually matches the
   property value" refinement — or skip the refinement and just flag every
   instance for v0 (report-only, no autofix, matching our registry's
   `InlineMatch[]` contract).
3. Register in `check-registry/entries-warnings.ts` + `check-metadata.ts`;
   `DEFAULT_ADVISORY_SKIPS` entry with rationale.
4. Ship the `post`/advisory tier's 1+/1− minimum case pair (Check Evidence
   Contract), plus a corpus scan (`interlinked recurrence scan` /
   `check-corpus.json` pattern) confirming near-zero fires on our own tree
   before it ships even as advisory.

If a second rule fits the same budget, **`no-unknown-type-aliases`** (row 8)
is comparably small — single-file, type-position-only AST walk, no cross-file
resolution, and it closes a real, uncontroversial blind spot
(`UNKNOWN_ANNOTATION_PATTERN`'s colon-anchored regex literally cannot see a
bare alias declaration). `no-widen-then-assert` (row 10) has the strongest
bug-class argument of the five NEW rows — but needs the same class of
local-scope/declaration tracing `type-smuggling.ts` already does, which pushes
it past a single-day spike into "next `type-smuggling.ts` extension,
scoped separately."

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | `no-conditional-empty-object-spread` (+ optionally `no-unknown-type-aliases`) as new advisory `checks/` detectors | §7 | now |

Guardrails (P2–3) and Agent CI (P4–5) rows are **not applicable** — every rule
here is syntactic AST pattern matching or same-file scope resolution, fully
within the Free CLI's compute and determinism budget; nothing in this find
needs inference, centralized state, or heavy cross-repo compute.

## 9. Artifact

Compound:

1. **PR** — port `no-conditional-empty-object-spread` (row 2) as a new
   `post`/advisory `checks/` detector per §7. Optionally also
   `no-unknown-type-aliases` (row 8) in the same PR if the case-authoring
   budget allows; both are small, uncontroversial, and close real gaps rather
   than duplicating an existing ratchet.
2. **Memory note** — record two collisions as *confirmations*, not gaps: (a)
   `no-runtime-typeof` vs. our documented `typeof`-narrowing exemptions,
   backed by the 1,533-occurrence corpus count; (b) `no-unsafe-dictionary-type`'s
   `unknown`-branch vs. `checkBroadObjectTypes`'s documented 2026-06 FP fix on
   `Record<string, unknown>`. Both are cases where an external, independently-
   written rule reached for the *opposite* answer we already reached by
   measurement — worth keeping as evidence the exemption was the right call,
   re-checked if either check's calibration is ever revisited. Also record the
   vendored-copy drift risk (§2) as a negative case study: not actionable for
   us today (we don't distribute detectors as copy-paste-into-repo skills),
   but worth the reminder if that model is ever proposed for our own checks.
3. **No RFC.** The whole find resolves cleanly to lane 2 (detection
   technique); nothing here raises an architecture question.

## Notes

**Explicit "not applicable — because" list:**

- `no-runtime-typeof` — contradicted by our own documented design decision
  (typeof-narrowing is "THE canonical TS narrowing idiom",
  `agent-safety-js-correctness.ts:85`) and by measurement (1,533 occurrences,
  381 files, in our own tree — nearly all of them legitimate narrowing, CJS/ESM
  interop checks, or feature detection, not "ad hoc" anything).
- `no-shape-in-symbol-names` — bans a single ordinary English word that is
  also standard TypeScript structural-typing vocabulary ("the shape of a
  value"). Measured 68 distinct identifiers / 164 occurrences in our own
  non-test source, all legitimate (`SchemaShape`, `DeclaredShape`,
  `MAX_SHAPE_MEMBERS`, …). Reads as a personal naming preference from the
  author's own codebase generalized into a "generic" rule — arguably in
  tension with the plugin's own `AGENTS.md:4` ("Keep rules generic… do not add
  application-specific names").
- `no-unsafe-dictionary-type`'s `unknown`-value branch specifically (the
  `any`/`object`/`{}` branches remain a legitimate NEW/PARTIAL target) —
  directly contradicted by a cited production false-positive fix already
  shipped (`agent-safety-js-correctness.ts:207-211`).

**Marketing-vs-reality, twice in one repo.** `no-runtime-typeof`'s doc string
says "requires boundary parsing instead of ad hoc `typeof` narrowing" — the
source has no ad-hoc/canonical distinction; it flags 100% of `typeof` uses.
`no-shape-in-symbol-names`'s doc string frames it as generic low-signal
hygiene; the source is a hardcoded ban on one specific word. Both required
reading `src/rules/*.ts` directly, per the standing rule from
`docs/external-pulse/codewiki.md`.

**Test-evidence gap.** 7 of the 10 rules ship with zero automated tests, and
CI (`pnpm check`) is green regardless — `package.json`'s `test` script only
invokes the 3 that have `.test.ts` files. Under our own Check Evidence
Contract, a `post`/advisory check needs ≥1 positive/1 negative case minimum;
none of the 7 untested rules would clear even that floor today. Doesn't block
porting the detection *logic* — the algorithms are still legible and
independently verifiable by reading them — but it means anti-slop's own test
suite can't be trusted as a source of ready-made fixtures for most of the 10;
new cases have to be authored from scratch either way.

**Repo maturity.** Single commit, freshly extracted from the author's own
project (`git log`: one entry, "feat: extract anti-slop Oxlint plugin"). No
independent revision history, no issues/PR history visible in this shallow
clone. Treat the rule *shapes* as a curated idea list, not as field-tested
policy — none of the 10 has had time to accumulate real-world FP reports the
way our own `checkBroadObjectTypes`/`typeof`-exemption decisions already have.

## Methodology notes

Two of this session's strongest findings came from a cheap, repeatable move
not in the base rubric: after reading a rule's *intent*, grep our own `src/`
for the exact shape it would ban and count the hits. That turned "this rule
sounds strict" into a citable number (1,533 `typeof` occurrences; 68 `shape`
identifiers) in under a minute per check, and is what elevated two rows from
a soft "we disagree" to a hard "we already measured this and it was wrong."
Worth folding into the standard intake flow whenever a candidate rule's ban
surface is broad enough that a grep can approximate its future fire rate
before writing a single line of the port.
