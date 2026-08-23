// Mutation-kill suite for wave pass1_w46 survivors in test-hygiene-isolation.ts.
//
// Every regex in this module differs from its mutants by a single \s* / \s / \S*
// swap (or a negated character class / dropped `?`). Each test below picks an
// input string that the real regex accepts but the described mutant would
// reject (or vice versa), verified by direct regex simulation against the
// mutant source before this file was written. The assertion checks the
// OBSERVABLE output of the exported check function, not the private regex.

import { describe, expect, it } from "vitest";
import { checkRealIoInTests, checkTestNondeterminism } from "./test-hygiene-isolation.js";

const FILE = "src/example.test.ts";

describe("checkRealIoInTests — NETWORK_CALL_RE survivors — positive (must fire)", () => {
	it("P1: bare `axios.get(` with no internal whitespace flags a real network call (kills b7c0e3c9, 37aa3dfa, f7db9442)", () => {
		const content = 'it("x", () => {\n  axios.get("http://x.example/a");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(2);
	});

	it("P2: `axios .get(` with a space before the dot flags (kills 135613670282ff31)", () => {
		const content = 'it("x", () => {\n  axios .get("http://x.example/b");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P3: `axios.get (` with a space before the call paren flags (kills 1b8e9ba330687521)", () => {
		const content = 'it("x", () => {\n  axios.get ("http://x.example/c");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P4: `axios. get(` with a space after the dot flags (kills ceb34cd6ad984025)", () => {
		const content = 'it("x", () => {\n  axios. get("http://x.example/d");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P5: bare `http.get(` (no trailing s) flags — the `https?` alternation must accept plain http (kills f9b99ace463e20aa)", () => {
		const content = 'it("x", () => {\n  http.get("http://x.example/e");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});
});

describe("checkRealIoInTests — HTTP_LITERAL_URL_RE survivors — positive (must fire)", () => {
	it("P6: quoted external URL with normal length flags (kills 38cf2003, fec3909482526c01, f58b661c279dd732, 9eccd7ebe671f5fe, 1f467b7a3acafbae)", () => {
		const content = 'it("x", () => {\n  fetch("http://example.com/x");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toContain("real network call");
	});

	it("P7: quoted URL with the shortest possible path segment flags (kills 7394d001f1a054c8)", () => {
		const content = 'it("x", () => {\n  fetch("http://a");\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toContain("real network call");
	});
});

describe("checkRealIoInTests — FS_WRITE_RE / FS_WRITE_CALL_RE survivors — positive (must fire)", () => {
	it("P8: plain writeFileSync call with a non-tmp path flags (kills f1f6236479d523bd, f28a0f441c47b36d, e54db0edc72871de, 2a6db941c37a2f6a, 8913eaa8870844ba, 6d82eeca581be072)", () => {
		const content = 'it("x", () => {\n  writeFileSync("/etc/passwd", data);\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toContain("/etc/passwd");
	});

	it("P9: writeFileSync with a space before the call paren flags (kills 0d10763c69cd6631, 9a5ac69fcf77824a)", () => {
		const content = 'it("x", () => {\n  writeFileSync ("/etc/passwd", data);\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P10: writeFileSync with a space right after the open paren flags (kills 226d21bc05a3738c)", () => {
		const content = 'it("x", () => {\n  writeFileSync( "/etc/passwd", data);\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P11: writeFileSync with a single-character path literal flags (kills 0129103cca315cf0)", () => {
		const content = 'it("x", () => {\n  writeFileSync("a", data);\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(1);
	});
});

describe("checkRealIoInTests — FS_HELPER_DEF_RE survivors — negative (must not fire, local helper suppresses)", () => {
	it("N1: single-space `function writeFileSync` is recognized as a local helper, suppressing the call site (kills d39f42e64cd41155)", () => {
		const content =
			'function writeFileSync(name) { return name; }\nwriteFileSync("outside/real.txt");\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(0);
	});

	it("N2: two-space `function  writeFileSync` is still recognized as a local helper (kills 2ee96fb554d3064c)", () => {
		const content =
			'function  writeFileSync(name) { return name; }\nwriteFileSync("outside/real2.txt");\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(0);
	});
});

describe("checkRealIoInTests — TMP_PATH_RE survivors — negative (must not fire, path recognized as tmp-safe)", () => {
	it("N3: a bare `tmp/...` path with no leading separator is tmp-safe (kills a53d3dec767f07a8)", () => {
		const content = 'it("x", () => {\n  writeFileSync("tmp/foo/data.txt", x);\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(0);
	});

	it("N4: a `.../tmp/...` path preceded by a slash is tmp-safe (kills abfb2383f86ea340)", () => {
		const content = 'it("x", () => {\n  writeFileSync("foo/tmp/bar.txt", x);\n});\n';
		const matches = checkRealIoInTests(content, FILE);
		expect(matches).toHaveLength(0);
	});
});

describe("checkTestNondeterminism — TEST_NONDETERMINISM_RE survivors — positive (must fire)", () => {
	it("P12: bare Date.now() with no internal whitespace flags (kills 9e6013092d49c19a, 2587cd7d4948e444, 15895140e1ef7dd2)", () => {
		const content = 'it("x", () => {\n  Date.now();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P13: fully-spaced `Date . now ()` flags (kills 7ba73929c120638c, 22174e7ddda2d6a4)", () => {
		const content = 'it("x", () => {\n  Date . now ();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P14: double-spaced `Date  . now()` flags (kills 39e084de6411aee7)", () => {
		const content = 'it("x", () => {\n  Date  . now();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P15: bare `new Date()` flags (kills 07a5cb37ea1205bb, 3f2f6ae30f173099, 901b474fb8ec75d3)", () => {
		const content = 'it("x", () => {\n  new Date();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P16: double-spaced `new  Date()` flags (kills 58f5474800e1fddd)", () => {
		const content = 'it("x", () => {\n  new  Date();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P17: spaced `new Date ( )` flags (kills e98778f6d1228108, 189a2c30e8da2edc)", () => {
		const content = 'it("x", () => {\n  new Date ( );\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P18: bare `Math.random()` flags (kills c2ce7549d412bddf, b7cbf9ce125d19e0, ce9e8b8f18a7d438)", () => {
		const content = 'it("x", () => {\n  Math.random();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P19: fully-spaced `Math . random ()` flags (kills 9344064d1f460645, 1301e79838a8da4d, 74933a7594e70a7a)", () => {
		const content = 'it("x", () => {\n  Math . random ();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P20: bare `crypto.randomUUID()` flags (kills d13b2451e3c28830, 1dcb6f8ee1af728e, aae3467c7652480b)", () => {
		const content = 'it("x", () => {\n  crypto.randomUUID();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P21: fully-spaced `crypto . randomUUID ()` flags (kills d3fbd07e1f491f9b, 2b20769bb59ce02c, cefe633e0cd904ce)", () => {
		const content = 'it("x", () => {\n  crypto . randomUUID ();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P22: bare `crypto.randomBytes()` flags (kills 882c88fe41bb20bd, 0e8f55d4653474fc, 3c4d3369e12dc629)", () => {
		const content = 'it("x", () => {\n  crypto.randomBytes();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P23: fully-spaced `crypto . randomBytes ()` flags (kills 6ccd2b3c95bfaa43, 8ab2f957afeeadd8, f80b50ec2a5d1833)", () => {
		const content = 'it("x", () => {\n  crypto . randomBytes ();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P24: bare `performance.now()` flags (kills ac07cd732fdf29aa, c5e59a3d06936576)", () => {
		const content = 'it("x", () => {\n  performance.now();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});

	it("P25: fully-spaced `performance . now ()` flags (kills d9dd09303bc74992)", () => {
		const content = 'it("x", () => {\n  performance . now ();\n});\n';
		const matches = checkTestNondeterminism(content, FILE);
		expect(matches).toHaveLength(1);
	});
});
