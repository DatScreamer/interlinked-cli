// ===========================================
// Taste Checks — test-assertion family
// ===========================================
// Extracted from taste-checks.ts (verbatim) to keep the barrel under the
// per-file line cap. These four detectors all target test-hygiene smells
// sourced from Robert C. Martin's essays. Shared helpers live in
// ./taste-checks-shared.js; this module re-exports through taste-checks.ts so
// existing importers keep importing from "../taste-checks.js" unchanged.

import { stripComments } from "./strip-helpers.js";
import {
	findBlockEnd,
	type InlineMatch,
	isCountableTestStart,
	isJsTs,
	isTestFile,
	push,
	stripCommentsAndStrings,
} from "./taste-checks-shared.js";

// ===========================================
// 1. Assertion-Free Tests
// Uncle Bob, "Mutation Testing" (2016) + FIRST principles
// ===========================================

const ASSERT_PATTERN =
	/\b(expect|should)\s*\(|\bassert\b\s*(?:\.\s*[A-Za-z]+)?\s*\(|\.\s*(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toThrow|toThrowError|toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|toContain|toContainEqual|toHaveLength|toHaveProperty|toBeDefined|toBeUndefined|toBeNull|toBeTruthy|toBeFalsy|toBeInstanceOf|toBeGreaterThan|toBeLessThan|toBeCloseTo|toMatchSnapshot|toMatchInlineSnapshot|resolves|rejects)\b|\bchai\.|\bsinon\.assert/;

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
