// Fleet R3/W6 mutation-kill wave targeting src/harness/checks/test-file-exists.ts.
// Every assertion below is an exact-observable check (toEqual full array/object
// shapes) against real mkdtemp-backed fixtures — no mocked fs, no fixed sleeps.
// Six survivors were structurally proven equivalent or left open (fs-root
// access required); see scratch/fleet-r3/receipts/test-file-exists.jsonl.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTestFileExists } from "./test-file-exists.js";

describe("checkTestFileExists — CODE_EXTS membership (mutation-kill)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ifx-codeext-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — every listed CODE_EXTS member is a recognized
	// source extension; blanking any single member (the StringLiteral
	// mutation this table targets) would wrongly exempt that one extension
	// from the missing-test finding while leaving the others unaffected.
	it.each([".js", ".tsx", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".py", ".rs", ".go", ".java"])(
		"flags a fresh %s file with no test sibling",
		(ext) => {
			const filePath = join(dir, `probe${ext}`);
			const out = checkTestFileExists(filePath);
			expect(out).toEqual([
				{
					line: 0,
					text: `no test file found (checked: probe.test${ext}, probe.spec${ext}, __tests__/)`,
				},
			]);
		},
	);
});

describe("checkTestFileExists — test-sibling naming conventions (mutation-kill)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ifx-conv-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — `foo.test.ts` beside `foo.ts` is the primary
	// documented convention; a source file with a real sibling must resolve to
	// "test file exists" (this scenario's dir/base/ext plumbing also kills
	// every mutant that corrupts the directory slice or the base/ext split).
	it("recognizes a same-directory .test sibling", () => {
		const sub = join(dir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "foo.ts"), "export const x = 1;\n");
		writeFileSync(join(sub, "foo.test.ts"), "// test\n");
		const out = checkTestFileExists(join(sub, "foo.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — `.spec.ts` is the second documented same-dir
	// convention and must be recognized on its own (no `.test.ts` present).
	it("recognizes a same-directory .spec sibling", () => {
		const sub = join(dir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "bar.ts"), "export const y = 1;\n");
		writeFileSync(join(sub, "bar.spec.ts"), "// test\n");
		const out = checkTestFileExists(join(sub, "bar.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — __tests__/foo.test.ts is the third documented
	// convention and must be recognized on its own.
	it("recognizes a __tests__/*.test sibling", () => {
		const sub = join(dir, "sub");
		const tests = join(sub, "__tests__");
		mkdirSync(tests, { recursive: true });
		writeFileSync(join(sub, "baz.ts"), "export const z = 1;\n");
		writeFileSync(join(tests, "baz.test.ts"), "// test\n");
		const out = checkTestFileExists(join(sub, "baz.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — __tests__/foo.spec.ts is the fourth
	// documented convention and must be recognized on its own.
	it("recognizes a __tests__/*.spec sibling", () => {
		const sub = join(dir, "sub");
		const tests = join(sub, "__tests__");
		mkdirSync(tests, { recursive: true });
		writeFileSync(join(sub, "qux.ts"), "export const q = 1;\n");
		writeFileSync(join(tests, "qux.spec.ts"), "// test\n");
		const out = checkTestFileExists(join(sub, "qux.ts"));
		expect(out).toEqual([]);
	});
});

describe("checkTestFileExists — python/go naming conventions (mutation-kill)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ifx-pygo-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — Python's test_<base>.py convention must be
	// recognized for a real .py source file.
	it("recognizes Python's test_<base>.py sibling", () => {
		writeFileSync(join(dir, "mod.py"), "x = 1\n");
		writeFileSync(join(dir, "test_mod.py"), "# test\n");
		const out = checkTestFileExists(join(dir, "mod.py"));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the test_<base> shape must stay scoped to
	// ext === ".py"; a .ts file with the same naming shape is real source and
	// must still be flagged via the standard 4 candidates only.
	it("does not extend the python convention to a .ts file", () => {
		writeFileSync(join(dir, "mod.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "test_mod.ts"), "// not a recognized sibling shape for .ts\n");
		const out = checkTestFileExists(join(dir, "mod.ts"));
		expect(out).toEqual([
			{ line: 0, text: "no test file found (checked: mod.test.ts, mod.spec.ts, __tests__/)" },
		]);
	});

	// test-contract: public-api — Go's <base>_test.go convention must be
	// recognized for a real .go source file.
	it("recognizes Go's <base>_test.go sibling", () => {
		writeFileSync(join(dir, "svc.go"), "package svc\n");
		writeFileSync(join(dir, "svc_test.go"), "// test\n");
		const out = checkTestFileExists(join(dir, "svc.go"));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the <base>_test shape must stay scoped to
	// ext === ".go"; a .ts file with the same naming shape must still be
	// flagged via the standard 4 candidates only.
	it("does not extend the go convention to a .ts file", () => {
		writeFileSync(join(dir, "svc2.ts"), "export const y = 1;\n");
		writeFileSync(join(dir, "svc2_test.ts"), "// not a recognized sibling shape for .ts\n");
		const out = checkTestFileExists(join(dir, "svc2.ts"));
		expect(out).toEqual([
			{ line: 0, text: "no test file found (checked: svc2.test.ts, svc2.spec.ts, __tests__/)" },
		]);
	});
});

describe("checkTestFileExists — internal gate corruption (mutation-kill)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ifx-gates-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — a file that IS itself a test file must never
	// be flagged, even when no sibling of its own exists nearby.
	it("a *.test.ts file is exempt via the isTestFile gate", () => {
		const out = checkTestFileExists(join(dir, "already.test.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a file with no extension has nothing
	// parseable; it must be skipped, not fall through with a garbage
	// base/ext split.
	it("a file with no extension is exempt via the parse-null gate", () => {
		const out = checkTestFileExists(join(dir, "Makefile"));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a bare relative filename (no directory
	// separator at all) must resolve its search directory to CWD; a real
	// sibling sitting in CWD must still be found.
	// Real chdir is the only way to exercise the "." branch — the check ends
	// in existsSync("./…"), which libuv resolves against the REAL cwd, so a
	// process.cwd() spy never reaches it. chdir throws only inside worker
	// threads (Stryker), where these two auto-skip (dry-run abort class,
	// 2026-08-17); the ordinary forks-pool suite still runs them.
	// test-contract: boundary — a bare filename (no separator) must resolve its
	// sibling search directory to CWD and find a real sibling there
	it.skipIf(!isMainThread)("a bare relative filename resolves siblings against CWD", () => {
		writeFileSync(join(dir, "solo.test.ts"), "// test\n");
		const prevCwd = process.cwd();
		try {
			process.chdir(dir);
			const out = checkTestFileExists("solo.ts");
			expect(out).toEqual([]);
		} finally {
			process.chdir(prevCwd);
		}
	});

	// test-contract: boundary — a backslash path separator must be converted
	// to a forward slash, not stripped outright, or the directory and base
	// name fuse into garbage and a real sibling is missed.
	it.skipIf(!isMainThread)("a backslash path separator is converted, not dropped", () => {
		const sub = join(dir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "win.test.ts"), "// test\n");
		const prevCwd = process.cwd();
		try {
			process.chdir(dir);
			const out = checkTestFileExists("sub\\win.ts");
			expect(out).toEqual([]);
		} finally {
			process.chdir(prevCwd);
		}
	});
});

describe("checkTestFileExists — shouldSkipPath gate corruption (mutation-kill)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ifx-skip-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — a .d.ts ambient-declaration file has nothing
	// to unit-test and must be exempt.
	it("a .d.ts file is exempt", () => {
		const out = checkTestFileExists(join(dir, "types.d.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — build/vendor output under a non-source
	// directory fragment (e.g. /dist/) must never be flagged.
	it("a file under a /dist/ directory is exempt", () => {
		const distDir = join(dir, "dist");
		mkdirSync(distDir);
		const out = checkTestFileExists(join(distDir, "bundle.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — index.ts barrel exports are exempt by
	// design (re-export files have nothing of their own to unit-test).
	it("an index.ts barrel file is exempt", () => {
		const out = checkTestFileExists(join(dir, "index.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — a tool-config file (vitest.config.ts) is
	// exempt via the config-filename gate, not the extension gate (its
	// extension is an otherwise-checked .ts).
	it("a vitest.config.ts file is exempt as a config file", () => {
		const out = checkTestFileExists(join(dir, "vitest.config.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the config-filename regex is anchored to the
	// START of the base name; a file that merely CONTAINS a config keyword
	// (not as a prefix) is real source and must still be flagged.
	it("a file that only contains 'jest' mid-name is still flagged", () => {
		const out = checkTestFileExists(join(dir, "custom-jest-helpers.ts"));
		expect(out).toEqual([
			{
				line: 0,
				text: "no test file found (checked: custom-jest-helpers.test.ts, custom-jest-helpers.spec.ts, __tests__/)",
			},
		]);
	});

	// test-contract: public-api — a non-code extension (.md) is never
	// unit-tested and must be exempt via the CODE_EXTS allowlist gate.
	it("a .md file is exempt as a non-code extension", () => {
		const out = checkTestFileExists(join(dir, "README.md"));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a bare `.ts` dotfile (nothing before the dot)
	// has no usable base name; parseFileName must treat it as unparseable
	// rather than silently splitting it into base="" / ext=".ts".
	it("a bare .ts dotfile is exempt via the hidden-file gate", () => {
		const out = checkTestFileExists(join(dir, ".ts"));
		expect(out).toEqual([]);
	});
});
