# Check Evidence — per-check case attribution (decision memo)

Status: DECIDED 2026-08-09, staged. Measurement first; enforcement later.
Owner surface: `src/harness/check-evidence/` (case-parser, extract, obligations).

## Problem

`casesAcross` credits every labeled case in every test file that references a
detector's function name. A shared suite therefore over-credits: on 2026-08-09,
nine new `N#:` cases in `taste-checks.integration.test.ts` satisfied the
negative obligation of 17 distinct checks at once. The contract documents this
generosity (resolve.ts), but it weakens what "evidence" means: a check can pass
its tier with zero cases that exercise its own detector.

The inverse flaw (hyphen-dialect labels counted as nothing) was fixed the same
day in `directionFromTitle`. This memo covers the over-credit direction only.

## Decision

1. **Attribution rule.** A labeled case attributes to check X when the title
   chain of its enclosing `describe` blocks names X's detector function or X's
   check id (case-insensitive substring). Fallback: in a test file whose
   identifiers reference exactly ONE registered detector, every labeled case
   attributes to that check — companion suites need no describe ceremony.
2. **Staging.** Ship attribution as a MEASURED dimension first: extend the
   evidence record with attributed counts beside the file-level counts, and
   report shortfalls without failing the pin. Enforcement flips per the
   baseline's grow-only `enforced` field, and only after a sweep shows which
   checks would regress and a targeted backfill closes those gaps. The
   grandfather list is shrink-only, so enforcing early would strand
   already-cleared checks with no legal path back — that ordering is the whole
   reason for the staging.
3. **Fleet rule, effective immediately.** Every evidence-backfill contract
   demands per-detector cases: each case calls its own detector and lives under
   a describe naming it. The 2026-08-09 fleet already met this bar, so new
   evidence is attribution-clean regardless of when enforcement lands.

## Non-goals

- No retroactive relabeling of existing suites.
- No semantic parsing of describe titles beyond substring matching.
- No change to the two labeling dialects (phrases incl. hyphenated, P#/N#).

## Implementation sketch (next session)

- `case-parser.ts`: record the enclosing describe-title chain per case (the
  frame stack already exists).
- `extract.ts`: compute `attributed_positive/negative` per check beside the
  file-level counts; verdicts gain a reported-not-enforced shortfall kind.
- Sweep + report the regression list; schedule the backfill fleet from it.
