// ===========================================
// interlinked search — Local codebase search
// ===========================================
// Smart multi-term search: splits natural language queries into terms,
// searches for any term match, then ranks files by term density.
// Hybrid engine: ripgrep (if available) with Node.js fs fallback.
// Zero external dependencies — uses child_process for rg, native fs for fallback.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { c, header, truncate } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

// ===========================================
// Types
// ===========================================

interface SearchMatch {
	file: string;
	line: number;
	column?: number | undefined;
	text: string;
	context_before?: string[] | undefined;
	context_after?: string[] | undefined;
}

interface SearchResult {
	query: string;
	engine: "ripgrep" | "native";
	matches: SearchMatch[];
	total: number;
	truncated: boolean;
	searched_files: number;
	elapsed_ms: number;
}

// ===========================================
// Config
// ===========================================

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const CONTEXT_LINES = 2;

/** File extensions to search (when using native fallback) */
const SEARCHABLE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".toml",
	".sh",
	".bash",
	".zsh",
	".sql",
	".html",
	".css",
	".svelte",
	".vue",
	".rb",
	".php",
	".swift",
	".kt",
]);

/** Directories to always skip */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"__pycache__",
	".venv",
	"venv",
	"target",
	".tmp",
	"coverage",
	".interlinked",
	"playwright-report",
]);

// ===========================================
// Ripgrep engine
// ===========================================

function hasRipgrep(): boolean {
	const result = spawnSync("rg", ["--version"], { stdio: "pipe", timeout: 3000 });
	return result.status === 0;
}

function searchWithRipgrep(
	query: string,
	dir: string,
	opts: { limit: number; glob?: string | undefined; type?: string | undefined; context: number },
): SearchResult {
	const start = performance.now();
	const args = [
		"--json",
		"--max-count",
		String(opts.limit * 2), // over-fetch for dedup
		"-C",
		String(opts.context),
		"--smart-case",
	];

	if (opts.glob) {
		args.push("--glob", opts.glob);
	}
	if (opts.type) {
		args.push("--type", opts.type);
	}

	args.push("--", query, dir);

	const result = spawnSync("rg", args, {
		stdio: "pipe",
		timeout: 30000,
		maxBuffer: 10 * 1024 * 1024,
	});

	const matches: SearchMatch[] = [];
	let searchedFiles = 0;

	if (result.stdout) {
		const lines = result.stdout.toString("utf-8").split("\n").filter(Boolean);
		// Accumulate leading context lines that appear before the next match
		let pendingContext: string[] = [];

		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				if (obj.type === "match") {
					const data = obj.data;
					const file = relative(dir, data.path.text);
					const lineNum = data.line_number;
					const text = data.lines.text.replace(/\n$/, "");

					matches.push({
						file,
						line: lineNum,
						column: data.submatches?.[0]?.start,
						text,
						context_before: pendingContext.length > 0 ? pendingContext : undefined,
						context_after: [],
					});
					pendingContext = [];
				} else if (obj.type === "context") {
					const data = obj.data;
					const text = data.lines.text.replace(/\n$/, "");
					const ctxFile = relative(dir, data.path.text);
					const last = matches[matches.length - 1];
					// Trailing context: same file, line immediately after match (within context window)
					if (
						last &&
						ctxFile === last.file &&
						data.line_number > last.line &&
						data.line_number <= last.line + opts.context
					) {
						if (!last.context_after) last.context_after = [];
						last.context_after.push(text);
					} else {
						// Leading context for the next match (different file, or gap > context window)
						pendingContext.push(text);
					}
				} else if (obj.type === "summary") {
					searchedFiles = obj.data.stats?.searches || 0;
				}
			} catch (_) {
				/* intentional: ripgrep emits only well-formed JSON; skip on unexpected line */
			}
		}
	}

	const elapsed = performance.now() - start;
	const truncated = matches.length > opts.limit;
	const trimmed = matches.slice(0, opts.limit);

	return {
		query,
		engine: "ripgrep",
		matches: trimmed,
		total: matches.length,
		truncated,
		searched_files: searchedFiles,
		elapsed_ms: Math.round(elapsed),
	};
}

