// ===========================================
// Taste Checks — rule-based code quality checks sourced from Robert C. Martin's essays.
// ===========================================
// Each check follows the same shape as generic-checks.ts:
//   fn(content: string, filePath: string) => InlineMatch[]
// Inline checks only — no cross-file analysis, no LLM inference.

import { stripAllLiterals, stripComments } from "./strip-helpers.js";

interface InlineMatch {
	line: number;
	text: string;
}

// ===========================================
// Local helpers
// ===========================================

function getExt(p: string): string {
	const i = p.lastIndexOf(".");
	return i === -1 ? "" : p.slice(i).toLowerCase();
}

function isTestFile(filePath: string): boolean {
	const n = filePath.replace(/\\/g, "/");
	if (n.includes("/__tests__/") || n.includes("/tests/") || n.includes("/src/test/")) return true;
	const f = n.split("/").pop() || "";
	if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return true;
	if (f.startsWith("test_") && f.endsWith(".py")) return true;
	if (f.endsWith("_test.py") || f.endsWith("_test.go")) return true;
	if (/Tests?\.(java|swift)$/.test(f)) return true;
	return false;
}

function isJsTs(filePath: string): boolean {
	return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(getExt(filePath));
}

/**
 * Derives stripCommentsAndStrings from the shared pipeline. Uses the full
 * template + regex + comment + string strip, because some source files
 * contain regex literals with backticks inside them (e.g. a regex that
 * matches template literals). Without regex stripping, those backticks
 * are mis-interpreted as template delimiters and corrupt comment-tracker
 * state for the rest of the file — causing false-positive matches on
 * content that should have been blanked.
 */
function stripCommentsAndStrings(content: string): string {
	return stripAllLiterals(content);
}

/**
 * Find the closing brace that ends a test-function's callback body.
 *
 * Handles three `it`/`test` signatures:
 *   - `it("desc", () => { body })` — callback at arg 2
 *   - `it(\`tpl ${x}\`, () => { body })` — template title (interpolations
 *     are already blanked by stripTemplateLiterals)
 *   - `it("desc", { timeout: N }, async () => { body })` — options object
 *     at arg 2, callback at arg 3
 *
 * Strategy: skip over anything up to the FIRST `=>` or `function` keyword —
 * those mark the start of the callback. Then the next `{` is the callback
 * body, and we balance braces from there.
 */
function findBlockEnd(strippedLines: string[], start: number): number {
	const joined = strippedLines.slice(start).join("\n");
	// Locate the callback marker: `=>` or `function(` (or `function<`/function<`).
	// Use a search that ignores `=>` inside strings/templates — but since
	// stripCommentsAndStrings already blanked those, matching here is safe.
	const arrowIdx = joined.indexOf("=>");
	const funcIdx = joined.search(/\bfunction\b/);
	let markerIdx = -1;
	if (arrowIdx >= 0 && funcIdx >= 0) markerIdx = Math.min(arrowIdx, funcIdx);
	else markerIdx = arrowIdx >= 0 ? arrowIdx : funcIdx;
	if (markerIdx < 0) {
		// No callback — use legacy brace-counting from the start.
		return legacyFindBlockEnd(strippedLines, start);
	}
	// Find the first `{` at or after the marker — that's the callback body.
	const bodyOpenIdx = joined.indexOf("{", markerIdx);
	if (bodyOpenIdx < 0) return strippedLines.length - 1;

	// Walk from bodyOpenIdx balancing braces.
	let depth = 0;
	let opened = false;
	for (let p = bodyOpenIdx; p < joined.length; p++) {
		const ch = joined[p];
		if (ch === "{") {
			depth++;
			opened = true;
		} else if (ch === "}") {
			depth--;
			if (opened && depth === 0) {
				// Convert absolute char index back to line index.
				const charsBefore = joined.slice(0, p);
				return start + (charsBefore.match(/\n/g) || []).length;
			}
		}
	}
	return strippedLines.length - 1;
}

