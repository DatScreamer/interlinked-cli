// Mutation-kill campaign for src/harness/taste-checks-test-assertions.ts
// (fleet-r3, W5). The pre-existing companion file only exercises
// checkAssertionFreeTest; this file adds real coverage for the other three
// exported detectors (checkTautologicalAssertion, checkMockingTheSUT,
// checkPrivateMemberTestAccess) plus targeted boundary cases the existing
// file didn't reach — the fixtures here are 1:1 with
// scratch/fleet-r3/src_harness_taste-checks-test-assertions.ts-shadow-verify.mts,
// which shadow-verified 176/183 survivors killed and the remaining 7
// zero-divergence across a >=300-input fuzz pass
// (scratch/fleet-r3/src_harness_taste-checks-test-assertions.ts-equivalence-fuzz.mts).
//
// P<n>/N<n> prefixes: P = the detector fires (returns a non-empty finding
// list); N = the detector stays silent (empty list) — matching the Check
// Evidence Contract's labeling convention.
import { describe, expect, it } from "vitest";
import {
	checkAssertionFreeTest,
	checkMockingTheSUT,
	checkPrivateMemberTestAccess,
	checkTautologicalAssertion,
} from "../taste-checks-test-assertions.js";

const TEST = "/x/widget.test.ts";

describe("checkAssertionFreeTest — ASSERT_PATTERN recognizes every assertion style", () => {
	it("N1: zero-spaced expect( is recognized as an assertion", () => {
		expect(checkAssertionFreeTest(`it("x", () => { expect(x).toBeTruthy(); });`, TEST)).toEqual([]);
	});
	it("N2: expect with a space before the paren is still recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { expect (x).toBeTruthy(); });`, TEST)).toEqual([]);
	});
	it("N3: should( with no space is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { should(x).exist; });`, TEST)).toEqual([]);
	});
	it("N4: should with a space before the paren is still recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { should (x).exist; });`, TEST)).toEqual([]);
	});
	it("N5: bare assert( is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { assert(x); });`, TEST)).toEqual([]);
	});
	it("N6: assert with a space before the paren is still recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { assert (x); });`, TEST)).toEqual([]);
	});
	it("N7: assert.equal with no spaces is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { assert.equal(a, b); });`, TEST)).toEqual([]);
	});
	it("N8: assert . equal with spaces throughout is still recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { assert . equal (a, b); });`, TEST)).toEqual([]);
	});
	it("N9: assert.ok (single-letter method) is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { assert.ok(x); });`, TEST)).toEqual([]);
	});
	it("N10: .toBe( with no space is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { void (x).toBe(y); });`, TEST)).toEqual([]);
	});
	it("N11: .toBe with a space before the paren is still recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { void (x).toBe (y); });`, TEST)).toEqual([]);
	});
	it("N12: .toBe with a space right after the dot is still recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { void (x). toBe(y); });`, TEST)).toEqual([]);
	});
	it("N13: chai. namespace access is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { chai.expect(x).to.equal(y); });`, TEST)).toEqual([]);
	});
	it("N14: sinon.assert namespace access is recognized", () => {
		expect(checkAssertionFreeTest(`it("x", () => { sinon.assert.called(x); });`, TEST)).toEqual([]);
	});
	it("P1: a body with braces but no recognized assertion token is flagged", () => {
		expect(checkAssertionFreeTest(`it("computes", () => { const x = compute(); });`, TEST).length).toBe(1);
	});
});

