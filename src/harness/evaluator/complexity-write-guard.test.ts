import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFunctionComplexityWrite, DEFAULT_MAX_CYCLOMATIC } from "./complexity-write-guard.js";

/** A function body with `branches` if-statements → cyclomatic ≈ branches + 1. */
function fnWith(name: string, branches: number): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

/** An anonymous arrow callback (named "(callback)" by the AST pass) with
 *  `branches` if-statements → cyclomatic ≈ branches + 1. */
function anonFnWith(branches: number): string {
	let body = "\tlet r = 0;\n";
	for (let i = 0; i < branches; i++) body += `\tif (a === ${i}) r += ${i};\n`;
	return `export const wired = register((a: number): number => {\n${body}\treturn r;\n});\n`;
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cyc-guard-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkFunctionComplexityWrite", () => {
	it("exposes the cap as 25", () => {
		expect(DEFAULT_MAX_CYCLOMATIC).toBe(25);
	});

	it("allows non-JS/TS files", () => {
		const out = checkFunctionComplexityWrite({ file_path: "src/x.py", content: fnWith("f", 40) }, tmp);
		expect(out).toBeNull();
	});

	it("allows a Write where every function is under the cap", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "ok.ts"), content: fnWith("ok", 5) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks a Write that adds a NEW over-cap function", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "big.ts"), content: fnWith("big", 40) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("big");
		expect(out?.block).toContain("new");
	});

	it("allows an Edit that holds/reduces an already-over-cap function (refactor-down)", () => {
		const file = join(tmp, "huge.ts");
		writeFileSync(file, fnWith("huge", 40)); // ~41, already over cap
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "let r = 0;", new_string: "let r = 1;" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks an Edit that RAISES a function past the cap", () => {
		const file = join(tmp, "grow.ts");
		writeFileSync(file, fnWith("grow", 5)); // ~6, under cap
		let added = "";
		for (let i = 0; i < 40; i++) added += `\tif (a === ${100 + i}) r += ${i};\n`;
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "\treturn r;", new_string: `${added}\treturn r;` },
			tmp,
		);
		expect(out?.block).toContain("grow");
		expect(out?.block).toContain("raised from");
	});

	it("exempts test files via the cappable-file exemption", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "x.test.ts"), content: fnWith("t", 40) },
			tmp,
		);
		expect(out).toBeNull();
	});

	// --- F3: identity-free over-cap multiset comparison ---
	// The previous name-keyed-max logic dropped anonymous callbacks and collapsed
	// same-named functions, so both repros below were ALLOWED before the fix.

	it("blocks a NEW anonymous callback over the cap (was dropped by name-keying)", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "anon.ts"), content: anonFnWith(40) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("anonymous");
	});

	it("blocks shuffling complexity between same-named functions", () => {
		const file = join(tmp, "shuffle.ts");
		// before: two run()s at ~31 and ~6 → over-cap profile [31]
		writeFileSync(file, fnWith("run", 30) + fnWith("run", 5));
		// after: ~30 and ~27 → over-cap profile [30, 27]; a NEW over-cap value (27)
		// appears even though the max dropped 31→30. Name-keyed-max saw only run→30
		// vs run→31 (a reduction) and allowed it.
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("run", 29) + fnWith("run", 26) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("run");
	});

	it("allows splitting one over-cap function into several under-cap ones", () => {
		const file = join(tmp, "split.ts");
		writeFileSync(file, fnWith("big", 40)); // [41] — over cap
		const after = fnWith("a", 8) + fnWith("b", 8) + fnWith("c", 8); // all under cap
		const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out).toBeNull();
	});

	it("allows adding a new UNDER-cap function alongside an existing over-cap one", () => {
		const file = join(tmp, "coexist.ts");
		writeFileSync(file, fnWith("legacy", 40)); // [41] — already over cap, untouched
		// Whole-file rewrite that holds `legacy` and adds a small helper.
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("legacy", 40) + fnWith("helper", 5) },
			tmp,
		);
		expect(out).toBeNull();
	});

	// --- F2: Codex apply_patch no longer bypasses the gate ---

	/** Build an apply_patch "Add File" payload from full file content. */
	function applyPatchAdd(path: string, content: string): { command: string } {
		const body = content
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n");
		return { command: `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch` };
	}

	it("blocks an apply_patch Add File introducing an over-cap function", () => {
		const out = checkFunctionComplexityWrite(
			applyPatchAdd(join(tmp, "gen.ts"), fnWith("genned", 40)),
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("gen.ts");
	});

	it("allows an apply_patch Add File with only under-cap functions", () => {
		const out = checkFunctionComplexityWrite(
			applyPatchAdd(join(tmp, "okgen.ts"), fnWith("okfn", 5)),
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks an apply_patch Update File that raises a function past the cap", () => {
		const file = join(tmp, "grow.ts");
		writeFileSync(file, fnWith("grow", 5)); // grow ~6, under cap; last `if` is a===4
		let added = "";
		for (let i = 0; i < 40; i++) added += `+\tif (a === ${100 + i}) r += ${i};\n`;
		const patch =
			"*** Begin Patch\n" +
			`*** Update File: ${file}\n` +
			"@@\n" +
			" \tif (a === 4) r += 4;\n" + // context (space + tab + line)
			added +
			" \treturn r;\n" + // context
			"*** End Patch";
		const out = checkFunctionComplexityWrite({ command: patch }, tmp);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("grow");
	});

	it("fails open on an apply_patch whose context cannot be matched", () => {
		const file = join(tmp, "nomatch.ts");
		writeFileSync(file, fnWith("nm", 5));
		const patch =
			"*** Begin Patch\n" +
			`*** Update File: ${file}\n` +
			"@@\n" +
			" nonexistent context line\n" +
			"-foo\n" +
			"+bar\n" +
			"*** End Patch";
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
	});
});