/** Fallback brace-counting for test starts that have no `=>`/`function` marker. */
function legacyFindBlockEnd(strippedLines: string[], start: number): number {
	let depth = 0;
	let opened = false;
	for (let i = start; i < strippedLines.length; i++) {
		for (const ch of strippedLines[i]) {
			if (ch === "{") {
				depth++;
				opened = true;
			} else if (ch === "}") {
				depth--;
				if (opened && depth === 0) return i;
			}
		}
	}
	return strippedLines.length - 1;
}

function push(
	matches: InlineMatch[],
	lineIdx: number,
	originalLines: string[],
	limit: number,
): void {
	if (matches.length >= limit) return;
	matches.push({ line: lineIdx + 1, text: originalLines[lineIdx].trim().slice(0, 150) });
}

// ===========================================
// 1. Assertion-Free Tests
// Uncle Bob, "Mutation Testing" (2016) + FIRST principles
// ===========================================

const ASSERT_PATTERN =
	/\b(expect|should)\s*\(|\bassert\b\s*(?:\.\s*[A-Za-z]+)?\s*\(|\.\s*(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toThrow|toThrowError|toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|toContain|toContainEqual|toHaveLength|toHaveProperty|toBeDefined|toBeUndefined|toBeNull|toBeTruthy|toBeFalsy|toBeInstanceOf|toBeGreaterThan|toBeLessThan|toBeCloseTo|toMatchSnapshot|toMatchInlineSnapshot|resolves|rejects)\b|\bchai\.|\bsinon\.assert/;
const TEST_BLOCK_START = /^\s*(it|test|should)(\.\w+)?\s*\(/;
const TEST_NO_ASSERT_SKIP = /^\s*(it|test)\s*\.\s*(todo|skip|only)/;

function isCountableTestStart(line: string): boolean {
	if (!TEST_BLOCK_START.test(line)) return false;
	return !TEST_NO_ASSERT_SKIP.test(line);
}

function isAssertionFreeBody(body: string): boolean {
	if (!body.includes("{")) return false;
	return !ASSERT_PATTERN.test(body);
}

export function checkAssertionFreeTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 10) {
		if (!isCountableTestStart(sLines[i])) {
			i++;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		const body = sLines.slice(i, end + 1).join("\n");
		if (isAssertionFreeBody(body)) push(matches, i, lines, 10);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// 2. Tautological Assertions
// ===========================================

const TAUTOLOGY_EXPECT =
	/expect\s*\(\s*([A-Za-z_$][\w$.[\]]*)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*([A-Za-z_$][\w$.[\]]*)\s*\)/g;
const TAUTOLOGY_ASSERT =
	/\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*([A-Za-z_$][\w$.[\]]*)\s*,\s*([A-Za-z_$][\w$.[\]]*)\s*\)/g;

function hasTautology(line: string): boolean {
	for (const m of line.matchAll(TAUTOLOGY_EXPECT)) {
		if (m[1] === m[2]) return true;
	}
	for (const m of line.matchAll(TAUTOLOGY_ASSERT)) {
		if (m[1] === m[2]) return true;
	}
	return false;
}

export function checkTautologicalAssertion(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		if (hasTautology(sLines[i])) push(matches, i, lines, 10);
	}
	return matches;
}

// ===========================================
// 3. Mocking the System Under Test
// Uncle Bob, "The Little Mocker" (2014)
// ===========================================

const MOCK_CALL_STATIC = /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|setMock)\s*\(\s*["']([^"']+)["']/;

function mockedPathEqualsSut(mockedPath: string, sut: string): boolean {
	const tail = mockedPath.split("/").pop() || "";
	const tailNoExt = tail.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
	return tailNoExt === sut;
}

export function checkMockingTheSUT(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const baseName = filePath.split(/[/\\]/).pop() || "";
	const sut = baseName.replace(/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
	if (!sut || sut === baseName) return [];
	const stripped = stripComments(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		const m = MOCK_CALL_STATIC.exec(sLines[i]);
		if (m && mockedPathEqualsSut(m[1], sut)) push(matches, i, lines, 5);
	}
	return matches;
}

// ===========================================
// 4. Private-Member Access from Tests
// Uncle Bob, "Test Contra-variance" (2017)
// ===========================================

const PRIVATE_TEST_ACCESS =
	/\(\s*[A-Za-z_$][\w$]*\s+as\s+any\s*\)\s*\.|\(\s*[A-Za-z_$][\w$]*\s+as\s+unknown\s+as\s+|[A-Za-z_$][\w$]*\s*\[\s*["']_{2,}[^"']*["']\s*\]|\.\s*_{2,}[A-Za-z_$][\w$]*\s*[(=.]/;

// Casts like `undefined as unknown as string` are plain type coercions — the
// result isn't used to REACH INTO private members. Flag only when the `as
// unknown as` form is followed by a member-access (`.`) or call (`(`) on
// the cast result, which is the actual "reach past public API" pattern.
const PRIVATE_ACCESS_POST = /\)\s*\.|\)\s*\[/;

export function checkPrivateMemberTestAccess(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath) || !isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		const line = sLines[i];
		const m = PRIVATE_TEST_ACCESS.exec(line);
		if (!m) continue;
		// If the match was the `as unknown as` cast form, require it to be
		// followed by `.` or `[` (accessor) to count as private-member access.
		if (m[0].includes("as unknown as")) {
			const after = line.slice((m.index ?? 0) + m[0].length);
			if (!PRIVATE_ACCESS_POST.test(after)) continue;
		}
		push(matches, i, lines, 10);
	}
	return matches;
}

// ===========================================
// 5. Loop Nesting Depth ≥3
// Uncle Bob, "Loopy" (2020)
// ===========================================

const LOOP_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".java",
	".c",
	".cpp",
	".cc",
	".cxx",
	".go",
	".rs",
]);
const LOOP_HEADER = /\b(for|while)\s*\(|\bdo\s*\{/;

interface BraceScan {
	braceDepth: number;
	enteredLoopAt: number | null;
	flagAt: number | null;
}

function scanBracesForLoop(
	line: string,
	startDepth: number,
	loopStack: number[],
	pendingLoopLine: number | null,
): BraceScan {
	let depth = startDepth;
	let enteredAt: number | null = null;
	let flagAt: number | null = null;
	for (const ch of line) {
		if (ch === "{") {
			depth++;
			if (pendingLoopLine !== null && enteredAt === null) {
				loopStack.push(depth);
				enteredAt = pendingLoopLine;
				if (loopStack.length >= 3 && flagAt === null) flagAt = pendingLoopLine;
			}
		} else if (ch === "}") {
			while (loopStack.length > 0 && loopStack[loopStack.length - 1] === depth) {
				loopStack.pop();
			}
			depth = Math.max(0, depth - 1);
		}
	}
	return { braceDepth: depth, enteredLoopAt: enteredAt, flagAt };
}

export function checkLoopNestingDepth(content: string, filePath: string): InlineMatch[] {
	if (!LOOP_EXTS.has(getExt(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const loopStack: number[] = [];
	let braceDepth = 0;
	let pendingLoopLine: number | null = null;

	for (let i = 0; i < sLines.length; i++) {
		if (LOOP_HEADER.test(sLines[i])) pendingLoopLine = i;
		const scan = scanBracesForLoop(sLines[i], braceDepth, loopStack, pendingLoopLine);
		braceDepth = scan.braceDepth;
		if (scan.enteredLoopAt !== null) pendingLoopLine = null;
		if (scan.flagAt !== null && matches.length < 5) {
			push(matches, scan.flagAt, lines, 5);
		}
	}
	return matches;
}

// ===========================================
// 6. Long `else if` Chains
// Uncle Bob, "if-else-switch" (2021)
// ===========================================

const ELSE_IF_CHAIN = /\bif\s*\([^)]*\)[^}]*\}(\s*else\s+if\s*\([^)]*\)[^}]*\}){2,}/g;