describe("checkAssertionFreeTest — SMOKE_TEST_NAME_RE exemption phrasings", () => {
	it("N1: bare 'without crash' (no ing/es suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without crash", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N2: 'without crashing' (ing suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without crashing", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N3: 'without crashes' (es suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without crashes", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N4: bare 'without error' (no s suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without error", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N5: 'without errors' (s suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without errors", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N6: bare 'without throw' (no ing suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without throw", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N7: 'without throwing' (ing suffix) is exempt", () => {
		expect(checkAssertionFreeTest(`it("without throwing", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N8: 'without incident' is exempt", () => {
		expect(checkAssertionFreeTest(`it("without incident", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N9: 'doesnt throw' (no apostrophe) is exempt", () => {
		expect(checkAssertionFreeTest(`it("doesnt throw", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N10: \"does not throw\" is exempt", () => {
		expect(checkAssertionFreeTest(`it("does not throw", () => { setup(); });`, TEST)).toEqual([]);
	});
	// P11-P13, not N: a REAL apostrophe in a double-quoted name currently
	// defeats testCaseName's own quote-capture regex — `([^"'`]*)` excludes
	// ALL THREE quote characters (not just the opening delimiter "), so it
	// stops at the apostrophe inside "doesn't" and the backreference \1 then
	// fails to find a closing " right there. testCaseName falls back to "",
	// SMOKE_TEST_NAME_RE.test("") is false, and the case is (wrongly) NOT
	// exempted — the n'?t contraction branch of SMOKE_TEST_NAME_RE is
	// unreachable dead code for any double-quoted name in practice. This is
	// a genuine pre-existing bug (confirmed: single-quoted + escaped
	// apostrophe is ALSO broken, capturing garbage that stops at the escape
	// backslash) — flagged in the fleet report, not fixed here: no assigned
	// survivor in this campaign depends on it (the n'?t OPTIONALITY mutant
	// is killed by the apostrophe-FREE "doesnt throw" case above instead).
	it("P11: \"doesn't crash\" is NOT exempt today (apostrophe defeats name extraction — bug, see comment)", () => {
		expect(checkAssertionFreeTest(`it("doesn't crash", () => { setup(); });`, TEST).length).toBe(1);
	});
	it("P12: \"doesn't reject\" is NOT exempt today (same extraction bug)", () => {
		expect(checkAssertionFreeTest(`it("doesn't reject", () => { setup(); });`, TEST).length).toBe(1);
	});
	it("P13: \"doesn't error\" is NOT exempt today (same extraction bug)", () => {
		expect(checkAssertionFreeTest(`it("doesn't error", () => { setup(); });`, TEST).length).toBe(1);
	});
	it("N14: 'no-throw' (hyphen) is exempt", () => {
		expect(checkAssertionFreeTest(`it("a no-throw case", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N15: 'nothrow' (no separator) is exempt", () => {
		expect(checkAssertionFreeTest(`it("a nothrow case", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N16: 'no throw' (space) is exempt", () => {
		expect(checkAssertionFreeTest(`it("a no throw case", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("P1: a name with none of these phrasings is NOT exempt", () => {
		expect(checkAssertionFreeTest(`it("renders the count", () => { render(x); });`, TEST).length).toBe(1);
	});
	it("N17: double-spaced 'without  crash' is still exempt (a whitespace RUN, not exactly one)", () => {
		expect(checkAssertionFreeTest(`it("without  crash", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N18: double-spaced 'does  not throw' is still exempt", () => {
		expect(checkAssertionFreeTest(`it("does  not throw", () => { setup(); });`, TEST)).toEqual([]);
	});
	it("N19: double-spaced 'does not  throw' is still exempt", () => {
		expect(checkAssertionFreeTest(`it("does not  throw", () => { setup(); });`, TEST)).toEqual([]);
	});
});

describe("checkAssertionFreeTest — guard clauses and internal boundaries", () => {
	it("N1: a non-test filePath returns nothing even for an assertion-free body", () => {
		expect(
			checkAssertionFreeTest(`it("computes", () => { const x = compute(); });`, "/x/notatest.ts"),
		).toEqual([]);
	});
	it("N2: a non-test-start line before a real asserted test is never scanned itself", () => {
		const content = [
			"const helper = () => { doStuff(); };",
			'it("real test", () => { expect(x).toBe(y); });',
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
	it("P1: an earlier assertion-free test is flagged on its own body, not borrowing a later test's assertion", () => {
		const content = [
			'it("case one", () => { doStuff(); });',
			'it("case two", () => { expect(y).toBe(z); });',
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});
	it("N3: a braceless single-expression test body is never flagged (no brace to analyze)", () => {
		expect(checkAssertionFreeTest(`it("adds", () => 1 + 1);`, TEST)).toEqual([]);
	});
	it("N4: a bare assert() with no leading indentation is still recognized once the body is rebuilt with real newlines between source lines", () => {
		// Regression for mutantId b840d8c6cbca8377 (StringLiteral "\n" -> ""
		// on `sLines.slice(i, end + 1).join("\n")`): that join rebuilds the
		// finding body from separate SOURCE lines. `\bassert\b` needs a word
		// boundary right before "assert" — a real "\n" supplies one even
		// with zero leading indentation on the assert line; `join("")`
		// would glue the previous line's trailing word character (the "1"
		// in "= 1") directly onto "assert" and destroy that boundary, so a
		// genuinely-asserted test would be misreported as assertion-free.
		// Deliberately a BARE assert(...) call (no chained .toBe/.toEqual)
		// so ASSERT_PATTERN's other, boundary-free alternatives can't mask
		// the mutation by matching regardless.
		const content = [
			'it("glued lines drop the word boundary before a bare assert call", () => {',
			"\tconst value = 1",
			"assert(value === 1)",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
});

describe("checkAssertionFreeTest — testCaseName header-window and modifier-chain parsing", () => {
	it("N1: a smoke name on line 7 (within the 8-line header window) is still read as exempt", () => {
		const content = [
			"it(",
			"",
			"",
			"",
			"",
			"",
			'\t"smoke test",',
			"\t() => {",
			"\t\tsetup();",
			"\t},",
			");",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
	it("P1: a smoke name past the header window is NOT read, so the case is flagged", () => {
		const content = [
			"it(",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			'\t"smoke test",',
			"\t() => {",
			"\t\tsetup();",
			"\t},",
			");",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});
	it("N2: a modifier chain (.concurrent) with a next-line smoke name is still exempt", () => {
		// NOT .skip( — isCountableTestStart's own TEST_NO_ASSERT_SKIP excludes
		// .skip/.todo/.only entirely, so a .skip fixture never reaches
		// testCaseName and can't exercise its modifier-chain regex.
		const content = ["it.concurrent(", '\t"smoke test",', "\t() => {", "\t\tsetup();", "\t},", ");"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
	it("P2: a short var-named test must not borrow a LATER test's quoted smoke name", () => {
		const content = [
			"it(caseName, () => { doStuff(); });",
			'it("smoke test", () => { setup(); });',
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});
	it("N3: a modifier chain with a space before the final paren still reads a next-line smoke name", () => {
		const content = ["it.concurrent (", '\t"smoke test",', "\t() => {", "\t\tsetup();", "\t},", ");"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
});

describe("checkTautologicalAssertion — TAUTOLOGY_EXPECT / TAUTOLOGY_ASSERT", () => {
	it("P1: zero-spaced expect(x).toBe(x) is tautological", () => {
		expect(checkTautologicalAssertion(`it("t", () => { expect(matched).toBe(matched); });`, TEST).length).toBe(
			1,
		);
	});
	it("P2: fully-spaced expect ( x ) . toBe ( x ) is still tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { expect ( matched ) . toBe ( matched ) ; });`, TEST)
				.length,
		).toBe(1);
	});
	it("N1: expect(a).toBe(b) with different operands is not tautological", () => {
		expect(checkTautologicalAssertion(`it("t", () => { expect(alpha).toBe(bravo); });`, TEST)).toEqual([]);
	});
	it("P3: the toEqual variant is also tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { expect(matched).toEqual(matched); });`, TEST).length,
		).toBe(1);
	});
	it("P4: the toStrictEqual variant is also tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { expect(matched).toStrictEqual(matched); });`, TEST)
				.length,
		).toBe(1);
	});
	it("P5: zero-spaced assert.equal(x,x) (no space anywhere, including after the comma) is tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { assert.equal(matched,matched); });`, TEST).length,
		).toBe(1);
	});
	it("P6: fully-spaced assert . equal ( x , x ) is still tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { assert . equal ( matched , matched ) ; });`, TEST)
				.length,
		).toBe(1);
	});
	it("N2: assert.equal(a, b) with different operands is not tautological", () => {
		expect(checkTautologicalAssertion(`it("t", () => { assert.equal(alpha, bravo); });`, TEST)).toEqual([]);
	});
	it("P7: the assert.strictEqual variant is also tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { assert.strictEqual(matched, matched); });`, TEST).length,
		).toBe(1);
	});
	it("P8: the assert.deepEqual variant is also tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { assert.deepEqual(matched, matched); });`, TEST).length,
		).toBe(1);
	});
	it("P9: the assert.deepStrictEqual variant is also tautological", () => {
		expect(
			checkTautologicalAssertion(`it("t", () => { assert.deepStrictEqual(matched, matched); });`, TEST)
				.length,
		).toBe(1);
	});
	it("P10: dotted property-path operands that are equal are still tautological", () => {
		expect(checkTautologicalAssertion(`it("t", () => { expect(a.b.c).toBe(a.b.c); });`, TEST).length).toBe(
			1,
		);
	});
	it.each([
		["number", "42"],
		["string", '"ready"'],
		["boolean", "true"],
	])("P11: identical %s literals in expect(...).toBe(...) are tautological", (_kind, literal) => {
		expect(checkTautologicalAssertion(`it("t", () => { expect(${literal}).toBe(${literal}); });`, TEST)).toHaveLength(1);
	});
	it.each([
		"expect(true).toBeTruthy();",
		"expect(false).toBeFalsy();",
		"assert(true);",
		"assert.ok(true);",
	])("P12: trivially true assertion is tautological: %s", (assertion) => {
		expect(checkTautologicalAssertion(`it("t", () => { ${assertion} });`, TEST)).toHaveLength(1);
	});
	it.each([
		"expect(42).toBe(43);",
		"expect(\"ready\").toBe(\"done\");",
		"expect(true).toBe(false);",
		"expect(true).toBeFalsy();",
		"expect(false).toBeTruthy();",
		"assert(false);",
		"assert.ok(false);",
	])("N3: adjacent non-tautological literal assertion stays clean: %s", (assertion) => {
		expect(checkTautologicalAssertion(`it("t", () => { ${assertion} });`, TEST)).toEqual([]);
	});
	it("N4: assertion-shaped text in strings, template fixtures, and comments stays clean", () => {
		const content = [
			'it("t", () => {',
			'\tconst source = \'expect(true).toBeTruthy()\';',
			'\tconst fixture = `expect("x").toBe("x")`;',
			'\t// assert(true)',
			"});",
		].join("\n");
		expect(checkTautologicalAssertion(content, TEST)).toEqual([]);
	});
	it("P13: a real assertion is flagged alongside assertion-shaped fixture text", () => {
		const content = [
			'it("t", () => {',
			'\tconst source = \'expect(true).toBeTruthy()\';',
			'\tconst fixture = `expect("x").toBe("x")`;',
			'\t// assert(true)',
			"\tassert(true);",
			"});",
		].join("\n");
		expect(checkTautologicalAssertion(content, TEST)).toHaveLength(1);
	});
});

describe("checkMockingTheSUT — MOCK_CALL_STATIC", () => {
	it("P1: zero-spaced vi.mock of the same-dir SUT flags", () => {
		expect(checkMockingTheSUT(`vi.mock("./widget");`, TEST).length).toBe(1);
	});
	it("P2: fully-spaced vi . mock ( of the same-dir SUT flags", () => {
		expect(checkMockingTheSUT(`vi . mock ( "./widget" ) ;`, TEST).length).toBe(1);
	});
	it("P3: jest.mock of the same-dir SUT flags", () => {
		expect(checkMockingTheSUT(`jest.mock("./widget");`, TEST).length).toBe(1);
	});
	it("P4: vi.doMock of the same-dir SUT flags", () => {
		expect(checkMockingTheSUT(`vi.doMock("./widget");`, TEST).length).toBe(1);
	});
	it("P5: vi.setMock of the same-dir SUT flags", () => {
		expect(checkMockingTheSUT(`vi.setMock("./widget");`, TEST).length).toBe(1);
	});
	it("N1: mocking an unrelated module does not flag", () => {
		expect(checkMockingTheSUT(`vi.mock("./unrelated");`, TEST)).toEqual([]);
	});
	it("P6: a single-quoted mock path of the same-dir SUT flags", () => {
		expect(checkMockingTheSUT(`vi.mock('./widget');`, TEST).length).toBe(1);
	});
});

describe("checkPrivateMemberTestAccess — CAST_ANY_ACCESS / HOST_GLOBALS / MOCK_API_AFTER", () => {
	it("P1: zero-spaced (svc as any).privateThing() is a violation", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { (svc as any).privateThing(); });`, TEST).length).toBe(
			1,
		);
	});
	it("P2: fully-spaced ( svc as any ) . privateThing ( ) is still a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { ( svc as any ) . privateThing ( ) ; });`, TEST).length,
		).toBe(1);
	});
	it("P3: double-spaced (svc  as  any) around both gaps is still a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (svc  as  any).privateThing(); });`, TEST).length,
		).toBe(1);
	});
	it("N1: (globalThis as any).fetch is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { (globalThis as any).fetch = stub; });`, TEST)).toEqual(
			[],
		);
	});
	it("N2: (window as any).x is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { (window as any).x = 1; });`, TEST)).toEqual([]);
	});
	it("N3: (global as any).x is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { (global as any).x = 1; });`, TEST)).toEqual([]);
	});
	it("N4: (self as any).x is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { (self as any).x = 1; });`, TEST)).toEqual([]);
	});
	it("N5: (process as any).env is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { void (process as any).env; });`, TEST)).toEqual([]);
	});
	it("N6: (console as any).log is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { (console as any).log(1); });`, TEST)).toEqual([]);
	});
	it("N7: (document as any).body is exempt (host global)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { void (document as any).body; });`, TEST)).toEqual(
			[],
		);
	});
	it("N8: (navigator as any).userAgent is exempt (host global)", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { void (navigator as any).userAgent; });`, TEST),
		).toEqual([]);
	});
	it("N9: (fetchMock as any).mock.calls introspection is exempt (mock API)", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { void (fetchMock as any).mock.calls[0][0]; });`, TEST),
		).toEqual([]);
	});
	it("N10: (fetchMock as any).mockReturnValue(1) (bare, no Once) is exempt", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (fetchMock as any).mockReturnValue(1); });`, TEST),
		).toEqual([]);
	});
	it("N11: (fetchMock as any).mockImplementation(fn) (bare, no Once) is exempt", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (fetchMock as any).mockImplementation(fn); });`, TEST),
		).toEqual([]);
	});
	it("N12: (fetchMock as any).mockResolvedValue(1) (bare, no Once) is exempt", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (fetchMock as any).mockResolvedValue(1); });`, TEST),
		).toEqual([]);
	});
	it("N13: (fetchMock as any).mockRejectedValue(err) (bare, no Once) is exempt", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (fetchMock as any).mockRejectedValue(err); });`, TEST),
		).toEqual([]);
	});
	it("P4: (svc as any).internals.mockClear() — a non-mock property before the real accessor must still violate", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (svc as any).internals.mockClear(); });`, TEST).length,
		).toBe(1);
	});
});

describe("checkPrivateMemberTestAccess — CAST_UNKNOWN_START / CAST_UNKNOWN_ACCESSOR", () => {
	it("P1: zero-spaced (svc as unknown as Thing).privateThing() is a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { (svc as unknown as Thing).privateThing(); });`, TEST)
				.length,
		).toBe(1);
	});
	it("P2: fully-spaced ( svc as unknown as Thing ) . privateThing ( ) is still a violation", () => {
		expect(
			checkPrivateMemberTestAccess(
				`it("t", () => { ( svc as unknown as Thing ) . privateThing ( ) ; });`,
				TEST,
			).length,
		).toBe(1);
	});
	it("P3: double-spaced (svc  as  unknown  as  Thing) around every gap is still a violation", () => {
		expect(
			checkPrivateMemberTestAccess(
				`it("t", () => { (svc  as  unknown  as  Thing).privateThing(); });`,
				TEST,
			).length,
		).toBe(1);
	});
	it("N1: (x as unknown as string) with NO accessor after is a plain coercion, not a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { const y = (x as unknown as string); });`, TEST),
		).toEqual([]);
	});
	it("P4: (x as unknown as Thing)[key] bracket accessor is a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { void (x as unknown as Thing)[key]; });`, TEST).length,
		).toBe(1);
	});
});

