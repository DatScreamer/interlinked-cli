import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkExtraneousDependencies,
	checkPhantomDependencies,
	checkSelfImport,
	findWorkspaceRootFor,
} from "./agent-safety-deps.js";

// Smoke-test coverage for the agent-safety dependency-hygiene check family.
// Deeper coverage lives in `src/harness/__tests__/generic-checks-extended-*.test.ts`
// and friends — this file satisfies the harness's per-source-file test rule
// and guards the shape of the exported check functions.

describe("agent-safety deps check surface — smoke", () => {
	it("checkSelfImport returns an array", () => {
		expect(Array.isArray(checkSelfImport("", "a.ts"))).toBe(true);
	});
});

describe("findWorkspaceRootFor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wsroot-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the immediate package dir when no workspace marker exists", () => {
		const pkgDir = join(tmp, "solo");
		mkdirSync(pkgDir);
		writeFileSync(join(pkgDir, "package.json"), "{}");
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});

	it("walks up to a parent with `workspaces` field", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(tmp);
	});

	it("walks up to a parent with `pnpm-workspace.yaml`", () => {
		writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		const pkgDir = join(tmp, "packages", "bar");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "bar" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(tmp);
	});
});

describe("checkPhantomDependencies — workspace awareness", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-ws-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("does NOT flag a dep imported only by a sibling workspace package", () => {
		// Workspace root with `workspaces` field
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);

		// packages/foo declares the dep but doesn't import it anywhere in its own dir
		const fooDir = join(tmp, "packages", "foo");
		mkdirSync(fooDir, { recursive: true });
		writeFileSync(
			join(fooDir, "package.json"),
			JSON.stringify({ name: "foo", dependencies: { "@scoped/util": "1.0.0" } }),
		);
		writeFileSync(join(fooDir, "index.ts"), "export const x = 1;\n");

		// packages/bar imports the dep — that's the cross-workspace usage that
		// the single-dir grep (pre-fix) missed.
		const barDir = join(tmp, "packages", "bar");
		mkdirSync(barDir, { recursive: true });
		writeFileSync(
			join(barDir, "package.json"),
			JSON.stringify({ name: "bar" }),
		);
		writeFileSync(
			join(barDir, "consumer.ts"),
			'import { foo } from "@scoped/util";\nconsole.log(foo);\n',
		);

		const out = checkPhantomDependencies(join(fooDir, "package.json"));
		expect(out).toEqual([]);
	});

	it("flags a dep that's nowhere in the workspace", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		const fooDir = join(tmp, "packages", "foo");
		mkdirSync(fooDir, { recursive: true });
		writeFileSync(
			join(fooDir, "package.json"),
			JSON.stringify({
				name: "foo",
				dependencies: { "totally-unused-pkg": "1.0.0" },
			}),
		);
		writeFileSync(join(fooDir, "index.ts"), "export const x = 1;\n");

		const out = checkPhantomDependencies(join(fooDir, "package.json"));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("totally-unused-pkg");
	});
});

// Characterization coverage for `checkExtraneousDependencies`, added ahead of
// a cyclomatic-complexity decomposition (fn was over the per-fn cap) so the
// refactor has a behavioral safety net. Each tmp dir gets its own
// package.json so the internal per-directory dependency cache can't leak
// state between cases.
//
// KNOWN DEFECT (verified 2026-08-01, preserved as-is — out of scope for the
// complexity decomposition): the specifier-extraction regex runs against
// `stripCommentsAndStrings(content)`, which blanks the CONTENTS of every
// quoted string to `""`/`''` (see `stripStrings` in shared-text-utils.ts).
// The `['"]([^'"]+)['"]` capture then requires at least one non-quote
// character, which the blanked specifier never has — so `fromMatch` is
// always null and the function never actually flags a real import/require
// line, regardless of whether the package is declared. Tests below assert
// the function's TRUE current behavior (always `[]` on realistic input) so
// an accidental behavior change during decomposition — e.g. reading the
// specifier from `originalLines` instead of `strippedLines`, which would
// silently "fix" this and flip these assertions — gets caught.
describe("checkExtraneousDependencies", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "extraneous-deps-"));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				dependencies: { lodash: "1.0.0", "@scope/present": "1.0.0" },
				devDependencies: { vitest: "1.0.0" },
			}),
		);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("does NOT flag a bare import for a package missing from package.json (dead-detection defect)", () => {
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag an import for a declared dependency", () => {
		const out = checkExtraneousDependencies('import _ from "lodash";\n', join(tmp, "index.ts"));
		expect(out).toEqual([]);
	});

	it("does NOT flag a missing scoped package either (same dead-detection defect)", () => {
		const out = checkExtraneousDependencies(
			'import { z } from "@scope/missing-pkg";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag a bare require() (same dead-detection defect)", () => {
		const out = checkExtraneousDependencies(
			'const x = require("not-a-real-dep");\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("returns [] for a non-JS/TS file", () => {
		const out = checkExtraneousDependencies("import not_a_real_dep\n", join(tmp, "index.py"));
		expect(out).toEqual([]);
	});

	it("returns [] for a test file", () => {
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.test.ts"),
		);
		expect(out).toEqual([]);
	});

	it("returns [] when no package.json is found within 5 levels", () => {
		// Isolated tmp tree with no package.json anywhere in its ancestry
		// (unlike `tmp`, which has one written in beforeEach). Exercises the
		// early `!pkgDeps` return — a different code path than the cases
		// above (which all find package.json but never match a specifier),
		// even though the observable output is the same empty array.
		const orphan = mkdtempSync(join(tmpdir(), "extraneous-deps-orphan-"));
		try {
			const out = checkExtraneousDependencies(
				'import foo from "not-a-real-dep";\n',
				join(orphan, "index.ts"),
			);
			expect(out).toEqual([]);
		} finally {
			rmSync(orphan, { recursive: true, force: true });
		}
	});

	it("does not throw across repeated calls in the same directory (package.json cache path)", () => {
		expect(() => {
			checkExtraneousDependencies('import a from "pkg-a";\n', join(tmp, "one.ts"));
			checkExtraneousDependencies('import b from "pkg-b";\n', join(tmp, "two.ts"));
		}).not.toThrow();
	});
});
