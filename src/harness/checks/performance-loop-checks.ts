// interlinked-tdd: exempt
// Loop-body performance anti-pattern checks (await/query/sort/json/regex/clone/
// malloc/sprintf/string-concat in loops). Split out of performance.ts to keep
// that module under the per-file line cap. The shared loop-body extractors
// (`extractBraceLoopBodies`, `getLoopBodies`) stay in performance.ts —
// `extractBraceLoopBodies` exceeds the cyclomatic cap and anchors there — and
// are imported back here. Each detector's `loop` binding is inferred from those
// extractors' return type, so `LoopBody` itself need not be imported by name.

import { extractBraceLoopBodies, getLoopBodies } from "./performance.js";
import { getExtension, type InlineMatch } from "./shared.js";
import { nonNull } from "../../lib/non-null.js";

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
		const line = nonNull(bodyLines[k]);
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
			if (!/\bawait\b/.test(nonNull(loop.bodyLines[i]))) continue;

			// Skip if the await is inside a nested async function/arrow
			if (isAwaitInNestedAsync(loop.bodyLines, i)) continue;

			matches.push({
				line: loop.startLine + i,
				text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
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
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
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
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
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
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
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
			if (/\.clone\s*\(\s*\)/.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

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
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
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
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
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
			if (/\b(malloc|calloc|realloc)\s*\(/.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
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
			if (/\bfmt\.Sprintf\s*\(/.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}
