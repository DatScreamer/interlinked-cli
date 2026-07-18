// Metadata fragment: Batch 8 demo-data checks — unmarked fake data, silent demo
// fallbacks, placeholder UI / markdown, and manual field-copy runs. Composed
// into GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_DEMO_DATA_META: Record<string, CheckMeta> = {
	// ========================================================================
	// Batch 8: demo-data (3 entries)
	// ========================================================================
	demo_data_unmarked: {
		name: "Unmarked Demo Data",
		description:
			"Detects fake-data signatures (test emails, Stripe test cards, lorem ipsum, sentinel UUIDs, faker imports, mock/fake/sample identifier prefixes) without a `// @demo-data:` directive.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	silent_demo_fallback: {
		name: "Silent Demo Fallback",
		description:
			"Detects try { real API call } catch { return [literal] } — silently substitutes fake data on upstream failure.",
		tier: 1,
		determinism: "heuristic",
	},
	demo_runtime_missing_banner: {
		name: "Demo Runtime Without Banner",
		description:
			"Root-layout file imports demo-runtime helpers but does not render <DemoBanner />.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	placeholder_data_in_ui: {
		name: "Placeholder Data in UI",
		description:
			"Detects placeholder/mock/fake data rendered into a user-facing UI file — hardcoded numbers a comment marks as fake, mock-named values, lorem ipsum, placeholder image hosts, and placeholder-shaped numbers. Suppressed when the UI shows a visible 'sample data' disclaimer.",
		tier: 2,
		determinism: "heuristic",
	},
	placeholder_markdown_link: {
		name: "Placeholder Markdown Link",
		description:
			"Detects markdown links with an empty or anchor-only href — [text]() or [text](#) — links written but never given a real destination. Scoped to .md / .mdx / .markdown files; fenced code blocks are excluded so syntax examples don't fire.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	manual_field_copy: {
		name: "Manual Field Copy",
		description:
			"Detects a run of 5+ consecutive field copies target.k = source.k — hand-copying one object's fields onto another silently skips any field later added to the source.",
		tier: 2,
		determinism: "heuristic",
	},
	spec_dangling_anchor: {
		name: "Spec Dangling Anchor",
		description:
			"Detects same-file references that resolve to nothing: [text](#slug) with no matching heading, §N.N refs in section-numbered docs with no such heading, and Appendix X refs with no such appendix. Docs without numbered headings or appendices never fire.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	spec_numbering: {
		name: "Spec Registry Numbering",
		description:
			"Detects numbering defects in ID registries (FG-INV-xx / B7 style): an id defined twice, or small gaps in a definition registry (renumber residue). Gaps are computed over definition sites only — prose citing a sparse subset never fires.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	spec_count_claim: {
		name: "Spec Count Claim Drift",
		description:
			"Detects a stated count or ID range disagreeing with the ids enumerated in the same file — \"six bets\" above a B1..B7 table. Fires only when the claim binds to a namespace by same-line or heading-section co-occurrence.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	spec_pitfall: {
		name: "Spec Pitfall Lexicon",
		description:
			"Curated recurring spec falsehoods seeded from external audit corpora (exactly-once to external sinks, in-house crypto, forbid+allow, truncated-hash identity, post-filter visibility, self-oracle validation, float byte-identity). Same-line co-occurrence with hedge exemptions; citation-backed.",
		tier: 1,
		determinism: "heuristic",
	},
	spec_claim_untagged: {
		name: "Spec Claim Untagged",
		description:
			"Guarantee-verb sentences without a [claim: …] class tag, only in files that already opted into claim tagging — the audit-recommended claim taxonomy as a per-file nudge.",
		tier: 1,
		determinism: "heuristic",
	},
	spec_capacity_claim: {
		name: "Spec Capacity Claim",
		description:
			"An N-bit field discussed with reuse/counter vocabulary and no wrap/widen/prohibition statement — the bounded-field wraparound class, emitted as a pointed obligation with the computed wrap point.",
		tier: 1,
		determinism: "heuristic",
	},
	spec_table_sum: {
		name: "Spec Table Sum",
		description:
			"Recomputes Total/Sum rows in markdown tables against their numeric columns — layout/cost tables whose totals drifted from their rows.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	spec_stage_order: {
		name: "Spec Stage Order",
		description:
			"Workstream/gate sequencing defects in W/G-staged plans: forward dependencies (a stage needing a later stage) and backward constraints (a later stage changing what an earlier one fixed) — the Sol workstream class.",
		tier: 1,
		determinism: "partially_deterministic",
	},
};
