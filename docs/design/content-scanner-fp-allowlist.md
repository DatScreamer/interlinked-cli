# Content scanner — FP allowlist

## Context

OPF flags a well-understood set of canonical test-data patterns as real PII. In practice this means every engineer writing a test fixture, a docs example, or a code snippet with a placeholder email trips the scanner. The approval prompt becomes noise, agents learn to auto-approve, and the signal gets lost.

The fix is a narrow, principled allowlist of categorically-safe patterns that get dropped *after* the model decodes but *before* the policy decides. This doc specifies which patterns qualify, where they live, and how operators extend them.

## Design principles

1. **Only patterns that are reserved by standards or industry convention for test / fiction use.** No "probably safe" guesses. A wrong allowlist silently defeats the scanner.
2. **Apply post-scan, pre-policy.** The scanner still runs and produces findings (telemetry stays honest); the allowlist filters those findings before `decideFromFindings` sees them.
3. **Label-scoped.** An allowlist entry targets a specific OPF label — we never blanket-allow a substring across categories, because the same string can mean different things in different positions.
4. **Explicit, not heuristic.** Operators should be able to see every rule as a regex in a config file. No ML, no fuzzy matching, no "trust us."

## What ships in the default allowlist

Pinned to authoritative sources so reviewers have a citation path:

| Label | Pattern | Authority |
|---|---|---|
| `private_email` | `@(?:example\.(?:com|org|net)|invalid|test|localhost)$` | RFC 2606 §2 (reserved top-level domains), RFC 6761 |
| `private_phone` | `^(?:\+?1[-. ]?)?\(?555\)?[-. ]?01\d{2}[-. ]?\d{4}$` | NANPA reservation (555-0100..555-0199 reserved for fictional use) |
| `private_phone` | `^(?:\+?44[-. ]?)?(?:\(?01\d{3}\)?[-. ]?)?496[0-9]{4}$` | UK Ofcom 01xxx xx49xx reservation for drama |
| `private_date` | `^(?:1970-01-01|1990-01-02|2000-01-01)` | Canonical Unix epoch + OPF published eval fixtures |
| `private_url` | `^https?://(?:example\.(?:com|org|net)|localhost\b|127\.0\.0\.1\b|\[::1\]\b)` | RFC 2606 + loopback |
| `private_person` | `^(?:John|Jane)\s+(?:Doe|Smith|Public)$` | Long-standing placeholder convention (US legal Jane/John Doe, UK Joe Bloggs optionally) |

Explicitly **not** in the default allowlist:
- Faker-generated names (`Alice Jones`, `Bob Smith`, etc.) — too easily a real name.
- `admin@`, `noreply@` against real domains — real systems use these.
- `@test.com` — `test.com` is a real registered domain.

The default is narrow on purpose. Operators extend it in their own config.

## Config schema

Add to `ContentScannerConfig`:

```ts
/** Regex patterns that cancel specific-label findings before the policy
 *  layer. Matches are case-insensitive on the `text` field of the finding. */
allowlist_patterns: Array<{
  /** OPF label this rule applies to. Must match exactly (e.g., "private_email"). */
  label: string;
  /** Regex source, NOT including leading/trailing slashes. Flags always "i". */
  pattern: string;
  /** Optional comment for the config author — never used at runtime. */
  note?: string;
}>;
```

User config in `.interlinked/guard-rules.local.json`:

```jsonc
{
  "content_scanner": {
    "allowlist_patterns": [
      { "label": "private_email", "pattern": "@(?:example|test)\\.com$",
        "note": "ship default — RFC 2606 reserved domains" },
      { "label": "private_phone", "pattern": "^555-?01\\d{2}",
        "note": "NANPA 555-01xx fictional-use reservation" },
      { "label": "private_person", "pattern": "^(?:Alice|Bob|Carol)$",
        "note": "project convention — cryptography test principals" }
    ]
  }
}
```

