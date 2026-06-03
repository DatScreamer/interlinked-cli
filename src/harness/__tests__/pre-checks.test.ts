import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_LINES, resetLargeFileBaselineCache } from "../large-file-policy.js";
import { checkLargeFileLineCountWrite } from "../pre-checks.js";

/** Build a string of exactly `n` lines of code. */
function lines(n: number): string {
	return Array.from({ length: n }, () => "const x = 1;").join("\n");
}

describe("checkLargeFileLineCountWrite", () => {
	let dir: string;
	// Fixtures are relative to THE canonical cap so the suite tests the real
	// number (not a hardcoded 1500) and survives future ratcheting unchanged.
	const CAP = DEFAULT_MAX_LINES;

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
			{ file_path: file("big.ts"), content: lines(CAP + 600) },
			dir,
		);
		expect(result?.block).toContain(`${CAP}-line cap`);
	});

	it("blocks a Write that grows an existing under-cap file past the cap", () => {
		const path = file("grow.ts");
		writeFileSync(path, lines(CAP));
		const result = checkLargeFileLineCountWrite({ file_path: path, content: lines(CAP + 700) }, dir);
		expect(result?.block).toBeDefined();
	});

	it("blocks an Edit that grows a near-cap file past the cap", () => {
		const path = file("edit.ts");
		writeFileSync(path, lines(CAP - 10));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(21) },
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("blocks a MultiEdit whose net growth crosses the cap", () => {
		const path = file("multi.ts");
		writeFileSync(path, lines(CAP - 5));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, edits: [{ old_string: "const x = 1;", new_string: lines(20) }] },
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("blocks an Edit that grows an already-over-cap file", () => {
		const path = file("already-big.ts");
		const before = CAP + 800;
		writeFileSync(path, lines(before));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(10) },
			dir,
		);
		expect(result?.block).toContain(`already ${before} lines`);
	});

	// --- Allows (within cap, shrinking, or exempt) ---

	it("allows a new code file under the cap", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("ok.ts"), content: lines(CAP - 100) }, dir),
		).toBeNull();
	});

	it("allows an Edit that shrinks an over-cap file (refactor-down)", () => {
		const path = file("shrink.ts");
		writeFileSync(path, lines(CAP + 800));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: lines(200), new_string: lines(50) },
			dir,
		);
		expect(result).toBeNull();
	});

	it("allows a Write that holds an over-cap file at its current size", () => {
		const path = file("hold.ts");
		writeFileSync(path, lines(CAP + 600));
		expect(
			checkLargeFileLineCountWrite({ file_path: path, content: lines(CAP + 600) }, dir),
		).toBeNull();
	});

	it("does not cap test files", () => {
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: file("huge.test.ts"), content: lines(CAP + 1200) },
				dir,
			),
		).toBeNull();
	});

	it("does not cap non-code files", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("notes.md"), content: lines(CAP + 1200) }, dir),
		).toBeNull();
	});

	it("does not cap generated files", () => {
		const content = `// @generated\n${lines(CAP + 600)}`;
		expect(
			checkLargeFileLineCountWrite({ file_path: file("schema.ts"), content }, dir),
		).toBeNull();
	});

	it("honors a custom max_lines from the baseline (cap value is read, not hardcoded)", () => {
		// A stricter baseline must lower the cap: a file fine under the default
		// must block under the baseline's smaller max_lines.
		const customCap = CAP - 200;
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ version: 1, max_lines: customCap, files: {} }),
		);
		resetLargeFileBaselineCache();
		const path = file("cfg.ts");
		writeFileSync(path, lines(customCap + 50)); // under default CAP, over customCap
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(5) },
			dir,
		);
		expect(result?.block).toContain(`${customCap}-line cap`);
	});

	it("fails open on tool shapes it cannot project (apply_patch)", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("x.ts"), patch: "@@ -1 +1 @@" }, dir),
		).toBeNull();
	});
});
