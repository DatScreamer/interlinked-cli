1. [severity: high] [src/harness/spec/extract-ids.ts:252] The greedy range prefix absorbs the separator or leading endpoint digits, causing required dashed ranges to be discarded and abbreviated compact ranges to be misparsed.
   Evidence: `FG-INV-01 through FG-INV-20` captures prefix `FG-INV-`, which line 268 rejects, while `W12–20` captures prefix `W1` and `from: 2`.
   Why: D-2 cannot be extracted, and the two dashed-range positive tests return `[]`.

2. [severity: high] [src/harness/spec/extract-ids.ts:52] Namespace qualification uses distinct numbers and a two-ID dashed threshold instead of the contracted three instances.
   Evidence: `const MIN_DASHED_IDS = 2;` and `const distinct = new Set(groupHits.map((h) => h.num)).size;`.
   Why: `FG-INV-01 FG-INV-02` wrongly qualifies, while three duplicate occurrences such as `B1 B1 B1` wrongly produce no namespace, preventing duplicate detection.

3. [severity: high] [src/harness/spec/extract-ids.ts:186] The count regex treats any number followed by an s-ending token as an exact noun count, turning section numbers, range endpoints, and verbs into claims.
   Evidence: `### 3.3 Checks`, `Version 2 features a new API.`, and `Each module defines 1–3 invariants.` respectively produce `3 Checks`, `2 features`, and `3 invariants`.
   Why: These realistic planning-document constructs are not census claims but can create deterministic drift warnings.

4. [severity: high] [src/harness/spec/extract-ids.ts:240] Claims retain only the matched phrase and lose polarity, bounds, temporal scope, and use-versus-mention context.
   Evidence: `raw: m[0] ?? ""` turns `up to six bets`, `does not define six bets`, and `the obsolete wording was “six bets”` into the same raw claim `six bets`.
   Why: The serialized ledger cannot distinguish an exact assertion from a limit, negation, or historical quotation, producing unavoidable false drift.

5. [severity: high] [src/harness/spec/extract-ids.ts:116] Every ID occurring on a structural line is marked as a definition, even when it is only referenced in the definition body.
   Evidence: `| FG-INV-01 | depends on FG-INV-02 |` followed by `| FG-INV-02 | actual definition |` gives `FG-INV-02.defSites` as `[1, 2]`.
   Why: A ledger consumer will report a duplicate definition where only one exists.

6. [severity: medium] [src/harness/spec/extract-ids.ts:223] Count extraction deliberately accepts unbound nouns despite the contract restricting claims to namespace nouns or high-frequency terms.
   Evidence: `Binding a noun to a namespace ... is the ledger's job — extraction stays broad`.
   Why: `E1 E2 E3 E4` plus `the API exposes three endpoints` is indistinguishable from an E-namespace count unless the future consumer invents an ambiguous noun-to-prefix heuristic; `IdNamespace` records no namespace noun.

7. [severity: high] [src/harness/spec/extract-ids.ts:186] Digit claims violate the contracted `\d+` grammar and can silently truncate comma-formatted values.
   Evidence: `There are 1,251 invariants` is extracted as value `251`, while `501 invariants`, `1000 invariants`, and `0 invariants` are discarded.
   Why: The three-digit regex and `value <= 0 || value > 500` filter yield wrong or missing censuses without signaling unsupported syntax.

8. [severity: medium] [src/harness/spec/extract-ids.ts:186] Common valid count phrasings are missed because the regex requires a bare number immediately followed by a plural of at least four characters ending in `s`.
   Evidence: `There are six core bets, **six** bets, 1 invariant, and six IDs.` yields no claims.
   Why: Adjectives, Markdown emphasis, singular counts, short acronyms, and irregular plurals are routine in planning documents.

9. [severity: medium] [src/harness/spec/extract-ids.ts:118] Namespace summary fields mix prose mentions with definitions instead of representing a definition census.
   Evidence: Three definition rows for `FG-INV-01` through `FG-INV-03` plus `See future FG-INV-99` produce `uniqueCount: 4`, `max: 99`, and gaps `4..98`.
   Why: Consumers using the advertised `min`, `max`, or `gaps` directly will report numbering defects caused solely by prose references.

10. [severity: medium] [src/harness/spec/extract-ids.ts:108] Grouping solely by numeric value collapses lexically distinct IDs and destroys their per-site spelling provenance.
   Evidence: `const byNum = new Map<number, NamespaceId>();` merges `FG-INV-1`, `FG-INV-01`, and `FG-INV-001` into one entry whose `id` is whichever spelling appeared first.
   Why: The promised token set and inconsistent-padding duplicates cannot be reconstructed from the serialized result.

