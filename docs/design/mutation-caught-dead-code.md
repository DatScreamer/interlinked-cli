# What mutation testing caught that static analysis could not — and the honest limit of that claim

> **Document role.** Answers one precise question: of the inert / dead code our
> per-edit mutation campaign surfaced (as surviving / equivalent-candidate
> mutants), how much could a deterministic or static tool NOT have found on its
> own? Every file:symbol below is read from source; every count is from the
> named artifact. **No source was edited to produce this document.** It is a
> reading of `scratch/fleet-r3/receipts/*.jsonl`, `scratch/fleet-r3/prover-round2/`,
> and `docs/design/mutation-residue-ledger.md`, not a re-transcription of prior
> prose.
>
> **One-line answer, stated up front so the rest can qualify it:** mutation
> testing *surfaced* a large class of reachable, runtime-inert code that no
> static tool even looks at (748 of 749 candidates) — but it *proved* exactly one
> mutant dead, and that one mutant a dead-code linter would also have caught. Its
> unique contribution is the **hypothesis**, not the **proof**.

---

## 1. The boundary, defined crisply

A mutant *survives* when no test distinguishes the mutated program from the
original. A survivor is a **candidate** for "the mutated code is inert" — not a
proof (see §6). The question is which candidates a static tool could have
reached without mutation at all. Three static classes bound that, and each has a
precise blind spot:

| Static class | Concrete tool | Catches | Blind to |
|---|---|---|---|
| **(a) Structural dead code** | `dead_exports`, unreachable-code, call-graph | Code that **never executes** — an unexported symbol with zero readers, a branch after `return`, an unreferenced constant | Code that **does** execute on a live path but has no observable effect |
| **(b) Compiler-DCE-visible inert code** | TCE (esbuild/terser minify + byte-compare) | Code the optimizer can prove removable by local rewriting — a dead store, a constant-folded branch | Effects that require whole-program reasoning the optimizer is not allowed to assume |
| **(c) Type-provable inert code** | `@typescript-eslint/no-unnecessary-condition`, our typeflow prover | A guard the **type** makes always-true / always-false (narrowed non-null, closed literal union) | A guard whose type genuinely admits both outcomes but whose *runtime value* never takes one |

**Mutation-only inert code** is the residue that escapes all three at once. It
is, precisely:

> **reachable** (so (a) sees a live line), **run to completion producing a used
> value** (so (b) may not delete it), and gated by a condition the **type system
> admits on both sides** (so (c) proves nothing) — yet inert because of a
> *whole-program runtime invariant*: idempotence, downstream nullification, a
> caller precondition, a sibling guard, or a state the program never actually
> produces.

The inertness is a property of the whole program's data, not of any one
expression's syntax or type. That is exactly the fact a mutation — a
counterfactual "make it different and see if anything notices" — is built to
probe, and that a static tool, reasoning locally over syntax and types, is not.

---

## 2. The mutation-only table (a static tool misses each of these)

Each row is a real surviving / equivalent-candidate mutant from the campaign.
"Why static misses" names which of the three classes fails and why. "Proof" is
per §6: **candidate-fuzz** (N-input search, no counterexample), **candidate-arg**
(one-line structural argument, no search), **proven-TCE** (machine byte-compare).

