// Mutation-kill supplement for `package-json.ts`. Each case targets one or
// more specific surviving mutants from `.interlinked/mutation-manifest.json`
// (file: src/harness/checks/package-json.ts) that the existing companion
// suites (`package-json.test.ts`, `package-json-publint*.test.ts`) already
// exercise the surrounding code path for, but without an assertion precise
// enough to distinguish the mutated behavior. See those files for the
// general-behavior tests; this file exists purely to close mutation gaps.
//
// Same strategy as `package-json.test.ts`: real tmp directories, no fs
// mocking — the tree-root / node_modules gating is load-bearing and would be
// hidden by a mock.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkPackageJsonPublishInvariants, checkPackageJsonScriptPaths } from "./package-json.js";

describe("checkPackageJsonPublishInvariants — mutation-kill", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjpi-mk-"));
		writeFileSync(join(tmp, "package-lock.json"), "{}");
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — isPresent(null) must read as "not present"
	// (isPresent, L109: `value === null` -> `false`). A pre-edit field
	// holding explicit JSON `null` must not be reported as a lost field.
	it("a pre-edit field that is explicit JSON null is NOT 'present' (no finding when post-edit lacks it)", () => {
		const pre = { name: "my-pkg", version: "1.0.0", license: "MIT", homepage: null };
		writeFileSync(pkgPath, JSON.stringify(pre));

		const postEdit = { name: "my-pkg", version: "1.0.0", license: "MIT" };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), pkgPath);
		expect(findings).toEqual([]);
	});

	// test-contract: boundary — isolates the node_modules skip-guard (L179,
	// `||`->`&&` and whole-condition->`false`) from the tree-root guard: this
	// nested fixture gets its own lockfile so ONLY the node_modules guard can
	// produce the empty result.
	it("the node_modules skip-guard fires on its own, independent of the tree-root guard", () => {
		const nmDir = join(tmp, "node_modules", "foo");
		mkdirSync(nmDir, { recursive: true });
		writeFileSync(join(nmDir, "package-lock.json"), "{}");
		const nmPkgPath = join(nmDir, "package.json");
		const pre = { name: "foo", version: "1.0.0", license: "MIT" };
		writeFileSync(nmPkgPath, JSON.stringify(pre));

		const postEdit = { name: "foo", version: "1.0.0" }; // license removed
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), nmPkgPath);
		expect(findings).toEqual([]);
	});

	// test-contract: invariant — findLineOfField must report the REAL source
	// line, not the `|| 1` fallback (kills L206 split, the L212 `X || 1`
	// trio, and all 8 findLineOfField-body mutants at L236-239). The removed
	// field "type" coincidentally reappears as `repository.type`'s key.
	it("computes the exact post-edit line number when the removed field's name coincidentally reappears as a nested key", () => {
		const pre = {
			name: "x",
			version: "1.0.0",
			type: "module",
			repository: { type: "git", url: "https://example.com/repo.git" },
		};
		writeFileSync(pkgPath, JSON.stringify(pre));

		const post = {
			name: "x",
			version: "1.0.0",
			repository: { type: "git", url: "https://example.com/repo.git" },
		};
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(post, null, 2), pkgPath);

		expect(findings).toHaveLength(1);
		const typeFinding = nonNull(findings[0]);
		expect(typeFinding.text).toContain("`type`");
		// Pretty-printed post content:
		// 1 {                                        5     "type": "git",
		// 2   "name": "x",                            6     "url": "..."
		// 3   "version": "1.0.0",                      7   }
		// 4   "repository": {                          8 }
		expect(typeFinding.line).toBe(5);
	});

	// test-contract: invariant — kills the SCRIPT_FIELDS call site's
	// own `X || 1` trio at L223 (->true/->false/->&&). This is a DIFFERENT
	// AST call-site than the TOP_LEVEL_FIELDS one above (Stryker mutates each
	// call expression independently), so it needs its own real-match case.
	it("computes the exact post-edit line number for a removed scripts.prepublishOnly finding", () => {
		const pre = {
			name: "x",
			version: "1.0.0",
			scripts: { build: "tsc", prepublishOnly: "npm test" },
			note: { prepublishOnly: "see scripts" },
		};
		writeFileSync(pkgPath, JSON.stringify(pre));

		const post = {
			name: "x",
			version: "1.0.0",
			scripts: { build: "tsc" },
			note: { prepublishOnly: "see scripts" },
		};
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(post, null, 2), pkgPath);

		expect(findings).toHaveLength(1);
		const finding = nonNull(findings[0]);
		expect(finding.text).toContain("scripts.prepublishOnly");
		// Pretty-printed post content line 8 is `    "prepublishOnly": "see scripts"`
		// inside the unrelated `note` object — the only place the exact quoted
		// key text survives post-edit, since scripts.prepublishOnly itself was
		// removed.
		expect(finding.line).toBe(8);
	});
});