export function checkElseIfChain(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (const m of stripped.matchAll(ELSE_IF_CHAIN)) {
		if (matches.length >= 5) break;
		const offset = m.index ?? 0;
		const lineIdx = (stripped.slice(0, offset).match(/\n/g) || []).length;
		push(matches, lineIdx, lines, 5);
	}
	return matches;
}

// ===========================================
// 7. Duplicate Switch Discriminant
// Uncle Bob, "if-else-switch" (2021)
// ===========================================

const SWITCH_DISC = /\bswitch\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\)/g;
const DISC_TAIL = /\.(kind|type|tag|variant|_tag)$/;

export function checkDuplicateSwitchDiscriminant(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Map<string, number>();

	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		for (const m of sLines[i].matchAll(SWITCH_DISC)) {
			const disc = m[1];
			if (!DISC_TAIL.test(disc)) continue;
			if (seen.has(disc)) {
				push(matches, i, lines, 5);
			} else {
				seen.set(disc, i);
			}
		}
	}
	return matches;
}

// ===========================================
// 8. Hybrid Class (public fields + behavioral methods)
// Uncle Bob, "Classes vs. Data Structures" (2019)
// ===========================================

const CLASS_DECL = /\bclass\s+[A-Za-z_$][\w$]*\s*(?:extends\s+\S+\s*)?\{/;
const CLASS_ACCESSOR_OR_CTOR = /^(?:async\s+)?(constructor|get|set)\b/;
const CLASS_METHOD = /^(?:async\s+|\*\s*)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;
const CLASS_FIELD =
	/^(?:public\s+)?[A-Za-z_$][\w$]*\s*[?!]?\s*(?::\s*[^;=(]+)?\s*(?:=\s*[^;]*)?\s*;?\s*$/;
const CLASS_MEMBER_SKIP = /^(readonly|private|protected|static\s+readonly)\b/;

type MemberKind = "field" | "method" | "other";

function classifyMember(raw: string): MemberKind {
	const ln = raw.trim();
	if (!ln || CLASS_MEMBER_SKIP.test(ln) || CLASS_ACCESSOR_OR_CTOR.test(ln)) return "other";
	if (CLASS_METHOD.test(ln)) return "method";
	if (CLASS_FIELD.test(ln) && !ln.includes("(")) return "field";
	return "other";
}

function isHybrid(bodyLines: string[]): boolean {
	let hasField = false;
	let hasMethod = false;
	for (const ln of bodyLines) {
		const kind = classifyMember(ln);
		if (kind === "field") hasField = true;
		else if (kind === "method") hasMethod = true;
		if (hasField && hasMethod) return true;
	}
	return false;
}

export function checkHybridClass(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 5) {
		if (!CLASS_DECL.test(sLines[i])) {
			i++;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		if (isHybrid(sLines.slice(i + 1, end))) push(matches, i, lines, 5);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// 9. Fuzzy-Responsibility Names (low confidence)
// ===========================================

const FUZZY_NAME =
	/\b(class|interface|type)\s+([A-Z][A-Za-z0-9]*(Manager|Helper|Utils?|Service|Handler|Processor|Wrapper))\b/;

export function checkFuzzyResponsibilityName(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		if (FUZZY_NAME.test(sLines[i])) push(matches, i, lines, 5);
	}
	return matches;
}

// ===========================================
// 10. Law of Demeter (Train Wrecks)
// ===========================================

const TRAIN_WRECK = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\?\.[A-Za-z_$][\w$]*){4,}/;

export function checkLawOfDemeter(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath) || isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[i])) continue; // comment line belt-and-braces
		const m = TRAIN_WRECK.exec(sLines[i]);
		if (!m) continue;
		if (m[0].startsWith("import.meta.")) continue;
		if (sLines[i].includes("Object.prototype.")) continue;
		push(matches, i, lines, 5);
	}
	return matches;
}