| # | file :: symbol | Mutation | Mechanism (why it's inert) | Why (a)/(b)/(c) all miss it | Proof |
|---|---|---|---|---|---|
| 1 | `package-install-parser.ts` :: `stripWrappers.consumeEnvVar` | `if (eq <= 0) return` → `false` | **Caller-invariant dead guard.** `consumeEnvVar` is only ever called with a string already matched against `/^[A-Za-z_]\w*=/` (lines 266, 272), so `indexOf("=") ≥ 1` always; `eq <= 0` is unreachable-*by-value*. | (a): the guard is on a live path — the line runs, it just never takes the branch. (c): `eq` is `number`; the type admits ≤ 0 (`indexOf` can return −1), so no-unnecessary-condition sees a legitimate check. The invariant lives at two *other* call sites, one of them recursive — a cross-function dataflow fact no local rule models. | candidate-fuzz (800) |
| 2 | `package-install-parser.ts` :: `stripWrappers` | `if (next) …` → `if (true) …` | **Caller-invariant dead guard.** `next` is read immediately after `out.shift()` on an element the enclosing `while (out[0] && …)` already confirmed truthy. | (a): live line. (c): `next` is `string \| undefined` — the type genuinely admits `undefined`, so the guard is type-necessary; only the loop-condition invariant makes it dead. | candidate-fuzz (821) |
| 3 | `checks/iteration-safety.ts` :: `findBodyOpen` | `semicolon < openBrace` → `semicolon <= openBrace` | **Distinct-character index invariant.** Both operands are `slice.indexOf(...)` of *different* single chars (`";"` and `"{"`) in the *same* string; one position holds one character, so equality is structurally impossible when both are found. | (a): live comparison. (b): both are runtime `.indexOf` results — nothing to fold. (c): both `number`; `<` vs `<=` both type-check. The impossibility of `a === b` is a property of string indexing, which no type or optimizer models. | candidate-fuzz (320) |
| 4 | `checks/shared-scan.ts` :: `typeOnlyTopLevelModeAt` | `return "type"` → `return ""` | **Downstream-nullified sentinel.** The literal `"type"` is never compared anywhere; every consumer branches only on `=== "interface"` / `=== "import-type"` (lines 98, 125, 162, 186), so any *other* value (including `""`) is treated identically. | (a): the value is returned and flows through the program — fully reachable. (c): `"type"` is a legal member of the `TypeOnlyTopLevelMode` union, so exhaustiveness and no-unnecessary-condition see a valid, used value. Its deadness is that no consumer *discriminates on it* — a whole-program usage fact. | candidate-fuzz (390) |
| 5 | `checks/taste.ts` :: `findPositionalOptionalBoolean`, `isOptionalParam`, `splitTopLevelParams`, `checkFunctionArity` | drop `.trim()` in `x.replace(/…/,"").trim()`; and `/^…\s+/` → `/^…\s/` | **Trim-idempotence chain.** Every param string is already `.trim()`'d upstream by `splitTopLevelParams`'s `.map(p => p.trim())`; the modifier regex's own `\s+` consumes any interior gap; a *trailing* `.trim()` in the same expression re-strips whatever a weakened `\s+`/`\s*` quantifier leaves. The whitespace the mutated code would handle differently never exists at that point. | (a): all lines run. (b): `.trim()` returns a used value — the optimizer cannot delete a call whose result feeds the next step. (c): no type angle at all — string identity under repeated normalization. Requires tracing normalization across three helper hops. | candidate-fuzz (2485) |
| 6 | `checks/redos-catastrophic.ts` :: `checkRedosCatastrophic` | `i < lines.length` → `i <= lines.length` | **Phantom last-iteration masking.** The off-by-one runs one extra iteration on `lines[len] ?? ""`; the empty string fails the `includes("(")` fast-path (and every open-block early-return), so the phantom pass produces no state change. | (a): the loop body is reachable and the extra pass *executes*. (b)/(c): both operands `number`; nothing to fold or type-narrow. The masking is that a specific downstream fast-path collapses the extra input to a no-op — a value-dependent runtime fact. | candidate-fuzz (400) |
| 7 | `checks/agent-safety-advanced.ts` :: `checkCircularImports.dfs` | `cycles.length >= MAX_PATHS` → `false` | **Redundant guard over an unproduced state.** The entry guard is masked by an identically-worded sibling guard re-checked before every `push`; `MAX_DEPTH` independently bounds recursion, so weakening the entry guard cannot even cause runaway growth. Defense-in-depth — **keep, do not remove.** | (a): reachable guard. (c): `cycles.length` and `MAX_PATHS` are `number`; the comparison is type-valid. The redundancy is that a *second, syntactically separate* guard already enforces the bound — invisible to any single-expression analysis. | candidate-arg (exhaustive-tag) |
| 8 | `checks/agent-safety-advanced.ts` :: `collectLifecycleBodies` | `if (balanced)` → `if (true)` | **Position-independent depth-0 invariant.** The function only scans a `classBody` that the caller already proved brace-balanced; a nested single-brace sub-scan inside balanced outer text is mathematically guaranteed to reach depth 0 before the text ends, so `balanced` is always true. | (a): reachable. (c): `balanced` is `boolean` — the type admits `false`. The proof that it can't *be* false is a brace-counting argument over the caller's precondition, which no type checker or optimizer performs. | candidate-fuzz (500) |
| 9 | `checks/agent-safety-advanced.ts` :: `checkDefaultExport` | `/^export\s+default…/` → `/^export\sdefault…/` | **Upstream-gate-masked quantifier.** Every candidate line already passed a literal `line.startsWith("export default")` string gate (exactly one space) before reaching this regex, so no input that would distinguish `\s+` from `\s` can arrive. Defense-in-depth — **keep.** | (a): reachable regex. (c): regex-internal quantifier — outside every type tool's model entirely. The filtering happens in a *prior, separate* string comparison; only whole-path reasoning connects them. | candidate-arg (exhaustive-tag) |
| 10 | `checks/taste.ts` :: `extractParamStr` | `-1` → `+1` (loop start sentinel) | **Depth-tracked dead path.** Reaching the corrupted-start second-loop path requires an unbalanced `<` before every reachable `(`; that same `<` is tracked identically by `splitTopLevelParams`/`isOptionalParam`'s own depth counters, which mask any garbage the corrupted start extracts. | (a): reachable. (c): `number` arithmetic. The masking is a cross-function depth-counter agreement — a runtime invariant spanning three functions. | candidate-fuzz (2485) |
| 11 | `checks/introverted-test.ts` :: `rankValue` / `isPrimitiveLiteral` | 17 Conditional/Logical/Block mutants on the leaf-node path | **Leaf-token rank convergence.** `rankValue` short-circuits `if (isPrimitiveLiteral(node)) return NONE` (line 231); for leaf-literal inputs, multiple downstream branches all converge on the same `NONE` rank, so mutating them changes no classification. | (a): reachable branches. (c): the mutated conditions are type-valid. Convergence-on-one-value across branches is a semantic fact of the rank lattice. **Weakest evidence in this table** — see proof column. | candidate-arg (structural, no search) |

