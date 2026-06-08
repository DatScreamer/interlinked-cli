import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Python analyzer so the dispatch + block contract can be tested
// without `radon` installed (the radon→entries mapping is covered in
// cyclomatic-python.test.ts via an injected spawn). The TS analyzer
// (cyclomatic-ast, a different module) stays REAL so the JS/TS tests below
// exercise the unchanged path end-to-end.
vi.mock("../checks/cyclomatic-python.js", () => ({
	computeCyclomaticPython: vi.fn(),
}));

import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticPython as mockedComputeCyclomaticPython } from "../checks/cyclomatic-python.js";
import {
	__resetPythonDegradeWarningForTesting,
	checkFunctionComplexityWrite,
	DEFAULT_MAX_CYCLOMATIC,
} from "./complexity-write-guard.js";

const pythonMock = vi.mocked(mockedComputeCyclomaticPython);

/** One synthetic Python entry at the given complexity. */
function pyEntry(name: string, cyclomatic: number, line = 1): FunctionComplexityEntry {
	return { name, line, endLine: line + 5, cyclomatic, language: "python" };
}

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

	it("skips unhandled extensions (.rb — neither JS/TS nor Python)", () => {
		const out = checkFunctionComplexityWrite({ file_path: "src/x.rb", content: fnWith("f", 40) }, tmp);
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

// ===========================================================================
// Python (.py) dispatch — same block contract via the radon-backed analyzer.
// The analyzer is mocked (pythonMock); these tests pin the EXTENSION DISPATCH,
// the cap boundary, and the loud-degrade-not-silent-pass behavior. The
// radon→entries mapping itself is covered in cyclomatic-python.test.ts.
// ===========================================================================
describe("checkFunctionComplexityWrite — Python dispatch", () => {
	let pyTmp: string;
	beforeEach(() => {
		pyTmp = mkdtempSync(join(tmpdir(), "cyc-guard-py-"));
		pythonMock.mockReset();
	});
	afterEach(() => {
		rmSync(pyTmp, { recursive: true, force: true });
	});

	it("routes a .py edit to computeCyclomaticPython (NOT the TS AST)", () => {
		pythonMock.mockReturnValue([pyEntry("greet", 3)]);
		checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "app.py"), content: "def greet():\n    pass\n" },
			pyTmp,
		);
		expect(pythonMock).toHaveBeenCalledTimes(2); // before + after content
	});

	it("blocks a Python Write whose function is over the cap (cyc 26)", () => {
		pythonMock.mockImplementation((content: string) =>
			content.trim() === "" ? [] : [pyEntry("dispatch", 26)],
		);
		const out = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "dispatch.py"), content: "def dispatch():\n    ...\n" },
			pyTmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("dispatch");
		expect(out?.block).toContain("26");
	});

	it("allows a simple Python function (cyc <= 25)", () => {
		pythonMock.mockReturnValue([pyEntry("simple", 4)]);
		const out = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "simple.py"), content: "def simple():\n    return 1\n" },
			pyTmp,
		);
		expect(out).toBeNull();
	});

	it("boundary: cyclomatic exactly 25 is allowed, 26 is blocked", () => {
		// 25 — at the cap, not over → allowed.
		pythonMock.mockReturnValue([pyEntry("atcap", DEFAULT_MAX_CYCLOMATIC)]);
		expect(
			checkFunctionComplexityWrite(
				{ file_path: join(pyTmp, "atcap.py"), content: "def atcap():\n    ...\n" },
				pyTmp,
			),
		).toBeNull();

		// 26 — one over the cap → blocked (file did not exist before → empty before).
		pythonMock.mockImplementation((content: string) =>
			content.trim() === "" ? [] : [pyEntry("over", DEFAULT_MAX_CYCLOMATIC + 1)],
		);
		const blocked = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "over.py"), content: "def over():\n    ...\n" },
			pyTmp,
		);
		expect(blocked?.block).toContain("cyclomatic");
		expect(blocked?.block).toContain("over");
	});

	it("radon unavailable → LOUD degrade to stderr, NOT a silent pass and NOT a false block", () => {
		// Reset the once-per-process latch so the warning fires regardless of which
		// earlier test already tripped it.
		__resetPythonDegradeWarningForTesting();
		// null = the analyzer-unavailable signal (radon not on PATH).
		pythonMock.mockReturnValue(null);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const out = checkFunctionComplexityWrite(
				{ file_path: join(pyTmp, "noradon.py"), content: "def f():\n    ...\n" },
				pyTmp,
			);
			expect(out).toBeNull(); // fail OPEN — never a false block
			// LOUD: a degrade warning naming radon was written to stderr (not silent).
			const wrote = stderrSpy.mock.calls.some(
				(c) => typeof c[0] === "string" && c[0].includes("radon"),
			);
			expect(wrote).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("allows holding an already-over-cap Python function (refactor-down / delta)", () => {
		const file = join(pyTmp, "legacy.py");
		writeFileSync(file, "def legacy():\n    ...\n");
		// before AND after both report the same over-cap function → held, allowed.
		pythonMock.mockReturnValue([pyEntry("legacy", 40)]);
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "...", new_string: "pass" },
			pyTmp,
		);
		expect(out).toBeNull();
	});

	it("skips a non-code extension (.md) without invoking any analyzer", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "notes.md"), content: "def looks_like_code(): ...\n" },
			pyTmp,
		);
		expect(out).toBeNull();
		expect(pythonMock).not.toHaveBeenCalled();
	});
});
