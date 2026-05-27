// ===========================================
// Sibling Expansion (PostToolUse fan-out)
// ===========================================
//
// When a PostToolUse finding lands on a known type-erasure / boundary
// pattern, query the project trigram index for every other instance and
// emit each as its own sibling row. This implements the Codex
// finding-discovery convention "do not collapse separate instances under
// one candidate" — a single edit's `as_any_ratchet` becomes a worklist
// covering the whole module.
//
// Costs: trigram query is ~10-50µs (bounded by the index intersection),
// candidate verification is one regex pass per candidate file. Both fit
// comfortably inside the existing PostToolUse budget.
//
// Phase D (#5) adds `expandEndpointDetectorSiblings` below — a separate,
// pure `findings → findings` transformer that rescans the same file for
// the same detector's hits and bundles sibling endpoints into the lead
// finding's message. Same overall theme (find siblings of a finding) at a
// different scope (file-local rescan, detector-agnostic) — so it lives
// alongside the trigram-based fan-out instead of fragmenting the module.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DetectorFinding } from "./checks/endpoint-security.js";
import { decomposePattern } from "./regex-trigrams.js";

/** A single sibling instance discovered for a triggered finding. */
export interface SiblingFinding {
	triggerName: string;
	siblingRuleId: string;
	file: string;
	line: number;
	message: string;
}

/** Trigram-index surface needed for fan-out — narrow enough that tests
 *  can fake it without standing up a real index. */
export interface TrigramIndexLike {
	queryCandidatePaths(requiredTrigrams: number[]): string[];
}

/** File-content reader — injected so tests don't need the filesystem. */
export interface FileReader {
	read(path: string): string | undefined;
}

/** Mapping from a triggering finding name to the literal anchor / regex
 *  that defines its sibling shape. */
export interface SiblingTrigger {
	triggerName: string;
	/** Literal substring that every match must contain — used to seed
	 *  the trigram lookup. */
	anchor: string;
	/** Regex used to confirm matches inside each candidate file. */
	pattern: RegExp;
	/** Rule id stamped on emitted sibling rows. */
	siblingRuleId: string;
	/** Builds the human-readable warning text. */
	messageTemplate: (file: string, line: number, snippet: string) => string;
}