Rows 7 and 9 (plus six more like them, 15 mutants total across
`agent-safety-advanced.ts` and `package-install-parser.ts`) are the
**defense-in-depth-keep** set from `mutation-residue-ledger.md` §6: inert today,
but a deliberate redundant trust-boundary guard whose invalidation trigger is
named. They are mutation-only *and* explicitly not removal candidates.

---

## 3. The statically-catchable counter-examples (be honest: static WOULD find these)

Not everything the campaign flagged is beyond static reach. Reporting only §2
would be dishonest. Two rows go the other way:

| file :: symbol | Mutation | Which static tool catches it, and how | Proof |
|---|---|---|---|
| `checks/cyclomatic.ts` :: `(module)` — `CLOSE_BRACE` | `const CLOSE_BRACE = "}"` → `""` | **Structural dead constant, zero readers.** `rg CLOSE_BRACE` returns exactly one line — the declaration. A dead-code linter (`knip`, `ts-prune`, oxlint `no-unused-vars`, or tsc with `noUnusedLocals`) flags an unreferenced module-level `const` directly, no mutation needed. **This repo's `tsconfig` does not set `noUnusedLocals`, so its own tsc misses it — but the tool *class* (a) catches it trivially.** | **proven-TCE** — the one machine-proven mutant in the whole pool |
| `checks/redos-catastrophic.ts` :: `regexBodies` | `[]` → `["Stryker was here"]` | **Partly type-position.** 2 of the 3 textual `[]` occurrences in scope are TypeScript type annotations (`string[]`), erased at compile time — a type-aware / compiler pass sees they are not runtime values at all. Only the one real value-position `[]` is a genuine runtime mutant. | candidate-fuzz (400) for the value position |

The `CLOSE_BRACE` row is the crux of the honest split: it is the single mutant
in the entire pool with machine evidence at every rung (grep-dead, TCE
byte-identical, 320/320 fuzz) — and it is **structural dead code a linter owns**.
Mutation did not need to run to find it.

---

## 4. The quantified split

**Pool:** 749 deduped, still-`survived` equivalent-candidate mutants
(`scratch/fleet-r3/prover-round2/pool-summary.json`, generation of 2026-08-15;
4391 receipt rows → 869 candidate rows → 791 deduped → 749 survived). The
earlier campaign-scoped ledger pool of 581 (29 files) agrees on the two prover
counts below.

Two sound provers ran the whole pool
(`scratch/fleet-r3/prover-round2/round2-summary.json`):

| Static class | Denominator | Confirmed | Not catchable |
|---|---:|---:|---:|
| **(c) type-provable** (typeflow / no-unnecessary-condition) | 409 type-eligible¹ | **0** | 409 |
| type-tool scope by mutator kind | — | — | 340 outside scope² |
| **(b)+(a) DCE / dead-const** (TCE byte-compare) | 749 | **1** | 748 |

