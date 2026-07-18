1. [severity: high] [src/harness/spec/extract-ids.ts:21] Dashed IDs with four-digit numeric components, including the explicitly discussed `FG-INV-2024`-style namespace family, are never extracted, making the subsequent year filter unreachable for dashed IDs.
   Evidence: `const DASHED_ID_RE = /\b([A-Z][A-Z0-9-]{0,30})-(\d{1,3})\b/g;`
   Why: `\d{1,3}` cannot match four digits, while `looksLikeYear()` claims to reject values from 1900 through 2099. More generally, legitimate registries using IDs above 999 are silently omitted.

2. [severity: high] [src/harness/spec/extract-ids.ts:255] The range regex permits a different or missing prefix at the upper endpoint and then mis-parses that endpoint as digits embedded in the wrong ID.
   Evidence: Input `FG-INV-01 through OTHER-20` produces `{ prefix: "FG-INV", from: 1, to: 20 }` because `(?:\1-|\1)?` is optional and matching can resume at `20`.
   Why: This fabricates a valid-looking `FG-INV` range from prose that explicitly names a different namespace, causing false ledger drift findings.

3. [severity: high] [src/harness/spec/extract-ids.ts:255] Compact ranges with a repeated prefix are mis-parsed because the optional separator dash can be absorbed into the captured prefix.
   Evidence: Input `W1–W9 in order` can capture prefix `W1–W`, `from: 9`, or fail rather than reliably yielding `W`, `1`, `9`; the pattern starts with `([A-Z][A-Z0-9-]{0,30}?)-?(\d{1,3})`.
   Why: The prefix class allows digits, and the lazy quantifier may backtrack across the first number and separator to satisfy the rest. The existing test expects this exact compact form but does not establish that the implementation actually passed independently of the unshown test run.

4. [severity: high] [src/harness/spec/extract-ids.ts:124] Gap computation is proportional to the numeric span rather than input size and can allocate an enormous array from a tiny document.
   Evidence: `for (let n = min; n <= max; n++) { if (!present.has(n)) gaps.push(n); }`
   Why: A namespace containing `A-1` and `A-999` already emits 997 entries; expanding the supported numeric width would turn this into a denial-of-service primitive. Purity and regex safety do not protect the overall extractor from pathological runtime or memory use.

5. [severity: medium] [src/harness/spec/extract-ids.ts:21] Dashed-ID matching truncates longer numeric suffixes into false IDs.
   Evidence: Input `REQ-1234 REQ-1235` can match `REQ-123` in each token because the trailing `\b` exists between `3` and `4`.
   Why: The census reports a nonexistent ID and collapses distinct source tokens to the same number; a digit-negative lookahead is required after the numeric component.

6. [severity: medium] [src/harness/spec/extract-ids.ts:31] Compact-ID matching likewise truncates longer numeric suffixes into false IDs.
   Evidence: Input `B123 B124 B125` is read as repeated `B12` matches because `\b` occurs between the second and third digits only when the following character boundary conditions allow punctuation or formatting variants.
   Why: The fixed two-digit limit needs an explicit `(?!\d)` guard; otherwise unsupported tokens can contaminate a namespace rather than being rejected atomically.

7. [severity: medium] [src/harness/spec/extract-ids.ts:112] Numerically equivalent IDs with different written forms are merged while preserving only the first spelling.
   Evidence: `entry = { id: h.id, num: h.num, sites: [], defSites: [] };` keyed by `byNum.get(h.num)`, so `FG-INV-1` and `FG-INV-01` become one entry.
   Why: The ledger loses provenance needed to diagnose inconsistent zero-padding and cannot tell which spelling occurred at later sites.

8. [severity: medium] [src/harness/spec/extract-ids.ts:116] Every ID on a structurally definition-like line is marked as defined, including IDs merely referenced in the definition body.
   Evidence: Input `| FG-INV-01 | Depends on FG-INV-02 and supersedes FG-INV-03 |` places all three line numbers in `defSites`.
   Why: A cross-file ledger using `defSites` will treat references as definitions and produce an inflated authoritative census.

9. [severity: medium] [src/harness/spec/extract-ids.ts:61] Blockquotes and task-list registry entries are not recognized as definition sites.
   Evidence: Inputs `> FG-INV-01: rule` and `- [ ] FG-INV-01: implement rule` fail all branches in `isDefinitionLine`.
   Why: These are realistic markdown registry forms, so the IDs are found but definition provenance is lost.

10. [severity: medium] [src/harness/spec/extract-ids.ts:187] Count claims using comma-formatted digits are misread as a smaller count beginning after the comma.
   Evidence: Input `There are 1,200 invariants.` matches `200 invariants`.
   Why: This silently emits the wrong value instead of rejecting or correctly parsing the formatted number.