Merge semantics: local entries **append to** (don't replace) the shipped defaults. To disable a default, the operator removes the exact matching string in a new `disabled_allowlist_patterns: string[]`.

## Implementation

`src/harness/content-scanner/allowlist.ts`:

```ts
export interface AllowlistRule {
  label: string;
  pattern: string;
  note?: string;
}

export function filterAllowlisted(
  findings: ScanFinding[],
  rules: AllowlistRule[],
): { kept: ScanFinding[]; dropped: ScanFinding[] } {
  const byLabel = new Map<string, RegExp[]>();
  for (const r of rules) {
    const arr = byLabel.get(r.label) ?? [];
    arr.push(new RegExp(r.pattern, "i"));
    byLabel.set(r.label, arr);
  }
  const kept: ScanFinding[] = [];
  const dropped: ScanFinding[] = [];
  for (const f of findings) {
    const regs = byLabel.get(f.label);
    if (regs && regs.some((r) => r.test(f.text))) dropped.push(f);
    else kept.push(f);
  }
  return { kept, dropped };
}
```

Call site: `policy.ts` near the existing `filterFindingsByScore` step.

```ts
const scored = filterFindingsByScore(findings, config);
const { kept, dropped } = filterAllowlisted(scored, config.allowlist_patterns);
if (dropped.length > 0) {
  log(`content-scanner: allowlisted ${dropped.length} finding(s): ${summariseByLabel(dropped)}`);
}
return decideFromFindings(kept, config);
```

Telemetry: log (not `warn` / `block`) dropped findings so operators can audit the allowlist didn't shadow real hits.

## Files touched

| Path | Change |
|---|---|
| `src/harness/content-scanner/types.ts` | Add `allowlist_patterns` field to `ContentScannerConfig`. |
| `src/harness/content-scanner/allowlist.ts` | **New.** Compile + match. |
| `src/harness/content-scanner/__tests__/allowlist.test.ts` | **New.** Label scoping, case insensitivity, merge-vs-replace semantics, malformed-regex handling. |
| `src/harness/content-scanner/policy.ts` | Call `filterAllowlisted` between score filter and decide. |
| `src/harness/content-scanner/post-scan.ts` | Same pre-decide hook so PostToolUse taint ratchet uses the allowlist too. |
| `src/harness/rules/default-config.ts` | Ship the default allowlist entries above. |
| `src/harness/rules/merge.ts` | Append-merge semantics (not replace). |
| `docs/harness.md` | New "FP allowlist" subsection with the shipped defaults table. |

Estimate: ~60 LOC source, ~80 LOC test, one half-day.

## Rollout

1. Ship the allowlist module + tests disabled.
2. Turn on for internal testing with telemetry capturing `dropped` counts + rates.
3. Review dropped findings against a corpus of real PII to confirm no masking.
4. Flip the default allowlist on.

## Verification

- **Unit**: each shipped default entry has a "matches this canonical example, doesn't match this real-looking variant" test pair. Non-exhaustive but forces the regex to be tight.
- **Integration**: a test where a Write event contains both `alice@example.com` (allowlisted) and `maria.rodriguez@gmail.com` (not) — only the second survives and triggers `ask`.
- **Regression**: the existing integration test's round-trip `detect inbound → ratchet → block outbound` still passes because the Read fixture uses `alice@example.com` which now gets allowlisted — **rewrite the test fixture to use a non-allowlisted email** before landing.

## Open questions

- **Share allowlist with secret scanning**: gitleaks already skips `example` domains in some configs. Alignment with their rule set would reduce operator cognitive load. Low priority.
- **Per-file exemption**: "don't scan test fixtures under `__tests__/` at all" — simpler than pattern matching but coarser. Ship the pattern list first; add file-glob exemption only if the allowlist proves insufficient.
- **Telemetry channel**: should dropped findings be reported to the remote server (when `server_hosted`) for fleet-wide allowlist tuning? Privacy-preserving aggregation only — counts per label per day, never raw strings.