¹ Typeflow examines only `{ConditionalExpression, EqualityOperator,
LogicalOperator, OptionalChaining}` (277 + 99 + 25 + 8 = 409). It proved **0** of
them — every type-eligible candidate is a guard whose type admits both outcomes;
its inertness is runtime, not type.
² The other 340 mutants are `Regex` (120), `StringLiteral` (83),
`MethodExpression` (42), `BlockStatement` (36), `ArrayDeclaration` (23),
`ArithmeticOperator` (14), and a tail — mutator kinds **no type-based tool
addresses at all**.

**Headline split of the 749-mutant pool:**

- **Statically catchable: 1 (0.13%)** — `CLOSE_BRACE`, by dead-code linting (a),
  confirmed removable by TCE (b).
- **Not catchable by any of the three static classes: 748 (99.87%)** — reachable,
  non-DCE-removable, type-admissible. This is the mutation-only class, and it is
  the answer to the question: static analysis structurally does not look here.
- **Catchable specifically by type analysis (c): 0 of 749.**

So mutation testing's unique *reach* is real and large: 748 candidates sit in a
region all three static classes are blind to by construction. The one candidate
static would have caught is also the only one mutation *proved*.

---

## 5. Named pattern families (the mechanisms, aggregated)

Grouping the mutation-only pool by the runtime mechanism its `why` field
describes (keyword scan over 931 `equivalent_candidate` receipt rows):

| Pattern family | Distinct sites | Mechanism class |
|---|---:|---|
| Trim-idempotence chains | 29 | idempotent normalization already applied upstream |
| Caller-invariant / unreachable-by-value guards | 10 | precondition guaranteed at every call site |
| Downstream nullification / masked / subsumed | 31 | a later step collapses the difference to a no-op |
| Phantom last-iteration masking | 3 | off-by-one whose extra pass hits a fast-path no-op |
| Position-independent depth-0 scans | 5 | brace/paren depth invariant makes the scan position-free |
| `isPrimitiveLiteral` leaf-token convergence | ≥17 (1 site) | multiple branches converge on one rank value |
| Dead constant, zero readers | 1 | **structural — statically catchable (§3)** |

Every family except the last is mutation-only. The last is the counter-example.

---

## 6. Proof status — the caveat that governs the whole document

**A surviving mutant is a candidate, not a proof.** Restraint on over-claiming
here is not pedantry; it inverts the headline.

- **Proven inert (machine-checked): 1 of 749.** Only `CLOSE_BRACE` cleared a
  sound prover (TCE byte-identical output). Typeflow proved **0**. And that one
  proven mutant is the *statically-catchable* one — so **proven mutation-only
  dead code = 0.**
- **Candidate, fuzz-backed: ~508** (in the 581 campaign pool; the bulk of the
  748 here). "≥ 300 diverse inputs, zero divergence" is an unbounded empirical
  search that found no counterexample — it never rises to `proved_equivalent`.
- **Candidate, argument-only: 72 "exhaustive"-tagged + a structural tail.** The
  ledger (§3.4) verified that **0 of 72** `decided_by:"exhaustive"` rows actually
  enumerate a bounded domain; all 72 are structural / loop-invariant prose an
  agent wrote and no machine ran. Rows 7, 9, 11 in §2 are this tier. Row 11
  (`isPrimitiveLiteral`, `structural_argument`, no search at all) is the weakest.

The correct reading, therefore: **mutation testing did not *prove* any dead code
that static analysis missed. It *surfaced* 748 reachable, type-valid,
non-removable candidates that no static class examines — a hypothesis-generation
win, not a proof win.** Nine of those (rows 1–6, 8, 10 and the `consumeEnvVar`
sibling) rest on thousands of zero-divergence fuzz inputs and a legible
cross-function invariant, which is strong evidence; but "not falsified by fuzz"
is timestamped, not permanent. The ledger's own §3.5 records **48** mutants that
a prover could not confirm and that were later *killed* by ordinary
test-writing — direct proof that "candidate-inert today" routinely turns out to
be "test gap." That is why the campaign removed nothing: candidacy is not a
license to delete.

---

## 7. Bottom line

The class of inert code mutation reaches and static analysis does not is genuine
and precisely characterized — reachable, DCE-surviving, type-admissible code made
inert by a whole-program invariant (§1, §2, §5), 748 of 749 candidates (§4). But
the honest score on *proof* is 1 proven mutant, and that one a linter owns (§3,
§6). Mutation testing's value here is the **question no static tool asks** — "does
anything actually observe this line's behavior?" — not a stack of proven
deletions. Treat the 748 as a ranked review queue backed by fuzz and a stated
invariant, never as confirmed dead code.