// ===========================================
// 11. Flag Arguments
// Clean Code (Ch. 3)
// ===========================================

const FLAG_POSITIONAL = /\b[A-Za-z_$][\w$]*\s*\(\s*[^(),]+?\s*,\s*(true|false)\s*[),]/;
const FLAG_OBJECT =
	/\b[A-Za-z_$][\w$]*\s*\(\s*[^()]*?\{[^{}]*\b[A-Za-z_$][\w$]*\s*:\s*(?:true|false)\b[^{}]*\}/;
const FLAG_SAFE_BUILTINS =
	/\b(setAttribute|setItem|JSON\.stringify|removeEventListener|addEventListener|Array\.from|Object\.defineProperty|Reflect\.defineProperty|hasOwnProperty|localStorage|sessionStorage|Boolean|mkdir|mkdirSync|writeFile|writeFileSync|readFile|readFileSync|appendFile|appendFileSync|rm|rmSync|stat|statSync|lstat|lstatSync|access|accessSync|open|openSync|close|closeSync|chmod|chmodSync|copyFile|copyFileSync|rename|renameSync|unlink|unlinkSync|readdir|readdirSync|realpath|realpathSync|utimes|utimesSync|symlink|symlinkSync|spawn|spawnSync|exec|execSync|execFile|execFileSync|Reflect\.get|Reflect\.set)\s*\(/;

export function checkFlagArgument(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath) || isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 8; i++) {
		const line = sLines[i];
		if (/^\s*(return|const|let|var)\s+/.test(line)) continue;
		if (FLAG_SAFE_BUILTINS.test(line)) continue;
		if (FLAG_POSITIONAL.test(line) || FLAG_OBJECT.test(line)) push(matches, i, lines, 8);
	}
	return matches;
}