// ===========================================
// Native Node.js fallback engine
// ===========================================

function collectFiles(dir: string, root: string, result: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		if (entry.startsWith(".") && entry !== ".") continue;

		const fullPath = join(dir, entry);
		let stat;
		try {
			stat = statSync(fullPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			collectFiles(fullPath, root, result);
		} else if (stat.isFile()) {
			const ext = extname(entry).toLowerCase();
			if (SEARCHABLE_EXTENSIONS.has(ext) && stat.size < 1024 * 1024) {
				result.push(fullPath);
			}
		}
	}
}

/** Slices `context` lines before and after the match index for display context. */
function sliceContextWindow(
	lines: string[],
	matchIdx: number,
	context: number,
): { before: string[]; after: string[] } {
	const beforeStart = Math.max(0, matchIdx - context);
	const afterEnd = Math.min(lines.length, matchIdx + context + 1);
	return {
		before: lines.slice(beforeStart, matchIdx),
		after: lines.slice(matchIdx + 1, afterEnd),
	};
}

function searchWithNative(
	query: string,
	dir: string,
	opts: { limit: number; glob?: string | undefined; context: number },
): SearchResult {
	const start = performance.now();
	const matches: SearchMatch[] = [];
	let searchedFiles = 0;

	// Case-insensitive if query is all lowercase
	const isSmartCase = query === query.toLowerCase();
	// If query contains | (OR pattern from multi-term), don't escape it
	const isOrPattern = query.includes("|") && !query.includes("\\|");
	const pattern = isOrPattern ? query : escapeRegex(query);
	let regex: RegExp;
	try {
		// Reason: local-CLI grep against the user's own working tree — the
		// query is their own input; no remote attacker surface.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		regex = new RegExp(pattern, isSmartCase ? "gi" : "g");
	} catch {
		// Reason: fallback path compiles the escape-regex'd literal query —
		// no unsafe metacharacters reach the engine.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		regex = new RegExp(escapeRegex(query), "gi");
	}

	const globPattern = opts.glob ? globToRegex(opts.glob) : null;

	const allFiles: string[] = [];
	collectFiles(dir, dir, allFiles);

	for (const filePath of allFiles) {
		const relPath = relative(dir, filePath);

		// Apply glob filter
		if (globPattern && !globPattern.test(relPath)) continue;

		searchedFiles++;
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				regex.lastIndex = 0; // Reset for next test
				const { before, after } = sliceContextWindow(lines, i, opts.context);

				matches.push({
					file: relPath,
					line: i + 1,
					text: lines[i],
					context_before: before.length > 0 ? before : undefined,
					context_after: after.length > 0 ? after : undefined,
				});

				if (matches.length >= opts.limit * 2) break;
			}
		}

		if (matches.length >= opts.limit * 2) break;
	}

	const elapsed = performance.now() - start;
	const truncated = matches.length > opts.limit;
	const trimmed = matches.slice(0, opts.limit);

	return {
		query,
		engine: "native",
		matches: trimmed,
		total: matches.length,
		truncated,
		searched_files: searchedFiles,
		elapsed_ms: Math.round(elapsed),
	};
}

// ===========================================
// Helpers
// ===========================================

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{DOUBLESTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\{\{DOUBLESTAR\}\}/g, ".*");
	// Reason: all regex metacharacters are escaped above; only glob wildcards
	// are expanded into bounded patterns. No attacker-controllable source.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return new RegExp(escaped);
}

/**
 * Split a natural language query into searchable terms.
 * Filters out short noise words and returns individual terms.
 */
function splitQueryTerms(query: string): string[] {
	const STOP_WORDS = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"do",
		"does",
		"did",
		"has",
		"have",
		"had",
		"will",
		"would",
		"can",
		"could",
		"should",
		"may",
		"might",
		"shall",
		"in",
		"on",
		"at",
		"to",
		"for",
		"of",
		"with",
		"by",
		"from",
		"it",
		"its",
		"this",
		"that",
		"these",
		"those",
		"and",
		"or",
		"but",
		"not",
		"no",
		"if",
		"then",
		"so",
		"how",
		"what",
		"when",
		"where",
		"which",
		"who",
		"why",
	]);

	return query
		.split(/\s+/)
		.map((t) => t.replace(/[^a-zA-Z0-9_.-]/g, ""))
		.filter((t) => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
}

