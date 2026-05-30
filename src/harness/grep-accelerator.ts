// ===========================================
// Grep Accelerator — PreToolUse index-backed search
// ===========================================
// Intercepts Grep and Bash (rg/grep) tool calls, queries the trigram
// index for candidate files, runs ripgrep on just those files, and
// returns results via the block-and-answer pattern.
//
// The agent sees formatted search results as the block reason — faster
// and more targeted than a full-repo scan. Includes selectivity metadata
// that helps the agent assess result quality.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { decomposePattern, parseGrepCommand } from "./regex-trigrams.js";
import type { TrigramIndex } from "./trigram-index.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

// ===========================================
// File Content Cache
// ===========================================
// Caches file content read during PostToolUse dirty-layer updates.
// The in-process matcher checks this cache first, avoiding redundant
// disk reads for files the agent just edited.

const DEFAULT_CACHE_MAX = 500;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export class FileContentCache {
	private entries = new Map<string, { content: string; ts: number }>();
	private maxEntries: number;
	private ttlMs: number;

	constructor(maxEntries = DEFAULT_CACHE_MAX, ttlMs = DEFAULT_CACHE_TTL_MS) {
		this.maxEntries = maxEntries;
		this.ttlMs = ttlMs;
	}

	/** Cache file content (called from server.ts on PostToolUse file writes) */
	set(relPath: string, content: string): void {
		// Evict oldest if at capacity
		if (this.entries.size >= this.maxEntries) {
			let oldestKey: string | null = null;
			let oldestTs = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.entries) {
				if (entry.ts < oldestTs) {
					oldestTs = entry.ts;
					oldestKey = key;
				}
			}
			if (oldestKey) this.entries.delete(oldestKey);
		}
		this.entries.set(relPath, { content, ts: Date.now() });
	}

	/** Get cached content if fresh, or null */
	get(relPath: string): string | null {
		const entry = this.entries.get(relPath);
		if (!entry) return null;
		if (Date.now() - entry.ts > this.ttlMs) {
			this.entries.delete(relPath);
			return null;
		}
		return entry.content;
	}

	/** Invalidate a specific file (e.g., on delete) */
	invalidate(relPath: string): void {
		this.entries.delete(relPath);
	}

	/** Number of cached entries */
	get size(): number {
		return this.entries.size;
	}

	/** Clear the entire cache */
	clear(): void {
		this.entries.clear();
	}
}

// ===========================================
// Configuration
// ===========================================

interface GrepAcceleratorConfig {
	/** Maximum candidate files before falling through to normal grep (default: 500) */
	maxCandidates?: number;
	/** Maximum ratio of candidates/total before falling through (default: 0.3) */
	maxCandidateRatio?: number;
	/** Maximum output lines to return (default: 200) */
	maxOutputLines?: number;
	/** Ripgrep timeout in milliseconds (default: 10000) */
	rgTimeout?: number;
	/** Maximum candidates for in-process JS matching instead of rg spawn (default: 50).
	 *  Used ONLY for fixed-string (-F) patterns, where a JS substring match is
	 *  provably identical to `rg -F`. Regex patterns always go through rg so the
	 *  engine dialect matches the native command exactly. */
	inProcessThreshold?: number;
	/** Whether the index is provably current with disk — HEAD == baseCommit, a
	 *  clean working tree, and no in-memory dirty layer. The daemon computes this
	 *  and passes it in. When false the accelerator declines (returns null) so a
	 *  stale index can never produce a silent false negative — the central
	 *  completeness guarantee of the never-worse-than-native contract. Default
	 *  false: callers MUST opt in by asserting freshness. */
	indexFresh?: boolean;
	/** Minimum total indexed files before substitution is permitted. Below this,
	 *  a native rg/ugrep full scan is already fast enough that the index lookup +
	 *  rg spawn overhead cannot guarantee a net win, so we decline. Default 25000
	 *  — the substitution only pays off at large-monorepo scale (see the timing
	 *  analysis in docs). */
	minFilesForAccel?: number;
}

const DEFAULTS: Required<GrepAcceleratorConfig> = {
	maxCandidates: 500,
	maxCandidateRatio: 0.3,
	maxOutputLines: 200,
	rgTimeout: 10_000,
	inProcessThreshold: 50,
	indexFresh: false,
	minFilesForAccel: 25_000,
};

// ===========================================
// Main Entry Point
// ===========================================

/**
 * Check if a PreToolUse event can be accelerated via the trigram index.
 * Returns a HarnessDecision with results if acceleration is possible,
 * or null to fall through to normal execution.
 */