11. [severity: medium] [src/harness/spec/extract-ids.ts:21] Undocumented prefix and numeric-width caps miss valid contract-shaped namespaces and can rebase long dashed prefixes onto a suffix.
   Evidence: `DASHED_ID_RE` limits prefixes to 31 characters and numbers to three digits, while `COMPACT_ID_RE` limits prefixes to three letters and numbers to two digits.
   Why: `TASK1 TASK2 TASK3` and `REQ100 REQ101 REQ102` are missed, while `VERYLONGSEGMENTA-ANOTHERSEGMENTAB-REQ-01` is parsed under the truncated prefix `ANOTHERSEGMENTAB-REQ`.

12. [severity: medium] [src/harness/spec/extract-ids.ts:95] Common technical nomenclature is promoted to ID namespaces because compact context is unchecked and the stoplist is not applied to dashed IDs.
   Evidence: `Use H1, H2, and H3 headings; report P50, P95, and P99 latency; support SHA-1, SHA-2, and SHA-3.` produces `H`, `P`, and `SHA` namespaces.
   Why: These are realistic Markdown and architecture terms, and their resulting gap arrays can trigger false numbering findings.

13. [severity: medium] [src/harness/spec/extract-ids.ts:61] The definition classifier misses valid CommonMark registry forms outside its narrow marker list.
   Evidence: `+ FG-INV-01 — first invariant`, `1) FG-INV-02 — second invariant`, and `FG-INV-03: third invariant` all receive empty `defSites`.
   Why: Common `+` bullets, parenthesized ordered lists, and plain ID-led registries will not contribute definition provenance.

14. [severity: medium] [src/harness/spec/extract-ids.ts:216] The singularizer generates invalid binding keys for common namespace nouns.
   Evidence: `three statuses, four processes, five vertices, six analyses` produces `statuse`, `processe`, `vertic`, and `analyse`.
   Why: Count claims using these nouns cannot reliably bind to registry names or equivalent claims elsewhere.

15. [severity: medium] [src/harness/spec/types.ts:49] `RangeClaim` omits notation style even though namespaces with the same prefix are deliberately separated by style.
   Evidence: `RangeClaim` contains only `prefix`, `from`, `to`, `raw`, and `line`, whereas `IdNamespace` includes `style: "dashed" | "compact"`.
   Why: A claim for `W1–W9` cannot be typed unambiguously when both `W1` and `W-1` namespaces exist without reparsing `raw`.

16. [severity: low] [src/harness/spec/extract-ids.ts:159] Namespace ordering depends on the process locale rather than only on the input.
   Evidence: `out.sort((a, b) => a.prefix.localeCompare(b.prefix));`.
   Why: ASCII prefixes such as `AA` and `B` sort differently under some default locales, making serialized ledger output non-deterministic across environments.

17. [severity: medium] [src/harness/spec/extract-ids.test.ts:35] The tests never reproduce either full acceptance census.
   Evidence: The D-1 fixture is only `Bets B1, B2 and B7 compose`, and no namespace fixture reaches `FG-INV-28`.
   Why: Implementations that cannot enumerate seven contiguous bets or IDs 21–28 can still satisfy the census assertions.

18. [severity: low] [src/harness/spec/extract-ids.test.ts:96] The advertised huge-value and year-filter tests are vacuous because their inputs are rejected for unrelated reasons.
   Evidence: `900 bytes` and `750 seconds` use stoplisted nouns, while `from 2020 to 2024` has no alpha ID prefix.
   Why: Removing or breaking the corresponding numeric filters would not make these assertions fail.

19. [severity: low] [src/harness/spec/extract-ids.test.ts:80] Count and range provenance is not meaningfully tested.
   Evidence: All count/range fixtures are on line 1, and `expect.objectContaining` omits `raw` for both classes and `line` for ranges.
   Why: An implementation hard-coding `line: 1` and returning empty or truncated range provenance would pass these assertions.

20. [severity: low] [src/harness/spec/extract-ids.test.ts:67] The ReDoS guard exercises only one extractor and does not verify scaling behavior.
   Evidence: `extractIdNamespaces([evil, evil]); expect(Date.now() - start).toBeLessThan(500);`.
   Why: Pathological count/range inputs are untested, and one small absolute-duration check can pass an algorithm whose runtime becomes catastrophic at larger sizes.

TOTAL: 20