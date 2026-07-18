1. [medium] [src/harness/spec/extract-ids.ts:109-116] Repeated mentions of the same ID on the same line are recorded multiple times in `sites` and `defSites`, so the per-ID provenance is not a set of line numbers.
   Evidence: `entry.sites.push(h.line);` and `if (isDefinitionLine(lines[h.line - 1] ?? "")) entry.defSites.push(h.line);`
   Why: A line like `FG-INV-01 and FG-INV-01` will yield `[1, 1]`, which overstates occurrence counts and can mislead the ledger consumer that relies on site lists for provenance and duplicates.

2. [medium] [src/harness/spec/extract-ids.ts:186-187] Count claims miss a class of spec-mentioned real-doc phrasings, including capitalized nouns and comma-separated/4+ digit numerals.
   Evidence: `const COUNT_CLAIM_RE = /\b(one|two|...|twenty|\d{1,3})\s+([a-z][a-z-]{2,19}s)\b/gi;`
   Why: The design spec explicitly allows high-frequency capitalized terms, but this regex only accepts lowercase plural nouns; it also rejects `1,000 invariants` and anything above 3 digits, so legitimate count claims in planning docs will be silently skipped.

3. [low] [src/harness/spec/extract-ids.ts:21,31,255] The namespace and range extractors impose undocumented hard caps on ID shape, causing avoidable false negatives for longer legitimate prefixes or longer numeric parts.
   Evidence: `DASHED_ID_RE = /\b([A-Z][A-Z0-9-]{0,30})-(\d{1,3})\b/g;`, `COMPACT_ID_RE = /\b([A-Z]{1,3})(\d{1,2})\b/g;`, and `RANGE_CLAIM_RE = /\b([A-Z][A-Z0-9-]{0,30}?)-?(\d{1,3})\s*...`
   Why: Real markdown registries are not guaranteed to fit 31-char prefixes, 3-digit suffixes, or 3-letter compact prefixes; those tokens will never enter the census or range ledger even if they are clearly namespace IDs in the document.

TOTAL: 3