/**
 * Determine if a query should use smart multi-term search.
 * Returns true for multi-word natural language queries.
 */
function isMultiTermQuery(query: string): boolean {
	const terms = splitQueryTerms(query);
	return terms.length >= 2;
}

/**
 * Build a ripgrep-compatible OR pattern from multiple terms.
 * e.g., ["OAuth", "token", "validation"] → "OAuth|token|validation"
 */
function buildOrPattern(terms: string[]): string {
	return terms.map(escapeRegex).join("|");
}

interface FileRanking {
	file: string;
	termsMatched: number;
	totalTerms: number;
	matchedTerms: string[];
	matchCount: number;
}

/**
 * Rank files by how many distinct query terms they contain.
 */
function rankFilesByTermDensity(matches: SearchMatch[], terms: string[]): FileRanking[] {
	const fileData = new Map<string, { lines: Set<string>; count: number }>();

	for (const m of matches) {
		const entry = fileData.get(m.file) || { lines: new Set(), count: 0 };
		entry.lines.add(m.text);
		entry.count++;
		fileData.set(m.file, entry);
	}

	const rankings: FileRanking[] = [];
	const lowerTerms = terms.map((t) => t.toLowerCase());

	for (const [file, data] of Array.from(fileData.entries())) {
		const allText = [...data.lines].join("\n").toLowerCase();
		const matchedTerms: string[] = [];
		for (let i = 0; i < lowerTerms.length; i++) {
			if (allText.includes(lowerTerms[i])) {
				matchedTerms.push(terms[i]);
			}
		}

		rankings.push({
			file,
			termsMatched: matchedTerms.length,
			totalTerms: terms.length,
			matchedTerms,
			matchCount: data.count,
		});
	}

	// Sort by: most terms matched, then most total matches
	return rankings.sort((a, b) => b.termsMatched - a.termsMatched || b.matchCount - a.matchCount);
}

// ===========================================
// Command
// ===========================================

