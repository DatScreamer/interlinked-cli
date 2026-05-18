import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLargeFileLineCountWrite } from "../pre-checks.js";

/** Build a string of exactly `n` lines of code. */
function lines(n: number): string {
	return Array.from({ length: n }, () => "const x = 1;").join("\n");
}

describe("checkLargeFileLineCountWrite", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-checks-cap-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const file = (name: string): string => join(dir, name);

	// --- Blocks (the write would grow a cappable file past the cap) ---

	it("blocks a brand-new code file written over the cap", () => {
		const result = checkLargeFileLineCountWrite(
			{ file_path: file("big.ts"), content: lines(1600) },
			dir,
		);
		expect(result?.block).toContain("1500-line cap");
	});

	it("blocks a Write that grows an existing under-cap file past the cap", () => {
		const path = file("grow.ts");
		writeFileSync(path, lines(1000));
		const result = checkLargeFileLineCountWrite({ file_path: path, content: lines(1700) }, dir);
		expect(result?.block).toBeDefined();
	});

	it("blocks an Edit that grows a near-cap file past the cap", () => {
		const path = file("edit.ts");
		writeFileSync(path, lines(1490));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(21) },
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("blocks an Edit that grows an already-over-cap file", () => {
		const path = file("already-big.ts");
		writeFileSync(path, lines(1800));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(10) },
			dir,
		);
		expect(result?.block).toContain("already 1800 lines");
	});

	// --- Allows (within cap, shrinking, or exempt) ---

	it("allows a new code file under the cap", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("ok.ts"), content: lines(1400) }, dir),
		).toBeNull();
	});

	it("allows an Edit that shrinks an over-cap file (refactor-down)", () => {
		const path = file("shrink.ts");
		writeFileSync(path, lines(1800));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: lines(200), new_string: lines(50) },
			dir,
		);
		expect(result).toBeNull();
	});

	it("allows a Write that holds an over-cap file at its current size", () => {
		const path = file("hold.ts");
		writeFileSync(path, lines(1600));
		expect(
			checkLargeFileLineCountWrite({ file_path: path, content: lines(1600) }, dir),
		).toBeNull();
	});

	it("does not cap test files", () => {
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: file("huge.test.ts"), content: lines(2200) },
				dir,
			),
		).toBeNull();
	});

	it("does not cap non-code files", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("notes.md"), content: lines(2200) }, dir),
		).toBeNull();
	});

	it("does not cap generated files", () => {
		const content = `// @generated\n${lines(1600)}`;
		expect(
			checkLargeFileLineCountWrite({ file_path: file("schema.ts"), content }, dir),
		).toBeNull();
	});

	it("fails open on tool shapes it cannot project (apply_patch)", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("x.ts"), patch: "@@ -1 +1 @@" }, dir),
		).toBeNull();
	});
});
