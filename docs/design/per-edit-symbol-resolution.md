# Per-edit symbol resolution — an open question, and the measurement for it

**Status:** measuring. Metric shipped 2026-07-28. **Decision due ~2026-08-04.**
Nothing is gated on this yet, and nothing should be until the data is in.

## The question

Should the harness discourage edits that change many symbols at once?

It arose from a narrower one — *"should we add a rule that discourages
MultiEdit?"* — and the narrow framing is wrong for two reasons worth recording,
because they are the reasons not to just ship the obvious rule.

**Interlinked ships its own multi-edit primitive.** `src/commands/multi-edit.ts`
exists precisely because "the Edit tool applies one replacement at a time, and
the tsc/biome diff-overlays check each intermediate state. Coordinated changes
that cross multiple sites in one file … deadlock under serial Edits because one
half of the change is invalid without the other." A rule discouraging multi-edit
would fight a tool this product deliberately built to unblock a real deadlock —
one hit repeatedly during the 2026-07-27/28 session ("add the import AND use it"
is refused as two serial Edits, every time).

**The tool is the wrong unit.** The plausible harm is not "MultiEdit was used",
it is *resolution loss*: every per-edit ratchet — cyclomatic slew (+2/edit),
coverage delta, mutation site count — is calibrated on the delta of ONE edit. An
atomic change touching eight functions is gated as one aggregate delta rather
than eight steps, so a slew limit meant to bound per-step growth bounds the sum
instead. That property belongs to *how much changed*, not *which tool changed
it*: a 400-line `Write` loses exactly as much resolution as an eight-site
MultiEdit, and a tool-shaped rule would miss the first while flagging a benign
two-site rename.

## Why this is not already a check

No corpus evidence. At the time of writing, MultiEdit had not been invoked once
in the session that raised the question — it is not even in that runner's
toolset. Shipping a gate now would encode taste calibrated against nothing.

This repo has a precedent for exactly that mistake: `halstead_difficulty` was
tuned on unit-test fixtures at a difficulty ceiling of 25, and the corpus run
over 9023 real functions showed 25 was the *75th percentile* — 2226 findings.
Recalibrated against the tree, it produces 17. **Calibrate against the tree,
never against fixtures.**

And a gate that fires on legitimate use is worse than no gate: it trains the
agent to discard harness output. The same session diagnosed `commit-cadence`
telling an agent to `git commit` — the one action it must not take unprompted —
which was correctly ignored nine times running.

## What shipped instead

`fnΔ N` on the per-edit pulse line, beside the existing `ΣCC`, `cogΣ` and `astΔ`:

```
[interlinked:cyclomatic] src/foo.ts: 3 fns, ΣCC 13 (Δ+5), max alpha=8 (cap 25);
  fnΔ 3; Δ fns: alpha 5→8, gamma new=2; cogΣ 21 (Δ+4); astΔ 7
```

- **Where:** `src/harness/evaluator/complexity-pulse.ts::formatComplexityPulse`
- **Cost:** none. Derived from `namedDeltas`, already computed for `Δ fns`.
- **Gate:** none. It counts and says nothing.

### It undercounts, on purpose

`fnΔ` counts functions **added, removed, or changed in branch count**. It does
NOT see a function whose body changed without moving its cyclomatic number — a
renamed local, a different string literal, a reordered pair of statements. A
cheap lower bound beats a second AST walk on the hot path.

This matters when reading the data: `fnΔ` is a floor on symbols touched, so any
correlation found is, if anything, understated. Do not report it as "symbols
changed".

## The decision, and how to make it

**In ~a week (from 2026-07-28), answer: does high `fnΔ` predict worse outcomes?**

The honest null hypothesis is that it does not — that large `fnΔ` is simply what
a legitimate coordinated refactor looks like, and gating it would punish correct
work. Take that seriously; it is the likelier result.

```bash
# The pulse lines carry fnΔ; guard verdicts and check outcomes live alongside.
interlinked query checks --by checks.id --since 7d
interlinked logs --type post_tool | rg -o 'fnΔ [0-9]+' | sort | uniq -c | sort -rn
```

What would justify a check:
- High-`fnΔ` edits are followed by a **later** block/fix on the same file at a
  materially higher rate than low-`fnΔ` edits (resolution loss let something
  through that per-step gating would have caught), **and**
- the high-`fnΔ` population is not dominated by legitimate coordinated refactors
  (renames, signature widenings) — sample them and read the diffs.

What would kill it:
- The distribution is thin above ~3 and the tail is all renames. Then `fnΔ` stays
  an ambient number, this document records why, and no rule ships.

If it does ship, the check is tool-agnostic and writes itself: *"this edit moved
N functions at once; the per-edit ratchets can only see the aggregate."* That
catches the oversized `Write` too, which a MultiEdit rule never would.

## Related

- `docs/design/monotonic-metric-ratchet.md` — the per-edit ratchets whose
  resolution this is about
- `src/commands/multi-edit.ts` — the primitive that exists for the deadlock
- `docs/design/verification-density-program.md` — the corpus-calibration rule
