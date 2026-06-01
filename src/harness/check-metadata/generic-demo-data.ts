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
};