describe("checkPrivateMemberTestAccess — DUNDER_MEMBER / RUNTIME_DUNDERS", () => {
	it("P1: zero-spaced .__privateThing() dunder call is a violation", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { svc.__privateThing(); });`, TEST).length).toBe(1);
	});
	it("P2: fully-spaced . __privateThing ( ) dunder call is still a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { svc . __privateThing ( ) ; });`, TEST).length,
		).toBe(1);
	});
	it("N1: .__proto__.x runtime dunder (dot-chained) is exempt", () => {
		// DUNDER_MEMBER requires a trailing ( = or . right after the dunder name
		// (\s*[(=.]) — a bare `.__proto__;` never even matches DUNDER_MEMBER, so
		// RUNTIME_DUNDERS is never consulted. Every exempt case here needs a
		// real trailing accessor/call/assignment to actually exercise it.
		expect(checkPrivateMemberTestAccess(`it("t", () => { void svc.__proto__.x; });`, TEST)).toEqual([]);
	});
	it("N2: .__esModule = true runtime dunder (assignment) is exempt", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { mod.__esModule = true; });`, TEST)).toEqual([]);
	});
	it("N3: .__dirname.length runtime dunder (dot-chained) is exempt", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { void svc.__dirname.length; });`, TEST)).toEqual([]);
	});
	it("N4: .__filename() runtime dunder (called) is exempt", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { svc.__filename(); });`, TEST)).toEqual([]);
	});
	it("N5: a single-underscore ._privateThing is not a dunder violation (requires 2+ underscores)", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { svc._privateThing(); });`, TEST)).toEqual([]);
	});
});