export function checkGrepAcceleration(
	event: HarnessEvent,
	index: TrigramIndex | null,
	config: GrepAcceleratorConfig = {},
	contentCache?: FileContentCache,
): HarnessDecision | null {
	if (!index) return null;

	const cfg = { ...DEFAULTS, ...config };
	const toolName = event.tool_name || "";
	const toolInput = event.tool_input || {};

	// Determine if this is a Grep tool call or a Bash grep/rg command
	const searchParams = extractSearchParams(toolName, toolInput);
	if (!searchParams) return null;

	const { pattern, isRegex, caseInsensitive, path, glob, outputMode } = searchParams;

	// --- Never-worse-than-native gates ---
	// On ANY uncertainty, return null so the real rg/ugrep runs unchanged.
	//   (1) Staleness: only substitute when the index is provably current with
	//       disk (the daemon asserts this via cfg.indexFresh). A stale index
	//       could omit a file that exists on disk and matches — a silent false
	//       negative the agent could not detect. This is the completeness gate.
	//   (2) Speed: only when the repo is large enough that the guaranteed win
	//       exceeds index-lookup + rg-spawn overhead; below that a native full
	//       scan is already fast, so substituting risks being *slower*.
	//   (3) Output shape: a glob (-g) or a non-content output mode (-l/-c) would
	//       change the file universe or the output format in ways the
	//       substitution does not reproduce byte-for-byte.
	if (!cfg.indexFresh) return null;
	if (index.totalFiles < cfg.minFilesForAccel) return null;
	if (glob || outputMode) return null;

	// Decompose pattern into required trigrams
	const decomposition = decomposePattern(pattern, isRegex, caseInsensitive);
	if (!decomposition.hasLiterals) {
		// No extractable literals (pure wildcard like .* or .+)
		return null;
	}

	// Query the index
	const candidateIds = index.query(
		decomposition.requiredTrigrams,
		decomposition.trigramSequences,
	);
	let candidates = [...candidateIds]
		.map((id) => index.files[id] || getFilePath(index, id))
		.filter((p): p is string => p !== undefined);

	// Apply glob filter if specified
	if (glob) {
		candidates = candidates.filter((p) => matchGlob(p, glob));
	}

	// Apply path filter if specified.
	// Resolve absolute paths to relative (index stores relative paths).
	if (path && path !== ".") {
		let relPath = path;
		if (isAbsolute(path)) {
			relPath = relative(index.cwd, path);
		}
		const pathPrefix = relPath.endsWith("/") ? relPath : `${relPath}/`;
		candidates = candidates.filter((p) => p === relPath || p.startsWith(pathPrefix));
	}

	const totalFiles = index.totalFiles;
	const ratio = totalFiles > 0 ? candidates.length / totalFiles : 1;

	// Decision logic
	const selectivityPct = totalFiles > 0 ? (candidates.length / totalFiles) * 100 : 0;

	if (candidates.length === 0) {
		// No files contain all required trigrams according to the index.
		// Fall through to normal grep instead of blocking — the index may be
		// stale, incomplete (files above size limit, binary detection false
		// positives), or the trigram decomposition may have been lossy.
		// Safety over false negatives: let grep run and find real matches.
		return null;
	}

	if (candidates.length > cfg.maxCandidates || ratio > cfg.maxCandidateRatio) {
		// Too many candidates — index can't help enough, add context as warning
		return {
			decision: "allow",
			warnings: [
				`[interlinked:index] Pattern matches ${candidates.length}/${totalFiles} files (${(ratio * 100).toFixed(1)}%) — broad pattern, consider narrowing your search.`,
			],
			grep_stats: {
				candidates: candidates.length,
				total_files: totalFiles,
				selectivity_pct: selectivityPct,
				match_count: 0,
				accelerated: false,
			},
		};
	}

	// --- Match with native-identical semantics ---
	// Fixed-string (-F) patterns: a JS substring scan is provably identical to
	// `rg -F`, so the in-process matcher is used for small candidate sets to
	// avoid a spawn. Regex patterns: ALWAYS use rg's real engine — JS RegExp and
	// rg's regex dialect differ (POSIX classes, backreferences, Unicode), and
	// only rg guarantees the same matches as the native command. The freshness
	// gate above makes the candidate set a complete superset, so rg-on-candidates
	// returns exactly what rg-on-the-whole-tree would.
	let rgResult: RipgrepResult | null;
	if (!isRegex && candidates.length <= cfg.inProcessThreshold) {
		rgResult = matchInProcess({
			pattern,
			candidates,
			cwd: index.cwd,
			isRegex,
			caseInsensitive,
			outputMode,
			maxOutputLines: cfg.maxOutputLines,
			// Read disk, not the dirty-layer cache: under the freshness gate the
			// working tree is clean so disk == index, and bypassing the cache
			// closes the narrow edit-then-revert-within-TTL staleness window.
			contentCache: undefined,
		});
		// Fall back to rg if JS regex compilation fails
		if (rgResult === null) {
			rgResult = runRipgrepOnCandidates(
				pattern,
				candidates,
				index.cwd,
				isRegex,
				caseInsensitive,
				outputMode,
				cfg,
			);
		}
	} else {
		rgResult = runRipgrepOnCandidates(
			pattern,
			candidates,
			index.cwd,
			isRegex,
			caseInsensitive,
			outputMode,
			cfg,
		);
	}

	if (rgResult === null) {
		// ripgrep unavailable or errored — fall through to native.
		return null;
	}
	if (rgResult.truncated) {
		// Completeness: native rg/ugrep returns ALL matches. Rather than hand
		// back a truncated answer, decline so the real command runs.
		return null;
	}
	if (rgResult.matchCount === 0) {
		// Zero matches: native rg/ugrep prints nothing (exit 1). Decline so the
		// agent sees that empty result rather than a substituted "no matches"
		// message — keeps the substitution neutral on empty results, and guards
		// against a stale index that over-selected candidates which don't match.
		return null;
	}

	return {
		decision: "block",
		reason: formatResults(
			pattern,
			rgResult.output,
			rgResult.matchCount,
			candidates.length,
			totalFiles,
			false,
		),
		grep_stats: {
			candidates: candidates.length,
			total_files: totalFiles,
			selectivity_pct: selectivityPct,
			match_count: rgResult.matchCount,
			accelerated: true,
		},
	};
}

