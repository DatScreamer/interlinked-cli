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

// DEFECT FIXED 2026-08-07. The specifier-extraction regex used to run against
// STRIPPED content, where quoted string CONTENTS are blanked to `""`/`''`.
// `['"]([^'"]+)['"]` requires at least one non-quote character between the
// quotes, which a blanked specifier never has — so `fromMatch` was always null
// and this detector could never flag anything, for any input. The assertions
// below were deliberately pinned to that broken behavior by an earlier session,
// precisely so an accidental "fix" would surface as a flipped assertion rather
// than landing unnoticed. That pin worked: this change is the intentional fix,
// and the assertions are flipped to the CORRECT behavior.
//
// The specifier now comes from the original line; the STRIPPED line still
// decides whether the line looks like an import at all, so a `from "..."` inside
// a comment or string literal is still ignored (see the N-cases below).
describe("checkSelfImport — positive (must fire)", () => {
	it("P1: flags a literal self-import (relative specifier matching the file's own base name)", () => {
		const out = checkSelfImport('import { x } from "./same-file";\n', "same-file.ts");
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./same-file";' }]);
	});

	it("P2: flags a self-import written with an explicit .js extension from a .ts file", () => {
		const out = checkSelfImport('import { x } from "./widget.js";\n', "widget.ts");
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./widget.js";' }]);
	});

	it("N0: does NOT flag an import of a DIFFERENT relative module", () => {
		expect(checkSelfImport('import { x } from "./other";\n', "widget.ts")).toEqual([]);
	});

	it("returns [] for a non-JS/TS extension", () => {
		const out = checkSelfImport('import x from "./thing";\n', "thing.py");
		expect(out).toEqual([]);
	});

	it("returns [] when the import specifier is not relative (bare specifier)", () => {
		const out = checkSelfImport('import x from "thing";\n', "thing.ts");
		expect(out).toEqual([]);
	});

	it("returns [] for a line that isn't an import statement at all", () => {
		const out = checkSelfImport("const x = 1;\n", "same-file.ts");
		expect(out).toEqual([]);
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

describe("_resolvePackageDeps / _loadPackageDeps — malformed package.json", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "malformed-pkg-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] (pkgDeps undefined) when the nearest package.json is not valid JSON", () => {
		writeFileSync(join(tmp, "package.json"), "{ not valid json");
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("does not throw when package.json has NO dependencies/devDependencies fields at all", () => {
		// Exercises the `|| {}` fallback for every one of the four dep-kind keys.
		writeFileSync(join(tmp, "package.json"), "{}");
		expect(() =>
			checkExtraneousDependencies('import foo from "not-a-real-dep";\n', join(tmp, "index.ts")),
		).not.toThrow();
	});

	it("reaches the filesystem root without finding a package.json (5-level walk exhausted or root hit)", () => {
		// A deep tmp subtree with no package.json anywhere in its ancestry up to
		// the filesystem root — walks past 5 levels or hits `parent === pkgDir`.
		const deep = join(tmp, "a", "b", "c", "d", "e", "f");
		mkdirSync(deep, { recursive: true });
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(deep, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	it("stops at `parent === pkgDir` when the walk reaches the filesystem root within 5 hops", () => {
		// A path one level below the filesystem root: after the first miss, the
		// second hop's `dirname("/")` is `"/"` again — `parent === pkgDir` fires.
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			"/__interlinked_agent_safety_deps_root_probe__/index.ts",
		);
		expect(out).toEqual([]);
	});

	it("N1: treats a non-object (`null`) package.json as unusable rather than reading fields off it", () => {
		writeFileSync(join(tmp, "package.json"), "null");
		expect(() =>
			checkExtraneousDependencies('import foo from "not-a-real-dep";\n', join(tmp, "index.ts")),
		).not.toThrow();
		expect(
			checkExtraneousDependencies('import foo from "not-a-real-dep";\n', join(tmp, "index.ts")),
		).toEqual([]);
	});
});

describe("findWorkspaceRootFor — parent package.json without a `workspaces` field", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wsroot-noworkspaces-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("keeps walking past a parent package.json that has no `workspaces` field", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root-no-ws" }));
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});

	it("N1: keeps walking past a parent package.json that parses to `null`", () => {
		// isJsonObject(null) is false, so `json.workspaces` is never read off a
		// non-object value — the walk treats it the same as "no workspaces field"
		// rather than relying on the surrounding catch to swallow a TypeError.
		writeFileSync(join(tmp, "package.json"), "null");
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});
});

describe("checkPhantomDependencies — early-return edge cases", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-edge-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] when the package.json path does not exist", () => {
		expect(checkPhantomDependencies(join(tmp, "nope", "package.json"))).toEqual([]);
	});

	it("returns [] when package.json is not valid JSON", () => {
		writeFileSync(join(tmp, "package.json"), "{ not valid json");
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("returns [] when `dependencies` is present but not an object (malformed field)", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: "not-an-object" }));
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("N1: does not throw when package.json parses to `null`", () => {
		// Pre-fix, `pkg.dependencies` ran AFTER the try/catch closed, so a
		// legally-parsed `null` (JSON.parse("null") === null, valid JSON)
		// threw a TypeError uncaught instead of returning [].
		writeFileSync(join(tmp, "package.json"), "null");
		expect(() => checkPhantomDependencies(join(tmp, "package.json"))).not.toThrow();
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("N2: returns [] when `dependencies` is an array instead of a keyed object", () => {
		// Pre-fix, `typeof deps !== "object"` admitted arrays (typeof [] ===
		// "object"), so Object.keys would have read back numeric-index
		// strings ("0", "1", ...) as fake dependency names.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: ["not", "an", "object"] }),
		);
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("returns [] when `dependencies` is an empty object", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: {} }));
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("skips @types/* packages (type-only, never imported at runtime)", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "@types/node": "1.0.0" } }),
		);
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		expect(checkPhantomDependencies(join(tmp, "package.json"))).toEqual([]);
	});

	it("falls back to line 1 when the phantom dep name has no literal quoted match in raw content", () => {
		// The dep name contains a unicode-escaped character in the JSON literal
		// (`é`), so the raw file text never contains the literal quoted
		// decoded name — `lines.findIndex` returns -1 and the ternary falls back
		// to line 1.
		const rawJson = '{\n  "dependencies": {\n    "caf\\u00e9-pkg": "1.0.0"\n  }\n}\n';
		writeFileSync(join(tmp, "package.json"), rawJson);
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		const out = checkPhantomDependencies(join(tmp, "package.json"));
		expect(out).toEqual([
			{
				line: 1,
				text:
					'Phantom dependency: "café-pkg" is in dependencies but never referenced in project source. Supply chain risk — dependencies should be imported somewhere.',
			},
		]);
	});
});

