import { describe, expect, it } from "vitest";
import {
	buildPatchApplierReason,
	detectPatchApplier,
} from "./patch-applier-guard.js";

describe("detectPatchApplier — extension anchor (must fire)", () => {
	// test-contract: public-api — SCRIPT_EXT_RE's trailing $ anchor is the
	// documented "only real script extensions" rule (comment above the const).
	it("P1: a path ending .ts.txt is not a script — the $ anchor must reject a mid-string .ts", () => {
		// Without the trailing $ anchor, /\.ts/i would match the ".ts" substring
		// inside "notes.ts.txt" even though the file does not actually end in a
		// recognized script extension.
		const content = `writeFileSync("src/generated.ts", output);`;
		expect(detectPatchApplier(content, "notes.ts.txt")).toBeNull();
	});

	// test-contract: public-api — control case proving the same write+target
	// content DOES fire for a genuine .ts file, isolating the extension check.
	it("N1: a real .ts file with the same write+target content still fires", () => {
		const content = `writeFileSync("src/generated.ts", output);`;
		const result = detectPatchApplier(content, "probe.ts");
		expect(result).not.toBeNull();
	});
});

describe("detectPatchApplier — WRITE_CALL_RE exact spacing (must fire)", () => {
	// test-contract: public-api — WRITE_CALL_RE's `\s*` between the function
	// name and `(` is documented to tolerate whitespace before the call.
	it("P2: a space between the function name and '(' is still a write call", () => {
		// \s* must allow the space here; a \S* mutant would refuse to match at all.
		const content = `writeFileSync ("src/generated.ts");`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
		expect(result?.writeCall).toContain("writeFileSync");
	});

	// test-contract: public-api — WRITE_CALL_RE's open() alternative allows
	// zero whitespace between "open" and "(". The mode argument deliberately
	// uses a mismatched quote pair ('w") so stripCommentsAndStrings (which
	// WRITE_CALL_RE is matched against) cannot blank it out as a complete
	// same-line string — this is the only way to observe the open() branch
	// post-stripping.
	it("P3: open() with zero spaces before '(' is still a write call", () => {
		// \bopen\s*\( must allow ZERO spaces; a mutant requiring \s (mandatory
		// one) or \S* (no space allowed) both diverge from this input.
		const content = `open(x, 'w")\nconst t = 'src/foo.py';`;
		const result = detectPatchApplier(content, "probe.py");
		expect(result?.writeCall).toBe(`open(x, 'w"`);
	});

	// test-contract: public-api — WRITE_CALL_RE's open() alternative also
	// allows whitespace between "open" and "(" (same mismatched-quote trick).
	it("P4: open with a space before '(' is still a write call", () => {
		// \bopen\s*\( must allow the space; a \S* mutant fails here.
		const content = `open (x, 'w")\nconst t = 'src/foo.py';`;
		const result = detectPatchApplier(content, "probe.py");
		expect(result?.writeCall).toBe(`open (x, 'w"`);
	});

	// test-contract: public-api — [^)]* is documented to span an arbitrary
	// argument list before the mode-quote portion of the open() alternative.
	it("P5: a long argument list between '(' and the mode quote still matches", () => {
		// [^)]* must consume "x, y, z, "; a mutant dropping the star to a
		// single char, or narrowing the class to only ')' characters, cannot
		// bridge that gap.
		const content = `open(x, y, z, 'w")\nconst t = 'src/foo.py';`;
		const result = detectPatchApplier(content, "probe.py");
		expect(result?.writeCall).toBe(`open(x, y, z, 'w"`);
	});

	// test-contract: public-api — the mode-quote grammar `['"][wa]\+?['"]`
	// is exercised at its exact minimal shape: quote, mode char, close quote,
	// with no extra characters and no '+'.
	it("N2: the mode literal quote-w-quote with no extra character, no '+', matches exactly", () => {
		// Exercises: ['"][wa]\+?['"] as written — quote, then immediately 'w',
		// no mandatory extra char, no mandatory '+', closed by a real quote
		// (here a mismatched double-quote, chosen so stripCommentsAndStrings
		// cannot pre-blank the whole "'w\"" run as a paired string literal).
		// Mutants that (a) insert a required [^'"] gap, (b) negate [wa] to
		// [^wa], (c) make \+? mandatory, or (d) negate the closing ['"] all
		// fail to match this exact literal.
		const content = `open(x, 'w")\nconst t = 'src/foo.py';`;
		const result = detectPatchApplier(content, "probe.py");
		expect(result?.writeCall).toBe(`open(x, 'w"`);
	});
});

