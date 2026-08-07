// Analyzer-unavailable path: when `computeCognitiveAst` returns null (the
// `typescript` optional dep absent — see cognitive-ast.ts's doc comment,
// "degrades to null... no regex fallback"), the promoted block gate must fail
// OPEN (never a false block) exactly like the cyclomatic gate does for its own
// missing-analyzer case (complexity-write-guard.test.ts's radon-unavailable
// test). Isolated in its own file because the module-level mock below applies
// for the whole file — cognitive-write-guard.block.test.ts needs the REAL
// analyzer for its over-cap/slew assertions.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../checks/cognitive-ast.js", () => ({
	computeCognitiveAst: vi.fn(() => null),
}));

import { checkCognitiveComplexityWrite, cognitiveWriteWarning } from "./cognitive-write-guard.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cog-unavail-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkCognitiveComplexityWrite — typescript unavailable", () => {
	it("fails OPEN (never a false block) when the AST pass is unavailable", () => {
		const file = join(tmp, "whatever.ts");
		writeFileSync(file, "export function f() { if (a) { if (b) { if (c) { return 1; } } } return 0; }\n");
		const out = checkCognitiveComplexityWrite(
			{ file_path: file, content: "export function f() { return 1; }\n" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("fails OPEN on an apply_patch payload too", () => {
		const patch =
			"*** Begin Patch\n" +
			"*** Add File: gen.ts\n" +
			"+export function f() { return 1; }\n" +
			"*** End Patch";
		expect(checkCognitiveComplexityWrite({ command: patch }, tmp)).toBeNull();
	});
});

describe("cognitiveWriteWarning — typescript unavailable", () => {
	it("returns null (never warns) when the AST pass is unavailable", () => {
		const abs = join(tmp, "whatever.ts");
		writeFileSync(abs, "export function f() { return 1; }\n");
		expect(cognitiveWriteWarning(abs, "export function f() { return 2; }\n", tmp)).toBeNull();
	});
});