describe("checkPhantomDependencies — the 10-match cap", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-cap-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("stops reporting after 10 phantom dependencies even when 12 are declared and unreferenced", () => {
		const deps: Record<string, string> = {};
		for (let i = 0; i < 12; i++) deps[`phantom-pkg-${i}`] = "1.0.0";
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: deps }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		const out = checkPhantomDependencies(join(tmp, "package.json"));
		expect(out).toHaveLength(10);
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

	// Assertions flipped 2026-08-07 with the specifier-extraction fix — see the
	// note above `checkSelfImport`. These previously pinned the dead behavior.
	it("P1: flags a bare import for a package missing from package.json", () => {
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import foo from "not-a-real-dep";' }]);
	});

	it("N1: does NOT flag an import for a declared dependency", () => {
		const out = checkExtraneousDependencies('import _ from "lodash";\n', join(tmp, "index.ts"));
		expect(out).toEqual([]);
	});

	it("P2: flags a missing SCOPED package", () => {
		const out = checkExtraneousDependencies(
			'import { z } from "@scope/missing-pkg";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import { z } from "@scope/missing-pkg";' }]);
	});

	it("P3: flags a bare require() for a missing package", () => {
		const out = checkExtraneousDependencies(
			'const x = require("not-a-real-dep");\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'const x = require("not-a-real-dep");' }]);
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