export const DEFAULT_TRIGGERS: SiblingTrigger[] = [
	{
		triggerName: "as_any_ratchet",
		anchor: "as any",
		pattern: /\bas\s+any\b/g,
		siblingRuleId: "as_any_sibling",
		messageTemplate: (file, line, snippet) =>
			`Sibling \`as any\` cast at ${file}:${line} — same pattern just edited elsewhere. ${snippet}`,
	},
	{
		triggerName: "unvalidated_json_boundary",
		anchor: "JSON.parse",
		pattern: /\bJSON\.parse\s*\(/g,
		siblingRuleId: "unvalidated_json_sibling",
		messageTemplate: (file, line, snippet) =>
			`Sibling JSON.parse at ${file}:${line} — boundary pattern; route through a schema validator. ${snippet}`,
	},
];

export interface ExpandSiblingsArgs {
	/** Findings that triggered the fan-out, with the absolute file path
	 *  of the originating edit so we can exclude it from sibling output. */
	triggers: Array<{ name: string; file: string }>;
	index: TrigramIndexLike;
	reader: FileReader;
	cwd: string;
	/** Override or extend the default trigger spec list. */
	triggerSpecs?: SiblingTrigger[];
	/** Cap on emitted sibling rows per trigger (default 3). */
	maxSiblingsPerTrigger?: number;
	/** Cap on candidate files inspected per trigger (default 30). */
	maxCandidates?: number;
}

const DEFAULT_MAX_SIBLINGS_PER_TRIGGER = 3;
const DEFAULT_MAX_CANDIDATES = 30;
const SNIPPET_LENGTH = 120;

// Documentation file extensions. The trigram index covers the whole repo,
// so a `JSON.parse(...)` / `as any` shown inside a fenced code block in a
// design doc (`docs/design/*.md`, `docs/plans/*.md`, …) gets returned as a
// sibling candidate. That text is illustrative prose, not lintable source —
// flagging it is a pure false positive. Sibling rule ids carry "route
// through a schema validator" / "same pattern just edited elsewhere"
// guidance that makes no sense pointed at a markdown snippet. Exclude doc
// files from the candidate set entirely.
const DOC_FILE_EXTENSIONS: readonly string[] = [".md", ".mdx", ".markdown"];

/** True when a candidate path is a Markdown / documentation file whose
 *  embedded code snippets must not be treated as lintable source. */
function isDocFile(path: string): boolean {
	const lower = path.toLowerCase();
	return DOC_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Public API — return sibling rows for every applicable trigger.
 *
 *  Triggers with the same `name` are deduped (same fan-out is computed
 *  once). Originating files are excluded from the sibling list — the
 *  primary finding already names them.
 */
export function expandSiblings(args: ExpandSiblingsArgs): SiblingFinding[] {
	const specs = args.triggerSpecs ?? DEFAULT_TRIGGERS;
	const specByName = new Map(specs.map((s) => [s.triggerName, s]));
	const maxSiblings = args.maxSiblingsPerTrigger ?? DEFAULT_MAX_SIBLINGS_PER_TRIGGER;
	const maxCandidates = args.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

	const triggerNames = new Set<string>();
	const originFiles = new Set<string>();
	for (const t of args.triggers) {
		triggerNames.add(t.name);
		if (t.file) originFiles.add(toRelative(t.file, args.cwd));
	}

	const out: SiblingFinding[] = [];
	for (const name of triggerNames) {
		const spec = specByName.get(name);
		if (!spec) continue;

		const decomp = decomposePattern(spec.anchor, false);
		if (decomp.requiredTrigrams.length === 0) continue;

		const candidatePaths = args.index
			.queryCandidatePaths(decomp.requiredTrigrams)
			.slice(0, maxCandidates);

		let emittedForTrigger = 0;
		for (const candidatePath of candidatePaths) {
			if (emittedForTrigger >= maxSiblings) break;
			if (originFiles.has(candidatePath)) continue;
			// Markdown / doc files embed code snippets as illustration, not
			// as lintable source — skip them so a `JSON.parse` in a fenced
			// block in `docs/design/*.md` is never emitted as a sibling.
			if (isDocFile(candidatePath)) continue;

			const content = args.reader.read(candidatePath);
			if (content === undefined) continue;

			const match = findFirstMatch(content, spec.pattern);
			if (!match) continue;

			out.push({
				triggerName: spec.triggerName,
				siblingRuleId: spec.siblingRuleId,
				file: candidatePath,
				line: match.line,
				message: spec.messageTemplate(candidatePath, match.line, match.snippet),
			});
			emittedForTrigger++;
		}
	}
	return out;
}

function findFirstMatch(
	content: string,
	pattern: RegExp,
): { line: number; snippet: string } | null {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		pattern.lastIndex = 0;
		if (pattern.test(lines[i])) {
			const trimmed = lines[i].trim();
			const snippet =
				trimmed.length > SNIPPET_LENGTH ? `${trimmed.slice(0, SNIPPET_LENGTH)}…` : trimmed;
			return { line: i + 1, snippet };
		}
	}
	return null;
}

function toRelative(filePath: string, cwd: string): string {
	if (filePath.startsWith(`${cwd}/`)) return filePath.slice(cwd.length + 1);
	return filePath;
}

// ===========================================
// Phase D — endpoint-detector sibling rescan
// ===========================================
//
// Pure `findings → findings` transformer. When a Phase B endpoint-security
// detector fires on endpoint E in file F, rescan F for the same detector's
// hits and bundle sibling endpoints into the lead finding's `message`.
//
// Format (appended to the lead finding's message, separated by a blank
// line):
//
//   Same shape on N sibling endpoint(s) in <basename(file)>: <line>, <line>, …
//
// Detector-agnostic: the `rescan` callback isolates this transformer from
// which detector it's calling, so the same code works for all five
// endpoint-security detectors and any future detector following the
// `DetectorFinding` shape.
//
// Constraints (per the plan):
//   - Pure: input `findings` is not mutated; a new array is returned.
//   - Performance: <100ms per call even for routers with 100+ endpoints.
//     Each file is read at most once per call (content cache) and rescanned
//     at most once per call (rescan cache).
//   - Resilient: if `rescan` throws, the affected group's findings pass
//     through unchanged — a buggy detector cannot break the harness.

export interface ExpandEndpointDetectorSiblingsOpts {
	/** Re-run the same detector against the whole file. The transformer
	 * passes the file path + content and expects the full detector-finding
	 * set for that file. */
	rescan: (file: string, content: string) => DetectorFinding[];
	/** Read sibling file content. Defaults to `fs.readFileSync(p, "utf-8")`. */
	readFile?: (p: string) => string;
}

/**
 * Group findings by `(check_id, file)`, rescan each file once for siblings,
 * and append a `Same shape on N sibling endpoints in <file>: <line>, …`
 * suffix to the first finding in each group when siblings exist.
 *
 * Returns a new array; never mutates the input.
 */
export function expandEndpointDetectorSiblings(
	findings: DetectorFinding[],
	opts: ExpandEndpointDetectorSiblingsOpts,
): DetectorFinding[] {
	if (findings.length === 0) return [];
	const readFileFn = opts.readFile ?? defaultReadFile;

	// Per-call caches so a file with N original findings only triggers one
	// read + one rescan even when multiple check_ids hit it.
	const contentCache = new Map<string, string | null>();
	const rescanCache = new Map<string, DetectorFinding[] | null>();

	// Preserve input order; clone each finding so we never mutate the input.
	const result: DetectorFinding[] = findings.map((f) => ({ ...f }));

	// Build groups: check_id|file → indices into `result`.
	const groups = new Map<string, number[]>();
	for (let i = 0; i < findings.length; i += 1) {
		const key = `${findings[i].check_id}|${findings[i].file}`;
		const list = groups.get(key);
		if (list) list.push(i);
		else groups.set(key, [i]);
	}

	for (const [, indices] of groups) {
		const lead = result[indices[0]];
		const file = lead.file;
		const checkId = lead.check_id;

		// Load file content (once per file, regardless of how many groups
		// share it). A null cache entry means we already tried and failed.
		let content = contentCache.get(file);
		if (content === undefined) {
			try {
				content = readFileFn(file);
			} catch {
				content = null;
			}
			contentCache.set(file, content);
		}
		if (content === null) continue;

		// Rescan once per file. The detector typically returns findings for
		// all five check_ids on the file; we filter to the current group's
		// check_id below.
		let rescanned = rescanCache.get(file);
		if (rescanned === undefined) {
			try {
				rescanned = opts.rescan(file, content);
			} catch {
				rescanned = null;
			}
			rescanCache.set(file, rescanned);
		}
		if (rescanned === null) continue;

		const sameCheck = rescanned.filter((f) => f.check_id === checkId);

		// Siblings = rescan findings on lines NOT already in the original
		// group. Deduplicate by line — a detector that fires twice on the
		// same line counts once.
		const originalLines = new Set(indices.map((i) => result[i].line));
		const siblingLines: number[] = [];
		const seen = new Set<number>();
		for (const f of sameCheck) {
			if (originalLines.has(f.line)) continue;
			if (seen.has(f.line)) continue;
			seen.add(f.line);
			siblingLines.push(f.line);
		}
		if (siblingLines.length === 0) continue;

		siblingLines.sort((a, b) => a - b);
		const noun = siblingLines.length === 1 ? "endpoint" : "endpoints";
		const suffix = `Same shape on ${siblingLines.length} sibling ${noun} in ${basename(file)}: ${siblingLines.join(", ")}`;
		// Append with a blank line so the formatter renders the bundle as a
		// distinct paragraph. The lead finding owns the bundle; the rest of
		// the group is unchanged so the suffix doesn't print N times.
		result[indices[0]] = {
			...lead,
			message: `${lead.message}\n\n${suffix}`,
		};
	}

	return result;
}

function defaultReadFile(p: string): string {
	return readFileSync(p, "utf-8");
}
