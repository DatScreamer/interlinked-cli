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
import {
	htmlCommentBlockLines,
	maskCommentsKeepCode,
} from "./extract-refs-masking.js";
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
	// Comment visibility is applied ONCE here so the count/id/range extractors
	// inherit identical rules (round-7 #10): whole-line comment BLOCKS blank
	// entirely; same-line comments blank to spaces with code spans kept
	// VISIBLE (the census deliberately reads fenced/inline code). "<!-- Six
	// bets B1 B2 B3 -->" produces neither a count claim nor a B namespace.
	const commentHidden = htmlCommentBlockLines(lines, fenced);
	const censusLines = lines.map((l, i) =>
		commentHidden.has(i + 1) ? "" : maskCommentsKeepCode(l),
	);
	// Prose-shaped facts exclude fenced lines (round-2 #21): count/range
	// claims inside a documented example are illustration, not assertions.
	// ID censuses still scan fences (registry tables are often examples).
	const proseLines = censusLines.map((l, i) => (fenced.has(i + 1) ? "" : l));
	// REPORTED range claims come from prose only (fenced example ranges are
	// illustration). But a SEPARATE census view scans fenced lines too, so a
	// fenced range's own endpoints ("FG-INV-01 through FG-INV-20" in an example)
	// are still excluded from the id census — else they'd seed a spurious
	// namespace with a phantom gap (round-7 #7). Both feed the sol-max #12
	// span-exclusion; only `rangeClaims` is surfaced.
	const rangeClaims = extractRangeClaims(proseLines);
	const censusRangeClaims = extractRangeClaims(censusLines);
	return {
		filePath,
		lineCount: lines.length,
		namespaces: extractIdNamespaces(censusLines, censusRangeClaims),
		looseDefinedIds: extractLooseDefinedIds(censusLines, censusRangeClaims),
		countClaims: extractCountClaims(proseLines),
		rangeClaims,
		headings: extractHeadings(lines, fenced),
		sectionRefs: extractSectionRefs(lines, fenced),
		anchorLinks: extractAnchorLinks(lines, fenced),
		// Path refs and claim sentences don't mask comments internally (unlike
		// headings/refs/links), so feed them the comment-hidden census view — a
		// path or claim inside "<!-- … -->" is not a live fact (round-7 #9).
		pathRefs: extractPathRefs(censusLines, fenced),
		declaredFacts: extractDeclaredFacts(lines),
		fencedBlocks,
		claimSentences: extractClaimSentences(censusLines, fenced),
	};
}