// ===========================================
// 12. Commented-Out Code
// Clean Code (Ch. 4)
// ===========================================

// Strong code-like signals only — raw punctuation (()=,) false-positives on
// prose comments that describe parameters or list items. Require:
//   - assignment `=` (not comparison `==`)
//   - arrow `=>`
//   - line ending with `{`, `}`, or `;`
//   - keyword-with-shape: `return X`, `if (`, `for (`, `while (`, `const X =`,
//     `let X =`, `var X =`, `function X(`, or a call-with-args like `foo(a,`
const CODE_SHAPED =
	/(?:=(?!=)|=>|[{};]\s*$|\breturn\s+\S|\b(?:if|for|while)\s*\(|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|\bfunction\s+[A-Za-z_$][\w$]*\s*\(|[A-Za-z_$][\w$]*\s*\([^)]*,)/;
const COMMENT_LINE = /^\s*(?:\/\/|#)\s*(.+)$/;
/** Signals that a comment is prose describing behavior rather than
 *  commented-out code. Must be either:
 *    - a JSDoc/prose keyword followed by colon (`Match:`, `Returns:`, `E.g.`)
 *    - an em-dash or double-hyphen separator
 *    - English connectives like " or ", " and ", " but ", " when "
 *  These are never-legitimate-as-code signals. Plain keywords like `return`
 *  or `Throws` without punctuation are NOT here — they're valid code
 *  tokens. */
const PROSE_MARKER =
	/\b(?:Match|Skip|Note|Example|E\.g|e\.g|i\.e|TODO|FIXME|NOTE|XXX|WARNING|See|Args?|Params?|Returns|Throws):|\sE\.g\.,|\si\.e\.,|\s—\s|\s--\s|\s(?:or|and|but|when|whether)\s|\sif it\b|\bthat (?:[a-z])| with \b| without \b| which \b| where \b/i;
const COMMENTED_CODE_EXTS = new Set([
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
]);

function looksLikeBannerLine(body: string): boolean {
	const trimmed = body.trim();
	if (trimmed.length < 3) return false;
	const firstChar = trimmed[0];
	if (!"=-*#_~".includes(firstChar)) return false;
	let same = 0;
	for (const c of trimmed) if (c === firstChar) same++;
	return same / trimmed.length >= 0.8;
}

function looksLikeCommentedCode(line: string): boolean {
	const m = COMMENT_LINE.exec(line);
	if (!m) return false;
	const body = m[1];
	if (/^\s*[A-Z]{2,}:/.test(body)) return false;
	if (/^\s*\*/.test(body)) return false;
	if (looksLikeBannerLine(body)) return false;
	// Prose markers (em-dash, "or"/"and"/"when"/etc., "Match:", "E.g.") →
	// this is explanatory comment, not commented-out code. Skip.
	if (PROSE_MARKER.test(body)) return false;
	return CODE_SHAPED.test(body);
}

export function checkCommentedOutCode(content: string, filePath: string): InlineMatch[] {
	if (!COMMENTED_CODE_EXTS.has(getExt(filePath))) return [];
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let runStart = -1;
	let runLen = 0;
	for (let i = 0; i < lines.length; i++) {
		if (looksLikeCommentedCode(lines[i])) {
			if (runStart === -1) runStart = i;
			runLen++;
			continue;
		}
		if (runLen >= 3 && runStart !== -1) push(matches, runStart, lines, 5);
		runStart = -1;
		runLen = 0;
	}
	if (runLen >= 3 && runStart !== -1) push(matches, runStart, lines, 5);
	return matches;
}

// ===========================================
// 13. Conditional Logic in Test Bodies
// Tests should have straight-line logic. if/switch/try in a test body usually
// means the test is trying to cover two cases at once.
// ===========================================

const CONTROL_FLOW_IN_TEST = /\b(if|switch|try)\s*[({]/;

/**
 * Look for branching control flow at the TOP LEVEL of a test body only.
 *
 * Depth tracking: the `it(...)` start line opens `(...)` + `{`. We want to
 * match `if`/`switch`/`try` that appears directly in the test body (one
 * `{` level deep — the function body), not inside for-loops, nested
 * functions, mock callbacks, or helper closures which are legitimate.
 *
 * A "collect-and-assert" test — `for (x of xs) if (pred(x)) push(x); expect(pushed)...` —
 * is a valid parametric-assertion pattern and must not be flagged. The
 * `if` is inside a `for` body (depth 2+), so depth filtering handles it.
 */
function findControlFlowInBody(sLines: string[], start: number, end: number): number | null {
	// Depth counter starts from 0 (before the test opens its block). Scan
	// from the first body line onward, tracking `{`/`}` to know whether we
	// are at the test's direct body level.
	let depth = 0;
	let seenOpen = false;
	for (let j = start; j <= end; j++) {
		const line = sLines[j];
		// Check for a top-level conditional BEFORE counting braces on this
		// line — the conditional typically precedes its opening `{`.
		if (seenOpen && depth === 1 && j > start && CONTROL_FLOW_IN_TEST.test(line)) {
			return j;
		}
		for (const ch of line) {
			if (ch === "{") {
				depth++;
				seenOpen = true;
			} else if (ch === "}") {
				depth--;
			}
		}
	}
	return null;
}

export function checkConditionalInTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 10) {
		if (!isCountableTestStart(sLines[i])) {
			i++;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		const hit = findControlFlowInBody(sLines, i, end);
		if (hit !== null) push(matches, hit, lines, 10);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// 14. Non-Deterministic Values in Tests
// Date.now(), new Date(), Math.random() inside a test without fake timers → flaky.
// ===========================================

const NON_DETERMINISTIC = /\b(Date\.now|Math\.random|performance\.now)\s*\(|\bnew\s+Date\s*\(\s*\)/;
const FAKE_TIMER_SETUP = /\b(useFakeTimers|setSystemTime|installMockDate|mockDate)\b/;
/** Marker in a file to opt out: `// @perf` or `// @allow-non-deterministic`
 *  on any line of the file exempts it from this check. Lets benchmark and
 *  timing-characterization tests legitimately use `Date.now()`/`performance.now()`
 *  without fake timers. */
const PERF_MARKER = /@(?:perf|allow-non-deterministic)\b/i;

export function checkNonDeterministicTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	// File-level opt-out via `@perf` / `@allow-non-deterministic` marker
	// comment — inspects the raw (pre-strip) content since the marker lives
	// inside a comment which gets blanked by stripComments.
	if (PERF_MARKER.test(content)) return [];
	const stripped = stripCommentsAndStrings(content);
	if (FAKE_TIMER_SETUP.test(stripped)) return [];
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		if (NON_DETERMINISTIC.test(sLines[i])) push(matches, i, lines, 10);
	}
	return matches;
}

// ===========================================
// 15. Empty Catch Blocks
// An empty-body catch (no statements) swallows errors silently.
// Always handle or rethrow.
// ===========================================

// Matches catch-with-body where body contains no nested braces.
// Matching runs on content with string/template/regex literals blanked so
// the check doesn't fire on catch-shaped text inside a string (e.g. the
// hook-script template in hooks.ts) or inside a regex literal (e.g. this
// check's own source).
const EMPTY_CATCH_CANDIDATE = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;
// Rationale markers that excuse an empty catch. Kept deliberately narrow —
// generic keywords like "skip", "ignore", "fallback", "expected" are too
// common to force the author to explain *why* the error is safe to drop.
// Only accept phrases that assert deliberation or harmlessness: "intentional",
// "best-effort", "cleanup is/only", "non-critical", "non-fatal".
const INTENTIONAL_MARKER =
	/\b(?:intentional|best[-\s]?effort|cleanup\s+(?:is|only)|non[-\s]?(?:critical|fatal))\b/i;

export function checkEmptyCatch(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const lines = content.split("\n");
	// scan: strings/templates/regex/comments blanked so catch-shaped text inside
	// any of those doesn't fire. stripAllLiterals runs the four strippers in
	// the order that tolerates backticks inside regex literals elsewhere in
	// the file (regex-first → templates won't be confused; comments run on
	// content with strings/regex/templates already blanked).
	const scan = stripAllLiterals(content);
	const matches: InlineMatch[] = [];
	for (const m of scan.matchAll(EMPTY_CATCH_CANDIDATE)) {
		if (matches.length >= 10) break;
		// The candidate regex matches any body without nested braces. Only
		// flag when the scan-side body is whitespace-only (comments/strings/
		// regex all stripped above). Real statements leave non-whitespace
		// tokens in the scan content.
		if (m[1].trim().length > 0) continue;
		// Then check the ORIGINAL body text for an intentional-marker comment
		// and skip if the developer explicitly documented the empty catch.
		const offset = m.index ?? 0;
		const origSlice = content.slice(offset, offset + m[0].length);
		const origBody = origSlice.match(/\{([\s\S]*)\}/)?.[1] ?? "";
		if (INTENTIONAL_MARKER.test(origBody)) continue;
		const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;
		push(matches, lineIdx, lines, 10);
	}
	return matches;
}

// ===========================================
// 16. Test Without Description
// `it("", ...)` or `it(() => ...)` — either empty or missing first-arg description.
// ===========================================

const TEST_EMPTY_DESC = /\b(it|test)\s*\(\s*(?:["']\s*["']|`\s*`)\s*,/;
const TEST_FN_FIRST = /\b(it|test)\s*\(\s*(?:async\s+)?(?:function\b|\()/;

export function checkTestWithoutDescription(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripComments(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		const line = sLines[i];
		if (TEST_EMPTY_DESC.test(line) || TEST_FN_FIRST.test(line)) {
			push(matches, i, lines, 10);
		}
	}
	return matches;
}

// ===========================================
// 17. Assertion Roulette
// A single `it()` with 8+ expect() calls — when one fails, which?
// ===========================================

const ASSERTION_ROULETTE_THRESHOLD = 8;

export function checkAssertionRoulette(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 5) {
		if (!isCountableTestStart(sLines[i])) {
			i++;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		const body = sLines.slice(i, end + 1).join("\n");
		const expectCount = (body.match(/\bexpect\s*\(/g) || []).length;
		if (expectCount >= ASSERTION_ROULETTE_THRESHOLD) push(matches, i, lines, 5);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// 18. Magic Numbers
// Number literals (≥4 digits) inside function calls, outside const declarations.
// E.g., `setTimeout(fn, 5000)` — the `5000` should be a named constant.
// ===========================================

const DECLARATION_LINE = /^\s*(?:export\s+)?(?:const|let|var|readonly|static|enum)\b/;
const MAGIC_IN_CALL = /\b[A-Za-z_$][\w$]*\s*\([^()]*?\b\d{4,}\b[^()]*?\)/;

// JSDoc continuation lines (` * ...`) and plain `// ...` comments look like
// code after some stripper corruption. These patterns are a belt-and-braces
// check on the ORIGINAL line: if the raw text starts with a comment marker,
// the match is a false positive from a prior stripper state-tracking bug.
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\*|\/\*)/;

export function checkMagicNumber(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath) || isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		const line = sLines[i];
		if (DECLARATION_LINE.test(line)) continue;
		if (COMMENT_LINE_PATTERN.test(lines[i])) continue;
		if (MAGIC_IN_CALL.test(line)) push(matches, i, lines, 10);
	}
	return matches;
}

// ===========================================
// Helpers for arg-list analysis
// ===========================================

const OPENS = "({[<";
const CLOSES = ")}]>";

function splitTopLevelCommas(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let buf = "";
	for (const ch of s) {
		if (OPENS.includes(ch)) depth++;
		else if (CLOSES.includes(ch)) depth--;
		if (ch === "," && depth === 0) {
			out.push(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	if (buf.trim()) out.push(buf);
	return out;
}

function argCount(argsInner: string): number {
	return splitTopLevelCommas(argsInner).length;
}

function lineIdxForOffset(stripped: string, offset: number): number {
	return (stripped.slice(0, offset).match(/\n/g) || []).length;
}

// ===========================================
// 19. Function Argument Count
// Clean Code: keep argument count low (0–2 ideal, 3 max, 4+ warrants refactor).
// Single destructured object counts as 1.
// ===========================================

const FUNC_DECL = /\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
const ARROW_DECL = /=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=(){}]+)?\s*=>/g;
const METHOD_DECL =
	/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\s*\{/gm;

const ARG_COUNT_THRESHOLD = 3;

function flagOversizedArgList(
	stripped: string,
	pattern: RegExp,
	lines: string[],
	matches: InlineMatch[],
	limit: number,
): void {
	for (const m of stripped.matchAll(pattern)) {
		if (matches.length >= limit) return;
		if (argCount(m[1]) > ARG_COUNT_THRESHOLD) {
			push(matches, lineIdxForOffset(stripped, m.index ?? 0), lines, limit);
		}
	}
}

export function checkFunctionArgCount(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	flagOversizedArgList(stripped, FUNC_DECL, lines, matches, 10);
	flagOversizedArgList(stripped, ARROW_DECL, lines, matches, 10);
	flagOversizedArgList(stripped, METHOD_DECL, lines, matches, 10);
	return matches;
}

// ===========================================
// 20. Data Clump
// 3+ consecutive parameters of the same primitive type (string/number/boolean)
// signal a candidate for extraction into an object/struct.
// ===========================================

const PRIMITIVES = new Set(["string", "number", "boolean", "bigint"]);
const DATA_CLUMP_RUN = 3;

function paramType(part: string): string {
	const colon = part.indexOf(":");
	if (colon === -1) return "";
	const typePart = part.slice(colon + 1).trim();
	const firstToken = typePart.split(/[\s|&=]/)[0];
	return firstToken;
}

function hasDataClump(argsInner: string): boolean {
	const parts = splitTopLevelCommas(argsInner);
	let run = 0;
	let runType = "";
	for (const p of parts) {
		const t = paramType(p);
		if (!PRIMITIVES.has(t)) {
			run = 0;
			runType = "";
			continue;
		}
		if (t === runType) {
			run++;
			if (run >= DATA_CLUMP_RUN) return true;
		} else {
			run = 1;
			runType = t;
		}
	}
	return false;
}

function flagDataClump(
	stripped: string,
	pattern: RegExp,
	lines: string[],
	matches: InlineMatch[],
	limit: number,
): void {
	for (const m of stripped.matchAll(pattern)) {
		if (matches.length >= limit) return;
		if (hasDataClump(m[1])) {
			push(matches, lineIdxForOffset(stripped, m.index ?? 0), lines, limit);
		}
	}
}

export function checkDataClump(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	flagDataClump(stripped, FUNC_DECL, lines, matches, 10);
	flagDataClump(stripped, ARROW_DECL, lines, matches, 10);
	flagDataClump(stripped, METHOD_DECL, lines, matches, 10);
	return matches;
}

// ===========================================
// 21. Duplicate Describe
// Same `describe("x", ...)` string appears 2+ times in one file.
// ===========================================

const DESCRIBE_NAME = /\bdescribe\s*\(\s*["']([^"']+)["']/g;

export function checkDuplicateDescribe(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const stripped = stripComments(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<string>();
	for (const m of stripped.matchAll(DESCRIBE_NAME)) {
		if (matches.length >= 5) break;
		const name = m[1];
		if (seen.has(name)) {
			push(matches, lineIdxForOffset(stripped, m.index ?? 0), lines, 5);
		} else {
			seen.add(name);
		}
	}
	return matches;
}
