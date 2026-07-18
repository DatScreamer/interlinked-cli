// Spec-facts orchestrator: one call extracts everything the ledger and the
// spec checks consume (docs/design/spec-audit-runtime-checks.md §3.1).
// Pure function, no I/O — callers (checks, ledger, session stash) decide
// caching and freshness.

import {
	extractCountClaims,
	extractIdNamespaces,
	extractLooseDefinedIds,
	extractRangeClaims,
} from "./extract-ids.js";
import {
	extractClaimSentences,
	extractDeclaredFacts,
	extractFencedBlocks,
	extractPathRefs,
	fencedLineSet,
} from "./extract-misc.js";
import {
	extractAnchorLinks,
	extractHeadings,
	extractSectionRefs,
} from "./extract-refs.js";
import type { SpecFacts } from "./types.js";

/**
 * Extract all spec facts from one file's content. ID censuses scan fenced
 * blocks too (registry tables are often TOML/JSON examples); prose-shaped
 * facts (headings, refs, links, paths, claims) exclude fenced lines.
 */
export function extractSpecFacts(content: string, filePath: string): SpecFacts {
	const lines = content.split("\n");
	const fencedBlocks = extractFencedBlocks(lines);
	const fenced = fencedLineSet(fencedBlocks);
	// Prose-shaped facts exclude fenced lines (round-2 #21): count/range
	// claims inside a documented example are illustration, not assertions.
	// ID censuses still scan fences (registry tables are often examples).
	const proseLines = lines.map((l, i) => (fenced.has(i + 1) ? "" : l));
	// Range claims come from prose only (fenced example ranges are illustration).
	// Feed them to the census so a claim's own endpoints can't seed it (sol-max
	// #12) — while fenced registry ids (scanned via raw `lines`) still count.
	const rangeClaims = extractRangeClaims(proseLines);
	return {
		filePath,
		lineCount: lines.length,
		namespaces: extractIdNamespaces(lines, rangeClaims),
		looseDefinedIds: extractLooseDefinedIds(lines, rangeClaims),
		countClaims: extractCountClaims(proseLines),
		rangeClaims,
		headings: extractHeadings(lines, fenced),
		sectionRefs: extractSectionRefs(lines, fenced),
		anchorLinks: extractAnchorLinks(lines, fenced),
		pathRefs: extractPathRefs(lines, fenced),
		declaredFacts: extractDeclaredFacts(lines),
		fencedBlocks,
		claimSentences: extractClaimSentences(lines, fenced),
	};
}
