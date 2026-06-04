// Tests for the `tsconfig_strictness` check.
//
// Strategy: write real tsconfig files into a tmp directory so the `extends`
// chain resolution exercises the on-disk read path it does in production.
// Mocking fs here would hide the chain merge, which is the load-bearing
// invariant for the "base sets the flag, derived inherits" negative case.
//
// noUncheckedIndexedAccess is ADVISORY (never gated) — these tests assert it is
// skipped while the other four flags are still gated.
//
// Positive cases (check fires):
//   1. tsconfig with `strict: true` but missing a gated flag (exactOptionalPropertyTypes).
//   2. tsconfig missing all gated flags.
//   3. tsconfig where the `extends` chain disables a previously-enabled gated flag.
//
// Negative cases (check does NOT fire):
//   1. tsconfig with all flags explicitly `true`.
//   1b. tsconfig missing ONLY noUncheckedIndexedAccess (advisory).
//   2. Root composite tsconfig with only `references: [...]` (no compilerOptions).
//   3. tsconfig in `node_modules/` path.
//   4. tsconfig where the base sets all 5 flags and the derived inherits them.
//   5. JSONC: tsconfig with line comments + trailing commas still parses.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTsconfigStrictness } from "../tsconfig-strictness.js";

// noUncheckedIndexedAccess is ADVISORY (never gated, see the check); these four
// are the gated flags the default verify gate still demands.
const GATED_FLAGS = [
	"exactOptionalPropertyTypes",
	"noImplicitOverride",
	"noImplicitReturns",
	"noFallthroughCasesInSwitch",
] as const;

describe("checkTsconfigStrictness — positive cases", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-pos-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 1
	it("flags a missing GATED flag (exactOptionalPropertyTypes) even when `strict: true` is set", () => {
		const cfg = {
			compilerOptions: {
				strict: true,
				noUncheckedIndexedAccess: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				// exactOptionalPropertyTypes deliberately omitted
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toHaveLength(1);
		expect(findings[0].text).toContain("exactOptionalPropertyTypes");
		// Confirms the "Not covered by strict" framing is in the message.
		expect(findings[0].text).toContain("Not covered by `strict: true`");
	});

	// Case 2
	it("flags all GATED flags when tsconfig is only `strict: true` and nothing else", () => {
		const cfg = { compilerOptions: { strict: true } };
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		// The 4 gated flags are missing; noUncheckedIndexedAccess is advisory (skipped).
		expect(findings).toHaveLength(4);
		const ids = findings.map((f) => f.text);
		for (const flag of GATED_FLAGS) {
			expect(ids.some((t) => t.includes(`\`compilerOptions.${flag}\``))).toBe(true);
		}
		// The advisory flag must NOT be gated.
		expect(ids.some((t) => t.includes("noUncheckedIndexedAccess"))).toBe(false);
	});

	// Case 3 — extends chain that re-disables a flag the base had set.
	it("flags a flag re-disabled by the derived tsconfig (derived wins)", () => {
		const basePath = join(tmp, "tsconfig.base.json");
		writeFileSync(
			basePath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				},
			}),
		);

		const derived = {
			extends: "./tsconfig.base.json",
			compilerOptions: {
				// Derived explicitly disables one previously-enabled GATED flag.
				exactOptionalPropertyTypes: false,
			},
		};
		writeFileSync(configPath, JSON.stringify(derived, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(derived, null, 2), configPath);
		expect(findings).toHaveLength(1);
		expect(findings[0].text).toContain("exactOptionalPropertyTypes");
	});
});