// ===========================================
// Search Parameter Extraction
// ===========================================

interface SearchParams {
	pattern: string;
	isRegex: boolean;
	caseInsensitive: boolean;
	path?: string;
	glob?: string;
	outputMode?: string;
}

function extractSearchParams(toolName: string, toolInput: JsonObject): SearchParams | null {
	// Claude Code's Grep tool
	if (toolName === "Grep") {
		const pattern = toolInput.pattern as string;
		if (!pattern) return null;
		return {
			pattern,
			isRegex: true, // Claude Code's Grep uses regex
			caseInsensitive: (toolInput["-i"] as boolean) || false,
			path: toolInput.path as string,
			glob: toolInput.glob as string,
			outputMode: toolInput.output_mode as string,
		};
	}

	// Bash/Shell tool — check for rg/grep commands
	if (
		toolName === "Bash" ||
		toolName === "Shell" ||
		toolName === "shell" ||
		toolName === "run_command"
	) {
		const command = (toolInput.command as string) || "";
		return parseGrepCommand(command);
	}

	return null;
}

// ===========================================
// Safe RegExp construction (ReDoS mitigation)
// ===========================================

const MAX_PATTERN_LENGTH = 1000;

/** Compile a RegExp with length limit to mitigate ReDoS from agent-supplied patterns */
function safeRegExp(source: string, flags: string): RegExp | null {
	if (source.length > MAX_PATTERN_LENGTH) return null;
	try {
		// Reason: this *is* the mitigation — length-capped above and wrapped
		// in try/catch. Callers must route patterns through this helper.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		return new RegExp(source, flags);
	} catch {
		return null;
	}
}

// ===========================================
// In-Process Matching (small candidate sets)
// ===========================================

interface MatchOptions {
	pattern: string;
	candidates: string[];
	cwd: string;
	isRegex: boolean;
	caseInsensitive: boolean;
	outputMode: string | undefined;
	maxOutputLines: number;
	contentCache?: FileContentCache;
}

