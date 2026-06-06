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
});