describe("checkTsconfigStrictness — negative cases", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-neg-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 1
	it("does NOT flag a tsconfig with all 5 flags explicitly true", () => {
		const cfg = {
			compilerOptions: {
				strict: true,
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 1b — noUncheckedIndexedAccess is advisory: missing it alone must not fire.
	it("does NOT gate on a missing noUncheckedIndexedAccess (advisory flag)", () => {
		const cfg = {
			compilerOptions: {
				strict: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				// noUncheckedIndexedAccess omitted — advisory, must NOT produce a finding.
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));
		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 2
	it("does NOT flag a composite root tsconfig with only `references` and no compilerOptions", () => {
		const cfg = {
			references: [{ path: "./packages/a" }, { path: "./packages/b" }],
			files: [],
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 3
	it("does NOT fire on tsconfig.json inside node_modules", () => {
		const nmPath = join(tmp, "node_modules", "some-pkg", "tsconfig.json");
		mkdirSync(join(tmp, "node_modules", "some-pkg"), { recursive: true });
		writeFileSync(nmPath, JSON.stringify({ compilerOptions: {} }));

		const findings = checkTsconfigStrictness(
			JSON.stringify({ compilerOptions: {} }),
			nmPath,
		);
		expect(findings).toEqual([]);
	});

	// Case 4 — extends chain inherits all five flags, derived adds nothing.
	it("does NOT flag when the base tsconfig already sets every required flag", () => {
		const basePath = join(tmp, "tsconfig.base.json");
		writeFileSync(
			basePath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				},
			}),
		);
		const derived = {
			extends: "./tsconfig.base.json",
			compilerOptions: { outDir: "./dist" },
		};
		writeFileSync(configPath, JSON.stringify(derived, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(derived, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 5 — JSONC tolerance (comments + trailing commas).
	it("parses tsconfig with line comments and trailing commas (JSONC)", () => {
		const jsonc = [
			"// Top-level comment",
			"{",
			'  "compilerOptions": {',
			'    "strict": true,',
			'    "noUncheckedIndexedAccess": true,',
			'    "exactOptionalPropertyTypes": true,',
			'    "noImplicitOverride": true,',
			'    "noImplicitReturns": true,',
			'    "noFallthroughCasesInSwitch": true, // trailing flag',
			"  },",
			"}",
		].join("\n");
		writeFileSync(configPath, jsonc);

		const findings = checkTsconfigStrictness(jsonc, configPath);
		expect(findings).toEqual([]);
	});

	// Case 6 — non-tsconfig basenames are skipped.
	it("does NOT fire on package.json or other .json files", () => {
		const pkgPath = join(tmp, "package.json");
		const pkgContent = JSON.stringify({ name: "foo", compilerOptions: {} });
		writeFileSync(pkgPath, pkgContent);

		const findings = checkTsconfigStrictness(pkgContent, pkgPath);
		expect(findings).toEqual([]);
	});

	// Case 7 — tsconfig.build.json variant fires the same way.
	it("fires on tsconfig.<variant>.json files (tsconfig.build.json)", () => {
		const variant = join(tmp, "tsconfig.build.json");
		const cfg = { compilerOptions: { strict: true } };
		writeFileSync(variant, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), variant);
		expect(findings).toHaveLength(4);
	});
});

describe("checkTsconfigStrictness — robustness", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-robust-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] on malformed JSON instead of throwing", () => {
		const malformed = '{ "compilerOptions": { ';
		writeFileSync(configPath, malformed);

		const findings = checkTsconfigStrictness(malformed, configPath);
		expect(findings).toEqual([]);
	});

	it("returns [] on an empty tsconfig that has neither compilerOptions nor references", () => {
		// Edge case: a fresh `{}` tsconfig. There's no `compilerOptions` and no
		// `references`, so it doesn't clearly hit either the project-list skip
		// or the strictness check — we fail open and report nothing.
		const empty = "{}";
		writeFileSync(configPath, empty);

		const findings = checkTsconfigStrictness(empty, configPath);
		// The detector reports the 4 gated flags missing (noUncheckedIndexedAccess
		// is advisory) because the merged object is empty and the file does NOT
		// match the references-only project shape.
		expect(findings).toHaveLength(4);
	});

	it("handles a broken extends path by treating the chain as ending at this file", () => {
		// `./does-not-exist.json` cannot be read; the merge collapses to the
		// derived file's own compilerOptions, which has all 5 flags.
		const cfg = {
			extends: "./does-not-exist.json",
			compilerOptions: {
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
		expect(findings).toEqual([]);
	});
});