export function searchCommand(
	query: string,
	opts: {
		path?: string;
		glob?: string;
		type?: string;
		limit?: string;
		context?: string;
		engine?: string;
		json?: boolean;
		short?: boolean;
		full?: boolean;
	},
): void {
	const mode = getOutputMode(opts);

	if (!query || query.trim().length === 0) {
		outputError(mode, "Search query is required");
		return;
	}

	const dir = opts.path || process.cwd();
	const limit = Math.min(
		Math.max(1, Number.parseInt(opts.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
		MAX_LIMIT,
	);
	const context = Math.min(
		Math.max(0, Number.parseInt(opts.context || String(CONTEXT_LINES), 10) || CONTEXT_LINES),
		10,
	);

	// Choose engine
	const useRipgrep = opts.engine !== "native" && hasRipgrep();
	if (opts.engine === "ripgrep" && !useRipgrep) {
		outputError(mode, "ripgrep (rg) not found. Install it or use --engine=native");
		return;
	}

	// Smart multi-term search: split natural language queries into OR pattern
	const multiTerm = isMultiTermQuery(query);
	const terms = multiTerm ? splitQueryTerms(query) : [query];
	const searchQuery = multiTerm ? buildOrPattern(terms) : query;

	let result: SearchResult;
	if (useRipgrep) {
		result = searchWithRipgrep(searchQuery, dir, {
			limit,
			glob: opts.glob,
			type: opts.type,
			context,
		});
		// Override the query in results for display (show original, not regex)
		result.query = query;
	} else {
		result = searchWithNative(searchQuery, dir, { limit, glob: opts.glob, context });
		result.query = query;
	}

	// For multi-term queries, rank files by term density
	const rankings =
		multiTerm && result.matches.length > 0
			? rankFilesByTermDensity(result.matches, terms)
			: undefined;

	output(
		mode,
		{ ...result, rankings },
		{
			json: () => ({ ...result, rankings }),
			short: () =>
				result.matches.length === 0
					? "No matches"
					: `${result.total} match${result.total !== 1 ? "es" : ""} in ${result.searched_files} files (${result.engine}, ${result.elapsed_ms}ms)`,
			normal: () => renderNormal(result, rankings),
			full: () => renderFull(result, rankings),
		},
	);
}

// ===========================================
// Renderers
// ===========================================

function renderRankingSummary(rankings: FileRanking[]): string[] {
	const lines: string[] = [];
	const top = rankings.slice(0, 10);
	if (top.length === 0) return lines;

	lines.push(c.bold("Most relevant files:"));
	const HIGH_MATCH_PCT = 75;
	const MEDIUM_MATCH_PCT = 50;
	for (const r of top) {
		const pct = Math.round((r.termsMatched / r.totalTerms) * 100);
		const label = `${pct}%`;
		let bar: string;
		if (pct >= HIGH_MATCH_PCT) {
			bar = c.green(label);
		} else if (pct >= MEDIUM_MATCH_PCT) {
			bar = c.yellow(label);
		} else {
			bar = c.dim(label);
		}
		const terms = c.dim(`[${r.matchedTerms.join(", ")}]`);
		lines.push(`  ${bar} ${c.bold(r.file)} ${terms}`);
	}
	lines.push("");
	return lines;
}

function renderNormal(result: SearchResult, rankings?: FileRanking[]): string {
	const lines: string[] = [];
	lines.push(header(`Search: "${result.query}"`));
	lines.push(
		c.dim(
			`  ${result.engine} · ${result.total} match${result.total !== 1 ? "es" : ""} · ${result.searched_files} files · ${result.elapsed_ms}ms`,
		),
	);
	lines.push("");

	if (result.matches.length === 0) {
		lines.push(c.dim("  No matches found."));
		return lines.join("\n");
	}

	// Show file ranking summary for multi-term queries
	if (rankings) {
		lines.push(...renderRankingSummary(rankings));
	}

	// Group by file, ordered by ranking if available
	const byFile = new Map<string, SearchMatch[]>();
	if (rankings) {
		// Use ranking order
		for (const r of rankings) {
			byFile.set(r.file, []);
		}
	}
	for (const m of result.matches) {
		const existing = byFile.get(m.file) || [];
		existing.push(m);
		byFile.set(m.file, existing);
	}

	for (const [file, matches] of byFile) {
		if (matches.length === 0) continue;
		lines.push(c.bold(file));
		for (const m of matches) {
			const lineStr = c.dim(`${String(m.line).padStart(4)}:`);
			lines.push(`  ${lineStr} ${truncate(m.text, 120)}`);
		}
		lines.push("");
	}

	if (result.truncated) {
		lines.push(
			c.dim(
				`  … ${result.total - result.matches.length} more matches (use --limit to see more)`,
			),
		);
	}

	return lines.join("\n");
}

function renderFull(result: SearchResult, rankings?: FileRanking[]): string {
	const lines: string[] = [];
	lines.push(header(`Search: "${result.query}"`));
	lines.push(
		c.dim(
			`  ${result.engine} · ${result.total} match${result.total !== 1 ? "es" : ""} · ${result.searched_files} files · ${result.elapsed_ms}ms`,
		),
	);
	lines.push("");

	if (result.matches.length === 0) {
		lines.push(c.dim("  No matches found."));
		return lines.join("\n");
	}

	// Show file ranking summary for multi-term queries
	if (rankings) {
		lines.push(...renderRankingSummary(rankings));
	}

	for (const m of result.matches) {
		lines.push(`${c.bold(m.file)}:${c.yellow(String(m.line))}`);
		if (m.context_before) {
			for (const ctx of m.context_before) {
				lines.push(c.dim(`    ${ctx}`));
			}
		}
		lines.push(`  > ${m.text}`);
		if (m.context_after) {
			for (const ctx of m.context_after) {
				lines.push(c.dim(`    ${ctx}`));
			}
		}
		lines.push("");
	}

	if (result.truncated) {
		lines.push(
			c.dim(
				`  … ${result.total - result.matches.length} more matches (use --limit to see more)`,
			),
		);
	}

	return lines.join("\n");
}
