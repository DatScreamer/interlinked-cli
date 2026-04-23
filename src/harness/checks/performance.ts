// Performance anti-pattern checks (loop-body analysis, repeated work, etc).
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Performance Anti-Pattern Checks
// ===========================================
// Deterministic regex/heuristic checks that detect performance bugs.
// Each returns InlineMatch[]. <5ms per check, no external dependencies.

// --- Loop Body Infrastructure ---

interface LoopBody {
	/** 1-based line number of first body line */
	startLine: number;
	/** Joined stripped body (comments/strings removed) */
	body: string;
	/** Per-line stripped content */
	bodyLines: string[];
	/** Per-line original content (for display) */
	originalBodyLines: string[];
}

/**
 * Extract loop bodies from brace-delimited languages (JS/TS/Rust/Go/C/C++).
 * Finds for/while/loop heads, tracks brace depth, captures body lines.
 */
function extractBraceLoopBodies(content: string): LoopBody[] {
	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const bodies: LoopBody[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		const _trimmed = strippedLines[i].trim();

		// Match loop heads: for (...) {, while (...) {, loop {
		// Also: Go/Rust for without parens — for ... {, for ... in ... {
		// Skip "for await" — that's an async iterator, not sequential
		if (!/^\s*(for\s*[\s(]|while\s*[\s(]|loop\s*\{)/.test(strippedLines[i])) continue;
		if (/\bfor\s+await\b/.test(strippedLines[i])) continue;

		// Find the opening brace — may be on same line or next few lines
		let braceLineIdx = -1;
		for (let k = i; k < Math.min(i + 5, strippedLines.length); k++) {
			if (strippedLines[k].includes("{")) {
				braceLineIdx = k;
				break;
			}
		}
		if (braceLineIdx === -1) continue;

		// Count all braces on the brace line to get initial depth
		let depth = 0;
		for (const ch of strippedLines[braceLineIdx]) {
			if (ch === "{") depth++;
			if (ch === "}") depth--;
		}
		if (depth <= 0) continue; // Single-line loop body or empty

		// Capture body lines
		const bodyStart = braceLineIdx + 1;
		const bodyStrippedLines: string[] = [];
		const bodyOriginalLines: string[] = [];
		let j = bodyStart;
		for (; j < strippedLines.length; j++) {
			for (const ch of strippedLines[j]) {
				if (ch === "{") depth++;
				if (ch === "}") depth--;
			}
			if (depth <= 0) break; // Closing brace reached
			bodyStrippedLines.push(strippedLines[j]);
			bodyOriginalLines.push(originalLines[j]);
		}

		if (bodyStrippedLines.length > 0) {
			bodies.push({
				startLine: bodyStart + 1, // 1-based
				body: bodyStrippedLines.join("\n"),
				bodyLines: bodyStrippedLines,
				originalBodyLines: bodyOriginalLines,
			});
		}

		// Skip past the loop body to avoid nested loop double-counting
		// (we still want to detect patterns in nested loops — they're part of the body)
	}

	return bodies;
}

/**
 * Extract loop bodies from Python (indent-delimited).
 * Finds for/while heads, captures all lines at deeper indent.
 */
function extractIndentLoopBodies(content: string): LoopBody[] {
	const stripped = stripComments(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const bodies: LoopBody[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		const trimmed = strippedLines[i].trim();
		if (!/^(for\s+.+|while\s+.+):\s*$/.test(trimmed)) continue;
		// Single-line body (e.g., "for x in y: pass") — skip
		if (/:\s*\S/.test(trimmed) && !trimmed.endsWith(":")) continue;

		const headIndent = strippedLines[i].search(/\S/);
		if (headIndent < 0) continue;

		const bodyStart = i + 1;
		const bodyStrippedLines: string[] = [];
		const bodyOriginalLines: string[] = [];

		for (let j = bodyStart; j < strippedLines.length; j++) {
			const line = strippedLines[j];
			if (line.trim() === "") {
				bodyStrippedLines.push(line);
				bodyOriginalLines.push(originalLines[j]);
				continue; // Blank lines don't break indent
			}
			const indent = line.search(/\S/);
			if (indent <= headIndent) break; // Exited the loop body
			bodyStrippedLines.push(line);
			bodyOriginalLines.push(originalLines[j]);
		}

		if (bodyStrippedLines.length > 0) {
			bodies.push({
				startLine: bodyStart + 1,
				body: bodyStrippedLines.join("\n"),
				bodyLines: bodyStrippedLines,
				originalBodyLines: bodyOriginalLines,
			});
		}
	}

	return bodies;
}

/** Get loop bodies for a file based on its language */
function getLoopBodies(content: string, filePath: string): LoopBody[] {
	const ext = getExtension(filePath);
	if (ext === ".py") return extractIndentLoopBodies(content);
	if (
		[
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".rs",
			".go",
			".c",
			".cpp",
			".cc",
			".cxx",
			".h",
			".hpp",
			".java",
			".swift",
		].includes(ext)
	) {
		return extractBraceLoopBodies(content);
	}
	return [];
}

// --- Tier 1: High confidence, significant impact ---

/**
 * Detect strlen() in loop condition — O(n) per iteration makes loop O(n²).
 * The compiler cannot hoist this because the string might be modified in the body.
 */
export function checkStrlenInLoopCondition(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\bfor\s*\([^;]*;[^;]*\bstrlen\s*\(/,
		10,
	);
}

/**
 * Detect .collect() immediately followed by .iter() — defeats Rust's
 * zero-cost iterator fusion. Materializes entire sequence into Vec just to re-iterate.
 */
export function checkCollectThenIterate(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".rs") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\.collect\s*(?:::<[^>]*>\s*)?\(\s*\)\s*\.\s*(iter|into_iter|len)\s*\(/,
		10,
	);
}

/**
 * Detect [...acc, item] inside .reduce() — O(n²) array copying.
 * Each iteration allocates and copies the entire accumulator array.
 */
export function checkSpreadInReduce(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!/\.reduce\s*\(/.test(strippedLines[i])) continue;

		// Scan the reduce callback body (up to 20 lines) for spread
		let depth = 0;
		for (let j = i; j < Math.min(i + 20, strippedLines.length); j++) {
			for (const ch of strippedLines[j]) {
				if (ch === "(") depth++;
				if (ch === ")") depth--;
			}
			if (/\[\s*\.\.\./.test(strippedLines[j]) && j > i) {
				matches.push({
					line: j + 1,
					text: originalLines[j].trim().slice(0, 150),
				});
				break;
			}
			if (depth <= 0 && j > i) break;
		}
	}

	return matches;
}

/**
 * Detect await inside for/while loops (not for-await-of).
 * Serializes inherently parallel work — use Promise.all() instead.
 */
/**
 * Check if an await at line `awaitIdx` within a loop body is inside a nested
 * async function/arrow. If so, the await is in a different execution scope
 * (e.g., promises.push(async () => { await ... })) and is NOT sequential.
 */
function isAwaitInNestedAsync(bodyLines: string[], awaitIdx: number): boolean {
	// Scan backward from the await line looking for async declarations.
	// Track brace depth relative to each async declaration.
	let depth = 0;
	for (let k = awaitIdx; k >= 0; k--) {
		const line = bodyLines[k];
		// Count braces in reverse — closing braces increase depth, opening decrease
		for (let c = line.length - 1; c >= 0; c--) {
			if (line[c] === "}") depth++;
			if (line[c] === "{") depth--;
		}
		// If we find an async declaration and we're inside its braces (depth < 0),
		// the await is inside a nested async function
		if (
			k < awaitIdx &&
			depth < 0 &&
			/\basync\s+(function\b|\(|[a-zA-Z_$]\w*\s*=>)/.test(line)
		) {
			return true;
		}
	}
	return false;
}

export function checkAwaitInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const bodies = extractBraceLoopBodies(content);
	const _originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (!/\bawait\b/.test(loop.bodyLines[i])) continue;

			// Skip if the await is inside a nested async function/arrow
			if (isAwaitInNestedAsync(loop.bodyLines, i)) continue;

			matches.push({
				line: loop.startLine + i,
				text: loop.originalBodyLines[i].trim().slice(0, 150),
			});
			break; // One per loop is enough
		}
	}

	return matches;
}

/**
 * Detect database queries inside loops — the N+1 query anti-pattern.
 * Each iteration is a round-trip to the database.
 */
export function checkQueryInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern =
			/\b(db|prisma|knex|sequelize|pool|client|connection|sql|supabase)\s*\.\s*(query|execute|exec|find|findOne|findMany|findUnique|findFirst|select|insert|update|delete|raw|prepare|get|all|run)\s*\(/;
	} else if (ext === ".py") {
		pattern =
			/\b(cursor|session|db|conn|connection)\s*\.\s*(execute|executemany|query|filter|all|get|fetch|fetchone|fetchall)\s*\(/;
	} else if (ext === ".go") {
		pattern = /\b(db|tx|conn|pool)\s*\.\s*(Query|QueryRow|Exec|Get|Select|NamedExec)\s*\(/;
	} else if (ext === ".rs") {
		pattern =
			/\b(sqlx::query|diesel::|\.execute|\.fetch_one|\.fetch_all|\.fetch_optional)\s*\(/;
	} else if (ext === ".java") {
		pattern =
			/\b(statement|preparedStatement|session|entityManager|jdbcTemplate)\s*\.\s*(execute|executeQuery|executeUpdate|find|persist|merge|createQuery)\s*\(/i;
	} else if (ext === ".swift") {
		pattern =
			/\b(context|viewContext|managedObjectContext)\s*\.\s*(fetch|execute|save|count)\s*\(|\b(db|dbQueue|dbPool)\s*\.\s*(read|write|execute)\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
				break; // One per loop
			}
		}
	}

	return matches;
}

/**
 * Detect string concatenation with += in loops — O(n²) in Python and Go.
 * Python strings are immutable; Go strings require reallocation.
 */
export function checkStringConcatInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".go") return [];

	const bodies = getLoopBodies(content, filePath);
	const matches: InlineMatch[] = [];
	const pattern = ext === ".py" ? /\w+\s*\+=\s*["'f]/ : /\w+\s*\+=\s*["'`]|fmt\.Sprintf/;

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect JSON.parse(JSON.stringify(x)) — two full traversals for deep clone.
 * Use structuredClone() instead (single traversal, handles more types).
 */
export function checkJsonClonePattern(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
		10,
	);
}

/**
 * Detect .filter(...).length — allocates throwaway array just to count.
 * Use .reduce() with counter or a loop instead.
 */
export function checkFilterLength(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\.filter\s*\([^)]*\)\s*\.length\b/, 10);
}

/**
 * Detect new RegExp() or re.compile() inside loop bodies.
 * Regex compilation is expensive — hoist above the loop.
 */
export function checkRegexInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\bnew\s+RegExp\s*\(/;
	} else if (ext === ".py") {
		pattern = /\bre\.compile\s*\(/;
	} else if (ext === ".swift") {
		pattern = /\bNSRegularExpression\s*\(pattern:|try\s+Regex\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect .clone() inside loop bodies in Rust — unnecessary heap allocation.
 * Borrow instead, or use Rc/Arc for shared ownership.
 */
export function checkCloneInLoop(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (/\.clone\s*\(\s*\)/.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect Math.max(...arr) / Math.min(...arr) — stack overflow on large arrays.
 * V8 has a hard limit on function arguments (~65K-125K).
 */
export function checkMathSpread(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /Math\.(max|min)\s*\(\s*\.\.\./, 10);
}

// --- Tier 2: Good signal, slightly more heuristic ---

/**
 * Detect .sort() / sorted() inside loop bodies — O(n² log n) total.
 * Sort once before the loop, or use a heap/priority queue.
 */
export function checkSortInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\.sort\s*\(/;
	} else if (ext === ".py") {
		pattern = /\bsorted\s*\(|\.sort\s*\(/;
	} else if (ext === ".rs") {
		pattern = /\.sort\s*\(|\.sort_by\s*\(|\.sort_unstable/;
	} else if (ext === ".go") {
		pattern = /\bsort\.(Slice|Sort|Strings|Ints|Float64s)\s*\(/;
	} else if ([".c", ".cpp", ".cc", ".cxx"].includes(ext)) {
		pattern = /\b(qsort|std::sort)\s*\(/;
	} else if (ext === ".swift") {
		pattern = /\.sorted\s*\(|\.sort\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
				break; // One per loop
			}
		}
	}

	return matches;
}

/**
 * Detect JSON.parse/stringify or json.loads/dumps inside loop bodies.
 * Serialization churn in hot paths — restructure to serialize outside the loop.
 */
export function checkJsonInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\bJSON\.(parse|stringify)\s*\(/;
	} else if (ext === ".py") {
		pattern = /\bjson\.(loads|dumps|load|dump)\s*\(/;
	} else if (ext === ".swift") {
		pattern =
			/\bJSONDecoder\s*\(\s*\)\s*\.decode\b|\bJSONEncoder\s*\(\s*\)\s*\.encode\b|\bJSONSerialization\s*\.\s*(?:jsonObject|data)\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect Array.from(x).map(fn) — double iteration.
 * Use Array.from(x, fn) which maps during construction (single pass).
 */
export function checkArrayFromMap(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/Array\.from\s*\([^)]*\)\s*\.map\s*\(/,
		10,
	);
}

/**
 * Detect malloc/calloc/realloc inside loop without free in same body.
 * Memory leak in hot path.
 */
export function checkMallocInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"].includes(ext)) return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		// Check if body has malloc but no free
		const hasFree = /\bfree\s*\(/.test(loop.body);
		if (hasFree) continue;

		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (/\b(malloc|calloc|realloc)\s*\(/.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
				break; // One per loop
			}
		}
	}

	return matches;
}

/**
 * Detect fmt.Sprintf inside loop in Go — allocates formatted string per iteration.
 * Use strings.Builder with WriteString/Fprintf instead.
 */
export function checkSprintfInLoop(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (/\bfmt\.Sprintf\s*\(/.test(loop.bodyLines[i])) {
				matches.push({
					line: loop.startLine + i,
					text: loop.originalBodyLines[i].trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect `as unknown as T` double-cast in TypeScript — bypasses all type checking.
 * Indicates a type design problem that prevents compiler optimization.
 */
export function checkDoubleTypeCast(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bas\s+unknown\s+as\b/, 10);
}

/**
 * Detect len(list(generator)) in Python — materializes entire sequence just to count.
 * Use sum(1 for ...) or collections.Counter instead.
 */
export function checkLenListGenerator(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\blen\s*\(\s*list\s*\(/, 10);
}