describe("detectPatchApplier — REPO_TARGET_RE exact grammar (must fire)", () => {
	// test-contract: public-api — REPO_TARGET_RE's `tests?` group is
	// documented to match both the singular and plural test directory name.
	it("P6: singular 'test/' directory matches the optional-s group", () => {
		// tests? must accept "test" without the trailing s; a mutant dropping
		// the '?' requires literal "tests" and misses this target.
		const content = `writeFileSync('test/generated.ts', data);`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
		expect(result?.repoTarget).toContain("test/generated.ts");
	});

	// test-contract: public-api — REPO_TARGET_RE's quoted-path alternative
	// must close on a real quote/backtick, asserted against the exact
	// returned repoTarget value (not mere truthiness).
	it("P7: a quoted src/ path closed by a real quote matches", () => {
		// The final ['"`] must be a real quote/backtick; a mutant negating it
		// to [^'"`] cannot close a well-formed quoted literal.
		const content = `writeFileSync('src/foo.ts', data);`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
		expect(result?.repoTarget).toBe("'src/foo.ts'");
	});

	// test-contract: public-api — the process.cwd() alternative's first
	// `\s*` is documented to tolerate whitespace before the call parens.
	it("P8: process.cwd() with a space between cwd and '(' matches", () => {
		// \s* must allow the space; a \S* mutant refuses to match here.
		const content = `writeFileSync(x, y); const p = process.cwd ();`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
	});

	// test-contract: public-api — the process.cwd() alternative's second
	// `\s*` is documented to tolerate whitespace inside the call parens.
	it("P9: process.cwd( ) with a space inside the parens matches", () => {
		// The second \s* must allow a space between '(' and ')'; a \S* mutant
		// there requires a non-whitespace char and fails.
		const content = `writeFileSync(x, y); const p = process.cwd( );`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
	});

	// test-contract: public-api — the os.getcwd() alternative's first `\s*`
	// is documented to tolerate ZERO whitespace before the call parens.
	it("P10: os.getcwd() with zero spaces before '(' matches", () => {
		// The first \s* after getcwd must allow ZERO spaces; a mutant requiring
		// a mandatory single \s fails on this tightly-packed call.
		const content = `writeFileSync(x, y); const p = os.getcwd();`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
	});

	// test-contract: public-api — the os.getcwd() alternative's first `\s*`
	// also tolerates whitespace before the call parens.
	it("P11: os.getcwd () with a space before '(' matches", () => {
		// The first \s* must allow the space; a \S* mutant there fails.
		const content = `writeFileSync(x, y); const p = os.getcwd ();`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
	});

	// test-contract: public-api — the os.getcwd() alternative's second
	// `\s*` is documented to tolerate whitespace inside the call parens.
	it("P12: os.getcwd( ) with a space inside the parens matches", () => {
		// The second \s* must allow the space; a \S* mutant there fails.
		const content = `writeFileSync(x, y); const p = os.getcwd( );`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
	});

	// test-contract: public-api — the os.getcwd() alternative's second
	// `\s*` also tolerates ZERO whitespace inside the call parens.
	it("P13: os.getcwd() with zero spaces inside the parens matches", () => {
		// The second \s* must allow ZERO spaces; a mutant requiring a
		// mandatory single \s fails on the tightly-packed "()" here.
		const content = `writeFileSync(x, y); const p = os.getcwd();`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result).not.toBeNull();
	});

	// test-contract: public-api — REPO_TARGET_RE's `../` escape alternative
	// requires a real leading quote/backtick, asserted against the exact
	// returned repoTarget value.
	it("P14: a quoted '../' escape closed correctly by a preceding quote matches", () => {
		// The leading ['"`] before '../' must be a real quote; a mutant
		// negating it to [^'"`] cannot match a genuinely-quoted literal. This
		// alternative has no trailing-path requirement, so the match is just
		// the quote + "../" — asserted exactly, not merely non-null.
		const content = `writeFileSync('../generated.ts', data);`;
		const result = detectPatchApplier(content, "probe.mjs");
		expect(result?.repoTarget).toBe("'../");
	});
});

describe("buildPatchApplierReason — every template segment is present (must fire)", () => {
	const reason = buildPatchApplierReason({
		target: "/tmp/plm/apply.mjs",
		evidence: { writeCall: "writeFileSync(", repoTarget: "'src/foo.ts'" },
	});

	// test-contract: public-api — buildPatchApplierReason's returned string
	// is the block reason the agent reads; each StringLiteral segment is a
	// distinct sentence the function is documented to concatenate.
	it("N3: includes the content-gate bypass sentence", () => {
		expect(reason).toContain(
			"Landing edits this way bypasses every content gate the Write/Edit tools run",
		);
	});

	// test-contract: public-api — same buildPatchApplierReason contract,
	// next concatenated sentence segment.
	it("N4: includes the unmeasured/unattributed + Edit-tool guidance sentence", () => {
		expect(reason).toContain(
			"unmeasured and unattributed. Use the Edit tool directly: a transiently non-compiling",
		);
	});

	// test-contract: public-api — same buildPatchApplierReason contract,
	// next concatenated sentence segment.
	it("N5: includes the reservations/trajectory-accounting clause", () => {
		expect(reason).toContain(
			"reservations, trajectory accounting) while still changing the code — the change lands",
		);
	});

	// test-contract: public-api — same buildPatchApplierReason contract,
	// next concatenated sentence segment.
	it("N6: includes the scripts/ + bypass-env-var sentence", () => {
		expect(reason).toContain(
			"under scripts/ where it is reviewable. Bypass: INTERLINKED_DISABLE_PATCH_APPLIER_GUARD=1.",
		);
	});

	// test-contract: public-api — same buildPatchApplierReason contract,
	// next concatenated sentence segment.
	it("N7: includes the tsc/biome/coverage ratchets clause", () => {
		expect(reason).toContain(
			"(tsc + biome diff-overlay, pre_block registry checks, coverage/complexity ratchets,",
		);
	});

	// test-contract: public-api — same buildPatchApplierReason contract,
	// final concatenated sentence segment.
	it("N8: includes the counterpart-edit / generated-output sentence", () => {
		expect(reason).toContain(
			"counterpart edit. If this script genuinely needs to write generated output, commit it",
		);
	});
});