describe("checkPrivateMemberTestAccess — BRACKET_PRIVATE", () => {
	it("P1: zero-spaced bracket access svc['__private'] is a violation", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { void svc['__private']; });`, TEST).length).toBe(1);
	});
	it("P2: fully-spaced bracket access svc [ '__private' ] is still a violation", () => {
		expect(
			checkPrivateMemberTestAccess(`it("t", () => { void svc [ '__private' ] ; });`, TEST).length,
		).toBe(1);
	});
	it("N1: a single-underscore bracket access svc['_private'] is not a violation", () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { void svc['_private']; });`, TEST)).toEqual([]);
	});
	it('P3: a double-quoted bracket access svc["__private"] is a violation', () => {
		expect(checkPrivateMemberTestAccess(`it("t", () => { void svc["__private"]; });`, TEST).length).toBe(1);
	});
	it("P4: bracket access at the very start of the line (no preceding char to borrow) is a violation", () => {
		// An unanchored negated/truncated first-char-class mutant can often
		// still find a match by starting ONE character to the left (e.g. at a
		// leading space) — putting the identifier at position 0 removes that
		// escape hatch.
		expect(checkPrivateMemberTestAccess(`svc['__private'];`, TEST).length).toBe(1);
	});
	it("P5: a single-character identifier x['__private'] at line start is a violation", () => {
		// A single-char identifier removes the "one char later, still 2+
		// chars available" retreat for a truncated/negated rest-class mutant.
		expect(checkPrivateMemberTestAccess(`x['__private'];`, TEST).length).toBe(1);
	});
	it("P6: a digit-suffixed identifier x1['__private'] at line start is a violation", () => {
		// An all-LETTER identifier of any length lets a negated/case-flipped
		// rest-class mutant retreat to using just its OWN LAST letter as a
		// trivial 1-char identifier match ([A-Za-z_$] accepts any letter). A
		// DIGIT immediately before "[" closes that hatch: digits satisfy \w
		// (pristine's [\w$]* rest-class consumes them) but fail the mandatory
		// FIRST-char class [A-Za-z_$] (digits aren't letters/_/$), so a
		// negated/flipped rest-class mutant has no valid retreat position.
		expect(checkPrivateMemberTestAccess(`x1['__private'];`, TEST).length).toBe(1);
	});
});
