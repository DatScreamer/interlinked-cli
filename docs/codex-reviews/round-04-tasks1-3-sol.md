1. [severity: high] [src/harness/server/spec-ledger-phase.ts:87] Each markdown edit replaces the session-wide outstanding-drift stash with only findings involving the latest file, silently forgetting unresolved findings from earlier edits.
   Evidence: `session.spec_drift_outstanding = findings.slice(0, STASH_CAP).map(...)`; breaking sequence: edit `PLAN.md` to create drift with `README.md`, then edit unrelated `NOTES.md` with no findings—the Stop stash becomes `[]`.
   Why: Stop is specified as the terminal backstop for outstanding session drift, but the last unrelated markdown edit erases that state. The tests only cover resolution, not sequential unrelated edits.

2. [severity: high] [src/harness/spec/ledger.ts:325] A markdown target omitted because it exceeds the ledger’s file-size cap is reported as nonexistent whenever the overall walk was not truncated.
   Evidence: `const exists = mdTarget ? false : this.fileExists(join(this.repoRoot, resolved));`; breaking input: `[plan](./large-plan.md)` where `large-plan.md` exists but exceeds `MAX_FILE_BYTES`.
   Why: Size/readability skips increment `skipped` without setting `truncated`, so absence from the ledger is incorrectly treated as proof of filesystem absence. This violates the default-gate warning’s existence semantics.

3. [severity: medium] [src/harness/spec/extract-misc.ts:14] Fence parsing closes an open backtick fence on any tilde fence, and vice versa, despite CommonMark requiring matching fence characters.
   Evidence: breaking input: ```` ```md\n# example\n~~~\n[bad](#missing)\n``` ````.
   Why: `if (open) { ... open = null; }` never compares the closing marker to the opener. Prose checks then scan content that is actually still fenced, producing false anchors, references, paths, and claims.

4. [severity: medium] [src/harness/spec/extract-misc.ts:14] Fence parsing accepts a shorter closing fence than the opener, causing fenced examples to leak into default-gate checks.
   Evidence: breaking input: ````` ````md\n# fake\n```\n[bad](#missing)\n```` `````.
   Why: CommonMark requires the closing fence to be at least as long as the opening fence, but the extractor stores neither marker type nor length.

5. [severity: medium] [src/harness/spec/extract-refs.ts:24] The GitHub slug implementation mishandles entity decoding and therefore flags valid anchors as dangling.
   Evidence: breaking input: `## Dogs &amp; Cats\n[details](#dogs--cats)`.
   Why: GitHub derives the anchor from rendered heading text, where `&amp;` is `&`; this implementation strips punctuation from the source text and yields `dogs-amp-cats`. The slug tests cover punctuation but not HTML entities.

6. [severity: medium] [src/harness/checks/spec-structure.ts:35] A reference to a parent section is accepted merely because any descendant exists, even when the parent heading itself is absent.
   Evidence: breaking input: `## 1. Intro\n## 2. Model\n### 7.3 Details\nSee §7.`
   Why: `n.startsWith(\`${ref}.\`)` makes `§7` resolve to heading `7.3`. This masks renumbering residue—the exact dangling-section class the check targets.

7. [severity: medium] [src/harness/spec/binding.ts:55] Heading noun binding uses substring matching, allowing unrelated words to bind count claims to namespaces.
   Evidence: breaking input: `## Six operations\nThe betting subsystem follows.\n- B1 A\n- B2 B\n- B3 C`.
   Why: singular noun `operation` matches heading text `operations` anywhere, while similarly short/common singulars can match unrelated words. Once bound, a realistic count mismatch becomes a default-gate false positive.

8. [severity: medium] [src/harness/spec/ledger.ts:359] Cross-file count drift suppresses every claim whenever that file contains any disagreeing local census for the bound namespace, even if the local IDs are merely incidental citations.
   Evidence: breaking input: README says `Six bets compose the system; B1 and B2 are described below`, while the defining plan enumerates `B1..B7`.
   Why: `if (local && local.uniqueCount !== claim.value) continue;` treats two prose citations like a local authoritative census. This creates a false negative on the primary D-1 target shape.

9. [severity: medium] [src/harness/spec/ledger.ts:386] Cross-file range drift is suppressed by any local mention whose maximum differs from the range endpoint, including incidental prose IDs.
   Evidence: breaking input: `FG-INV-01 through FG-INV-20 are checked; FG-INV-28 is discussed separately`, with the actual registry reaching 28 in another file.
   Why: `if (local && local.max !== claim.to) continue;` skips the stale range even though the local `FG-INV-28` mention strengthens the contradiction. No test covers incidental local IDs beyond the range endpoints.

10. [severity: low] [src/harness/check-registry/entries-warnings/spec-structure.ts:28] The dangling-anchor keyword gate omits the supported `Section N` reference syntax, so files containing only that syntax never run the detector.
   Evidence: breaking input: `## 1 Intro\n## 2 Model\n## 3 Storage\nSee Section 9 for details.`
   Why: `content_keywords: ["](#", "§", "Appendix"]` lacks `"Section"`. Extraction supports `Section N`, but registry dispatch prevents the check from seeing it.

TOTAL: 10