function matchInProcess(opts: MatchOptions): RipgrepResult | null {
	const {
		pattern,
		candidates,
		cwd,
		isRegex,
		caseInsensitive,
		outputMode,
		maxOutputLines,
		contentCache,
	} = opts;
	const flags = caseInsensitive ? "gi" : "g";
	const source = isRegex ? pattern : escapeRegex(pattern);
	const regex = safeRegExp(source, flags);
	if (!regex) return null;

	const lines: string[] = [];
	let matchCount = 0;
	const fileMatchCounts = new Map<string, number>();

	for (const relPath of candidates) {
		// Check content cache first (populated on PostToolUse file writes),
		// avoiding redundant disk reads for files the agent just edited.
		let content: string | null = contentCache?.get(relPath) ?? null;
		if (content === null) {
			try {
				content = readFileSync(join(cwd, relPath), "utf-8");
			} catch {
				continue;
			}
		}

		const fileLines = content.split("\n");
		let fileMatches = 0;
		for (let lineNum = 0; lineNum < fileLines.length; lineNum++) {
			regex.lastIndex = 0;
			if (regex.test(fileLines[lineNum])) {
				fileMatches++;
				matchCount++;
				if (outputMode === "files_with_matches") {
					lines.push(relPath);
					break; // one match per file
				}
				if (outputMode !== "count") {
					// No per-file cap: the substitution must return the SAME matches
					// as native rg. Completeness is enforced by the caller's
					// truncation check (checkGrepAcceleration declines if exceeded).
					lines.push(`${relPath}:${lineNum + 1}:${fileLines[lineNum]}`);
				}
			}
		}
		if (outputMode === "count" && fileMatches > 0) {
			fileMatchCounts.set(relPath, fileMatches);
		}
	}

	if (outputMode === "count") {
		for (const [path, count] of fileMatchCounts) {
			lines.push(`${path}:${count}`);
		}
	}

	const truncated = lines.length > maxOutputLines;
	return {
		output: lines.slice(0, maxOutputLines).join("\n"),
		matchCount,
		truncated,
	};
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ===========================================
// Ripgrep Execution
// ===========================================

interface RipgrepResult {
	output: string;
	matchCount: number;
	truncated: boolean;
}

function runRipgrepOnCandidates(
	pattern: string,
	candidates: string[],
	cwd: string,
	isRegex: boolean,
	caseInsensitive: boolean,
	outputMode: string | undefined,
	cfg: Required<GrepAcceleratorConfig>,
): RipgrepResult | null {
	// Find ripgrep binary
	const rgPath = findRipgrep();
	if (!rgPath) return null;

	// Build rg arguments based on output mode
	const args: string[] = ["--no-heading", "--color=never"];

	if (outputMode === "files_with_matches") {
		args.push("--files-with-matches");
	} else if (outputMode === "count") {
		args.push("--count");
	} else {
		// Default: content mode with line numbers, ALWAYS with the filename so a
		// single-candidate result still emits `path:line:content` (rg omits the
		// path for a lone file argument) — matching native recursive output. No
		// per-file cap: completeness is enforced by the caller's truncation check.
		args.push("--with-filename", "--line-number");
	}

	if (!isRegex) args.push("--fixed-strings");
	if (caseInsensitive) args.push("--ignore-case");

	// Add the pattern and candidate files
	args.push("--", pattern, ...candidates);

	// Use spawnSync instead of execSync: passes args directly (no shell, no
	// shellEscape needed), uses streaming I/O, and has ~2ms less overhead.
	const result = spawnSync(rgPath, args, {
		cwd,
		encoding: "utf-8",
		timeout: cfg.rgTimeout,
		maxBuffer: 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});

	// rg exit code 1 = no matches (not an error)
	if (result.status === 1) {
		return { output: "", matchCount: 0, truncated: false };
	}
	// rg exit code 2+ or signal = error, fall through
	if (result.status !== 0 || result.error) {
		return null;
	}

	return processRgOutput(result.stdout as string, cfg.maxOutputLines);
}

function processRgOutput(output: string, maxLines: number): RipgrepResult {
	const lines = output.split("\n");
	const matchCount = lines.filter((l) => l.length > 0).length;

	if (lines.length > maxLines) {
		return {
			output: lines.slice(0, maxLines).join("\n"),
			matchCount,
			truncated: true,
		};
	}

	return { output: output.trimEnd(), matchCount, truncated: false };
}

// ===========================================
// Output Formatting
// ===========================================

function formatResults(
	pattern: string,
	output: string,
	matchCount: number,
	candidateCount: number,
	totalFiles: number,
	truncated: boolean,
): string {
	if (matchCount === 0) {
		const selectivity = ((candidateCount / totalFiles) * 100).toFixed(2);
		return [
			`[interlinked:index] Searched ${candidateCount} candidate files (from ${totalFiles} total, ${selectivity}% selectivity)`,
			`No matches for pattern: ${pattern}`,
			`The index identified ${candidateCount} files that could contain the pattern, but ripgrep found no actual matches.`,
		].join("\n");
	}

	// Compress output: group by file, show path once per file group.
	// Saves ~40 chars per line × N lines when all results are in one file.
	const compressed = compressGrepOutput(output);

	const parts: string[] = [];
	parts.push(compressed);
	if (truncated) {
		parts.push(`\n... (output truncated, ${matchCount} total matches)`);
	}

	return parts.join("\n");
}

/**
 * Compress rg-style output by grouping matches under file headers.
 *
 * Input (rg --no-heading format):
 *   src/foo.ts:10:export function bar()
 *   src/foo.ts:20:export function baz()
 *   src/other.ts:5:export function qux()
 *
 * Output (grouped):
 *   src/foo.ts
 *   10:export function bar()
 *   20:export function baz()
 *
 *   src/other.ts
 *   5:export function qux()
 *
 * For files_with_matches / count modes (no colon-line format), returns as-is.
 */
function compressGrepOutput(output: string): string {
	const lines = output.split("\n");

	// Detect if this is content mode (path:line:content).
	// files_with_matches and count modes don't have the triple-colon format.
	// Sample at first non-empty line.
	const sample = lines.find((l) => l.length > 0);
	if (!sample) return output;

	// Content mode lines match: path:number:content
	// We need at least two colons where the second segment is a number.
	const contentMatch = sample.match(/^(.+?):(\d+):/);
	if (!contentMatch) return output; // Not content mode, return as-is

	// Group lines by file path
	const groups: Map<string, string[]> = new Map();
	const groupOrder: string[] = [];

	for (const line of lines) {
		if (!line) continue;
		// Parse path:lineNum:rest — careful with paths containing colons (Windows, etc.)
		const m = line.match(/^(.+?):(\d+):(.*)/);
		if (!m) {
			// Non-matching line (separator, etc.) — append to last group
			const lastKey = groupOrder[groupOrder.length - 1];
			if (lastKey) groups.get(lastKey)!.push(line);
			continue;
		}
		const [, filePath, lineNum, content] = m;
		if (!groups.has(filePath)) {
			groups.set(filePath, []);
			groupOrder.push(filePath);
		}
		groups.get(filePath)!.push(`${lineNum}:${content}`);
	}

	// If only one group, or compression doesn't save much, use grouped format
	const parts: string[] = [];
	for (const filePath of groupOrder) {
		const fileLines = groups.get(filePath)!;
		parts.push(filePath);
		for (const fl of fileLines) {
			parts.push(fl);
		}
		parts.push(""); // blank line between groups
	}

	// Remove trailing blank line
	if (parts[parts.length - 1] === "") parts.pop();

	return parts.join("\n");
}

// ===========================================
// Helpers
// ===========================================

/** Get file path from dirty new files */
function getFilePath(_index: TrigramIndex, _id: number): string | undefined {
	// The public `files` array only covers base files.
	// For dirty files, the caller should handle this.
	// In practice, query() returns IDs that are resolved by queryCandidatePaths().
	return undefined;
}

let _rgPath: string | null | undefined;

/** Find the ripgrep binary on PATH */
export function findRipgrep(): string | null {
	if (_rgPath !== undefined) return _rgPath;

	// Try common install locations first (avoids shell function resolution issues)
	const commonPaths = [
		"/opt/homebrew/bin/rg",
		"/usr/local/bin/rg",
		"/usr/bin/rg",
		`${process.env.HOME}/.cargo/bin/rg`,
	];
	for (const p of commonPaths) {
		try {
			if (existsSync(p)) {
				_rgPath = p;
				return _rgPath;
			}
		} catch (e) {
			void e;
		}
	}

	// Fall back to PATH lookup (works when rg is a real binary, not a shell function)
	try {
		const found = execSync("which rg 2>/dev/null || command -v rg 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
			shell: "/bin/sh",
		}).trim();
		if (found && !found.includes("\n") && !found.includes("function")) {
			_rgPath = found;
			return _rgPath;
		}
	} catch (e) {
		void e;
	}

	_rgPath = null;
	return _rgPath;
}

/** Reset cached rg path (for testing) */
export function _resetRgPathCache(): void {
	_rgPath = undefined;
}

/** Simple glob matching (supports *, **, ?) */
function matchGlob(path: string, glob: string): boolean {
	// Convert glob to regex
	let pattern = "";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				pattern += ".*";
				i += 2;
				if (glob[i] === "/") {
					pattern += "\\/";
					i++;
				}
			} else {
				pattern += "[^/]*";
				i++;
			}
		} else if (ch === "?") {
			pattern += "[^/]";
			i++;
		} else if (ch === ".") {
			pattern += "\\.";
			i++;
		} else {
			pattern += ch;
			i++;
		}
	}
	try {
		// Reason: `pattern` is assembled above by escaping glob metachars
		// into bounded regex equivalents; anchored match over a file path.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		return new RegExp(`^${pattern}$`).test(path);
	} catch {
		return true; // invalid glob = match everything
	}
}
