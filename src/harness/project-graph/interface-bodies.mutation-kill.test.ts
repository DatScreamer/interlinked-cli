// ===========================================================================
// Mutation-kill companion for src/harness/project-graph/interface-bodies.ts.
//
// extractInterfaceBodies is a hand-rolled brace-matching state machine, not a
// parser: `currentName` gates when `body` accumulates, two sibling regexes
// detect an interface/type start, and `body.trim()` finalizes into `result`.
// The existing interface-bodies.test.ts smoke suite only uses `.toContain(...)`,
// so it never pins the EXACT captured text — leaving every StringLiteral reset,
// both `.trim()` calls, both anchored regexes' quantifier boundaries, and both
// `if` gates unobserved. Every case below asserts a full Map snapshot
// (`toEqual`) or an exact string, so any one of those literals drifting
// produces a visible mismatch.
//
// Two of the four `body = ""` reset sites (the declaration-time initializer
// and the post-finalize reset) are structurally dead stores: `body` is only
// ever read while `currentName` is truthy, and the only two places
// `currentName` transitions from falsy to truthy (the ifaceMatch and
// typeMatch branches) each perform their OWN `body = ""` reset before control
// can reach a read — so no test targets those two mutants here (see the
// pass-1 receipts for the structural argument).
// ===========================================================================

import { describe, expect, it } from "vitest";
import { extractInterfaceBodies } from "./interface-bodies.js";

describe("extractInterfaceBodies (mutation-kill)", () => {
	// test-contract: public-api — captured interface body is the exact
	// trimmed source text: no leading contamination from the ifaceMatch-branch
	// reset, and no trailing newline left behind by a skipped body.trim().
	it("captures a single interface as an exact trimmed body, no artifacts", () => {
		const code = "export interface User {\nid: string\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["User", "export interface User {\nid: string\n}"]]),
		);
	});

	// test-contract: public-api — captured type-alias body is the exact
	// trimmed source text, with no leading contamination from the
	// typeMatch-branch reset.
	it("captures a single type alias as an exact trimmed body", () => {
		const code = "export type Point = {\nx: number\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Point", "export type Point = {\nx: number\n}"]]),
		);
	});

	// test-contract: public-api — each line is matched (and re-stored) via
	// its OWN trim(), not the raw indented source line, so an indented
	// declaration is still recognized and stored without the indent.
	it("detects and stores an indented declaration via per-line trim()", () => {
		const code = "  export interface Foo {\n  id: string\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Foo", "export interface Foo {\nid: string\n}"]]),
		);
	});

	// test-contract: invariant — while a body is open (currentName set), a
	// line that itself looks like a new "export interface X {" start is
	// accumulated as literal body text, not treated as a second declaration.
	it("does not restart tracking on an interface-shaped line inside an open body", () => {
		const code = "export interface Foo {\nexport interface Bar {\n}\n}";
		const bodies = extractInterfaceBodies(code);
		expect(bodies.size).toBe(1);
		expect(bodies.has("Bar")).toBe(false);
		expect(bodies.get("Foo")).toBe("export interface Foo {\nexport interface Bar {\n}\n}");
	});

	// test-contract: invariant — content with brace-bearing lines but no
	// export interface/type declaration never opens a capture, so no entry
	// (not even one keyed by a still-null currentName) is ever recorded.
	it("records nothing for brace-bearing content with no export declaration", () => {
		const code = "function foo() {\n}";
		expect(extractInterfaceBodies(code)).toEqual(new Map());
	});

	// test-contract: invariant — an interface whose opening "{" sits on a
	// LATER line than "export interface Name" must not finalize on the
	// declaration line itself (braceDepth is already 0 there, but no "{" has
	// been seen yet); it finalizes once the real "{" and its "}" close.
	it("does not finalize before the opening brace has actually appeared", () => {
		const code = "export interface Foo\n{\nid: string\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Foo", "export interface Foo\n{\nid: string\n}"]]),
		);
	});

	// test-contract: boundary — the interface regex is anchored (^): a line
	// carrying "export interface X {" only as a substring (not at the start
	// of the trimmed line) must not match.
	it("does not match 'export interface' occurring mid-line", () => {
		const code = "// export interface Foo {\n}";
		expect(extractInterfaceBodies(code)).toEqual(new Map());
	});

	// test-contract: boundary — the type regex is likewise anchored (^): a
	// line carrying "export type X = {" only as a substring must not match.
	it("does not match 'export type' occurring mid-line", () => {
		const code = "// export type Foo = {\n}";
		expect(extractInterfaceBodies(code)).toEqual(new Map());
	});

	// test-contract: boundary — the interface regex allows ONE OR MORE
	// spaces between "export" and "interface" (\s+, not a single \s).
	it("matches multiple spaces between 'export' and 'interface'", () => {
		const code = "export  interface Foo {\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Foo", "export  interface Foo {\n}"]]),
		);
	});

	// test-contract: boundary — the interface regex allows ONE OR MORE
	// spaces between "interface" and the captured name.
	it("matches multiple spaces between 'interface' and the name", () => {
		const code = "export interface  Foo {\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Foo", "export interface  Foo {\n}"]]),
		);
	});

	// test-contract: boundary — the type regex allows ONE OR MORE spaces
	// between "export" and "type".
	it("matches multiple spaces between 'export' and 'type'", () => {
		const code = "export  type Foo = {\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Foo", "export  type Foo = {\n}"]]),
		);
	});

	// test-contract: boundary — the type regex allows ONE OR MORE spaces
	// between "type" and the captured name.
	it("matches multiple spaces between 'type' and the name", () => {
		const code = "export type  Foo = {\n}";
		expect(extractInterfaceBodies(code)).toEqual(
			new Map([["Foo", "export type  Foo = {\n}"]]),
		);
	});

	// test-contract: boundary — the type regex allows ZERO spaces between
	// the captured name and "=" (\s*, not a required \s).
	it("matches zero spaces between the name and '='", () => {
		const code = "export type Foo= {\n}";
		expect(extractInterfaceBodies(code)).toEqual(new Map([["Foo", "export type Foo= {\n}"]]));
	});

	// test-contract: boundary — the type regex allows ZERO spaces between
	// "=" and the opening "{" (\s*, not a required \s).
	it("matches zero spaces between '=' and the opening brace", () => {
		const code = "export type Foo ={\n}";
		expect(extractInterfaceBodies(code)).toEqual(new Map([["Foo", "export type Foo ={\n}"]]));
	});
});