describe("checkPackageJsonScriptPaths — mutation-kill", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjsp-mk-"));
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — kills RUNTIME_FILE_REF's first
	// `\s+` -> `\s` mutant. A single required whitespace char can't match two
	// spaces, so the mutant fails to extract the ref at all.
	it("a doubled space after the runtime name still matches (regex needs `\\s+`, not `\\s`)", () => {
		const content = JSON.stringify({
			scripts: { run: "node  ./missing-double-space.mjs" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("missing-double-space.mjs");
	});

	// test-contract: boundary — kills TSC_PROJECT_REF's two `\s+`
	// -> `\s` mutants (before and after the -p/--project flag) with one
	// script each, isolating which side of the flag lost its `+`.
	it("a doubled space around `tsc -p` still matches on both sides of the flag", () => {
		const content = JSON.stringify({
			scripts: {
				a: "tsc  -p tsconfig.a.json",
				b: "tsc -p  tsconfig.b.json",
			},
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(2);
		expect(findings.some((f) => f.text.includes("tsconfig.a.json"))).toBe(true);
		expect(findings.some((f) => f.text.includes("tsconfig.b.json"))).toBe(true);
	});

	// test-contract: boundary — kills CONFIG_FLAG_REF's `(?:^|\s)` ->
	// `(?:\s)` mutant (drops the start-of-string alternative). A script value
	// that begins with `--config` (nothing before it) only matches via `^`.
	it("`--config` at the very start of a script value (no leading whitespace) still matches", () => {
		const content = JSON.stringify({
			scripts: { test: "--config vitest.config.ts" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("vitest.config.ts");
	});

	// test-contract: boundary — kills CONFIG_FLAG_REF's `\s+` ->
	// `\s` mutant (between the flag and the path).
	it("a doubled space before the --config path still matches", () => {
		const content = JSON.stringify({
			scripts: { test: "vitest --config  vitest.config.ts" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("vitest.config.ts");
	});

	// test-contract: boundary — kills the `basename(filePath) !==
	// PACKAGE_JSON_BASENAME` -> `false` mutant (L328). Without the guard,
	// the function would happily scan a `package.json.bak`'s scripts too.
	it("does not scan scripts for a file that isn't literally named package.json", () => {
		const content = JSON.stringify({
			scripts: { run: "node ./definitely-missing-basename-guard.mjs" },
		});
		const findings = checkPackageJsonScriptPaths(content, join(tmp, "package.json.bak"));
		expect(findings).toEqual([]);
	});

	// test-contract: public-api — checkPackageJsonScriptPaths's returned
	// `.line` must be the real source line (kills L339/L352/L354 mutants
	// that collapse it to a fallback of 1 or 0 instead).
	it("attributes a missing-script finding to its exact source line, not a coincidental fallback", () => {
		const content = JSON.stringify(
			{
				name: "x",
				version: "1.0.0",
				scripts: { build: "tsc", run: "node ./scripts/missing-for-line-test.mjs" },
			},
			null,
			2,
		);
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		const finding = nonNull(findings[0]);
		expect(finding.text).toContain("scripts.run");
		// Pretty-printed content line 6 is
		// `    "run": "node ./scripts/missing-for-line-test.mjs"`.
		expect(finding.line).toBe(6);
	});
});