11. [severity: medium] [src/harness/spec/extract-ids.ts:187] Count extraction misses common qualified count claims.
   Evidence: Inputs `all six core bets`, `the 28 documented invariants`, and `a total of six bets` do not all fit the required immediately adjacent `<number> <plural noun>` form.
   Why: Real planning prose frequently inserts an adjective between the number and registry noun, producing false negatives for the target class.

12. [severity: medium] [src/harness/spec/extract-ids.ts:187] Broad number-plus-plural matching turns ordinary prose quantities into count claims unrelated to registries.
   Evidence: Inputs `two commits failed`, `three checks passed`, `four branches remain`, and `six errors occurred` all become claims because those nouns are absent from the stoplist.
   Why: A finite stoplist cannot make an unrestricted plural-noun regex precise, so realistic markdown will generate substantial false-positive ledger input.

13. [severity: medium] [src/harness/spec/extract-ids.ts:217] Singularization corrupts common registry nouns ending in `-ses`, `-uses`, or irregular plurals.
   Evidence: `if (noun.endsWith("s")) return noun.slice(0, -1);` maps `statuses` to `statuse`, `processes` to `processe`, and `criteria` remains `criteria`.
   Why: Since `nounSingular` is explicitly intended for namespace binding, these transformations cause legitimate claims to remain unbound or bind ambiguously.

14. [severity: medium] [src/harness/spec/extract-ids.ts:255] Range extraction misses common Markdown-rendered range syntax containing formatting delimiters around each endpoint.
   Evidence: Inputs `` `FG-INV-01` through `FG-INV-20` `` and `**FG-INV-01** through **FG-INV-20**` cannot match because the pattern permits only whitespace between the separator word and endpoint.
   Why: Planning documents routinely format identifiers as code or bold text, so this is a material false-negative risk for the acceptance corpus class.

15. [severity: medium] [src/harness/spec/extract-ids.ts:255] Range extraction accepts prefixless upper bounds even though the API provides no provenance indicating whether the prefix was repeated or inferred.
   Evidence: `\s*(?:\1-|\1)?(\d{1,3})\b` treats both `FG-INV-01 through FG-INV-20` and `FG-INV-01 through 20` identically.
   Why: The ledger cannot distinguish an explicit namespace range from an inferred shorthand, preventing confidence-aware diagnostics and making malformed-prefix cases ambiguous.

16. [severity: medium] [src/harness/spec/types.ts:49] `RangeClaim` omits endpoint spellings and source-column provenance needed to audit ambiguous or differently padded ranges.
   Evidence: `export interface RangeClaim { prefix: string; from: number; to: number; raw: string; line: number; }`
   Why: `raw` plus a line number is insufficient when a line contains multiple claims or when consumers need to distinguish `01` from `1`; structured endpoint provenance would avoid reparsing display text.

17. [severity: low] [src/harness/spec/extract-ids.ts:159] Namespace ordering is not fully deterministic across runtimes because `localeCompare` depends on locale-sensitive collation.
   Evidence: `out.sort((a, b) => a.prefix.localeCompare(b.prefix));`
   Why: For a cacheable deterministic substrate, ordering should use a locale-independent lexical comparison, especially if non-ASCII prefixes ever reach the API through future widening.

18. [severity: low] [src/harness/spec/extract-ids.test.ts:117] Range tests use partial object assertions and therefore do not verify `raw` or `line` provenance.
   Evidence: `expect.objectContaining({ prefix: "FG-INV", from: 1, to: 20 })`
   Why: The suite would pass with wrong line numbers or corrupted raw source, despite provenance being part of the public API and a stated review target.

19. [severity: low] [src/harness/spec/extract-ids.test.ts:80] Count tests also use partial assertions and never validate the extracted `raw` field.
   Evidence: `expect.objectContaining({ noun: "bets", nounSingular: "bet", value: 6, line: 1 })`
   Why: A broken match span could pass while giving the ledger misleading evidence text.

20. [severity: low] [src/harness/spec/extract-ids.test.ts:67] The performance test is timing-flaky and covers only namespace regexes, not range or count extraction.
   Evidence: `expect(Date.now() - start).toBeLessThan(500);`
   Why: Wall-clock thresholds vary with CI load, while untested long near-matches in `RANGE_CLAIM_RE` are the more structurally complex regex path.

21. [severity: low] [src/harness/spec/extract-ids.test.ts:10] No test reproduces either full acceptance-corpus contradiction end to end within this slice.
   Evidence: The suite separately tests `B1, B2 and B7`, `six bets`, an `FG-INV` census, and a range, but never asserts the complete seven-ID census versus six-count claim or `FG-INV-28` versus `01 through 20`.
   Why: Tests can pass even if extraction details prevent the eventual ledger from correlating the exact D-1 and D-2 facts.

TOTAL: 21