import { describe, expect, it } from "vitest";
import {
	CONFIG_FILE_ENTRIES,
	LOCKFILE_TO_PACKAGE_MANAGER,
	PACKAGE_ENTRIES,
} from "./decision-surface-map.js";

// ===========================================
// Direct data-table assertions
// ===========================================
// decision-surface-map.ts is pure data: two `Record<string, ToolEntry>`
// literals with no functions or branches. decision-surface.test.ts already
// exercises a representative subset of these entries *indirectly*, through
// `detectDecisionSurface()` — but that path only proves a mutated entry's
// fields are wrong when the mutation changes the DETECTOR'S OUTPUT, and a
// handful of entries never flow into any of those fixtures at all (e.g.
// nothing in decision-surface.test.ts ever references "webpack", "rollup",
// "mocha.config", or 8 of the 9 eslint config-file basenames).
//
// These tests assert every entry's `canonical` and `categories` fields
// exactly, per key, independent of the detector. A mutation of any one
// field of any one entry is caught by that entry's own assertion here —
// Record property reads don't interact, so there is no way for a mutation
// to hide behind another entry's correctness (unlike the detector path,
// where a config-file signal can be silently masked by an identical
// package.json signal already present in the same fixture — see the
// CONFIG_FILE_ENTRIES["vitest.config.ts"] case below).

// --- PACKAGE_ENTRIES (positive — must match exactly) ---

const PACKAGE_ENTRY_CASES: Array<[key: string, canonical: string, categories: string[]]> = [
	// test_framework
	["vitest", "vitest", ["test_framework"]],
	["jest", "jest", ["test_framework"]],
	["mocha", "mocha", ["test_framework"]],
	["ava", "ava", ["test_framework"]],
	["tap", "tap", ["test_framework"]],
	["@japa/runner", "japa", ["test_framework"]],
	["jasmine", "jasmine", ["test_framework"]],
	["qunit", "qunit", ["test_framework"]],
	// linter
	["eslint", "eslint", ["linter"]],
	["oxlint", "oxlint", ["linter"]],
	["xo", "xo", ["linter"]],
	["standard", "standard", ["linter"]],
	// formatter
	["prettier", "prettier", ["formatter"]],
	["dprint", "dprint", ["formatter"]],
	// linter + formatter (dual-role)
	["@biomejs/biome", "biome", ["linter", "formatter"]],
	["rome", "rome", ["linter", "formatter"]],
	// bundler
	["vite", "vite", ["bundler"]],
	["webpack", "webpack", ["bundler"]],
	["rollup", "rollup", ["bundler"]],
	["esbuild", "esbuild", ["bundler"]],
	["tsup", "tsup", ["bundler"]],
	["parcel", "parcel", ["bundler"]],
	["browserify", "browserify", ["bundler"]],
	["snowpack", "snowpack", ["bundler"]],
	// http_client
	["axios", "axios", ["http_client"]],
	["got", "got", ["http_client"]],
	["ky", "ky", ["http_client"]],
	["node-fetch", "node-fetch", ["http_client"]],
	["undici", "undici", ["http_client"]],
	["superagent", "superagent", ["http_client"]],
	["isomorphic-fetch", "isomorphic-fetch", ["http_client"]],
	["cross-fetch", "cross-fetch", ["http_client"]],
	["request", "request", ["http_client"]],
	// date_lib
	["moment", "moment", ["date_lib"]],
	["dayjs", "dayjs", ["date_lib"]],
	["date-fns", "date-fns", ["date_lib"]],
	["luxon", "luxon", ["date_lib"]],
	["@js-joda/core", "js-joda", ["date_lib"]],
];

// --- CONFIG_FILE_ENTRIES (positive — must match exactly) ---

const CONFIG_FILE_ENTRY_CASES: Array<[key: string, canonical: string, categories: string[]]> = [
	// vitest
	["vitest.config.ts", "vitest", ["test_framework"]],
	["vitest.config.js", "vitest", ["test_framework"]],
	["vitest.config.mjs", "vitest", ["test_framework"]],
	["vitest.config.mts", "vitest", ["test_framework"]],
	// jest
	["jest.config.ts", "jest", ["test_framework"]],
	["jest.config.js", "jest", ["test_framework"]],
	["jest.config.mjs", "jest", ["test_framework"]],
	["jest.config.cjs", "jest", ["test_framework"]],
	// mocha
	[".mocharc.json", "mocha", ["test_framework"]],
	[".mocharc.js", "mocha", ["test_framework"]],
	[".mocharc.cjs", "mocha", ["test_framework"]],
	[".mocharc.yml", "mocha", ["test_framework"]],
	[".mocharc.yaml", "mocha", ["test_framework"]],
	// ava
	["ava.config.js", "ava", ["test_framework"]],
	["ava.config.cjs", "ava", ["test_framework"]],
	// eslint
	[".eslintrc", "eslint", ["linter"]],
	[".eslintrc.json", "eslint", ["linter"]],
	[".eslintrc.js", "eslint", ["linter"]],
	[".eslintrc.cjs", "eslint", ["linter"]],
	[".eslintrc.yml", "eslint", ["linter"]],
	[".eslintrc.yaml", "eslint", ["linter"]],
	["eslint.config.js", "eslint", ["linter"]],
	["eslint.config.mjs", "eslint", ["linter"]],
	["eslint.config.ts", "eslint", ["linter"]],
	// biome (dual)
	["biome.json", "biome", ["linter", "formatter"]],
	["biome.jsonc", "biome", ["linter", "formatter"]],
	// prettier
	[".prettierrc", "prettier", ["formatter"]],
	[".prettierrc.json", "prettier", ["formatter"]],
	[".prettierrc.js", "prettier", ["formatter"]],
	[".prettierrc.cjs", "prettier", ["formatter"]],
	[".prettierrc.yaml", "prettier", ["formatter"]],
	[".prettierrc.yml", "prettier", ["formatter"]],
	["prettier.config.js", "prettier", ["formatter"]],
	["prettier.config.cjs", "prettier", ["formatter"]],
	["prettier.config.mjs", "prettier", ["formatter"]],
	// dprint
	["dprint.json", "dprint", ["formatter"]],
	["dprint.jsonc", "dprint", ["formatter"]],
	// bundlers
	["vite.config.ts", "vite", ["bundler"]],
	["vite.config.js", "vite", ["bundler"]],
	["vite.config.mjs", "vite", ["bundler"]],
	["webpack.config.js", "webpack", ["bundler"]],
	["webpack.config.ts", "webpack", ["bundler"]],
	["webpack.config.cjs", "webpack", ["bundler"]],
	["rollup.config.js", "rollup", ["bundler"]],
	["rollup.config.mjs", "rollup", ["bundler"]],
	["rollup.config.ts", "rollup", ["bundler"]],
	["tsup.config.ts", "tsup", ["bundler"]],
	["tsup.config.js", "tsup", ["bundler"]],
	["esbuild.config.js", "esbuild", ["bundler"]],
	["parcel.config.js", "parcel", ["bundler"]],
];

describe("PACKAGE_ENTRIES — exact canonical + categories per key (positive)", () => {
	it(`covers every key exactly once (${PACKAGE_ENTRY_CASES.length} entries)`, () => {
		const caseKeys = PACKAGE_ENTRY_CASES.map(([key]) => key).sort();
		expect(caseKeys).toEqual(Object.keys(PACKAGE_ENTRIES).sort());
	});

	it.each(PACKAGE_ENTRY_CASES)("%s → canonical %j, categories %j", (key, canonical, categories) => {
		const entry = PACKAGE_ENTRIES[key];
		expect(entry).toBeDefined();
		expect(entry?.canonical).toBe(canonical);
		expect(entry?.categories).toEqual(categories);
	});
});

describe("CONFIG_FILE_ENTRIES — exact canonical + categories per key (positive)", () => {
	it(`covers every key exactly once (${CONFIG_FILE_ENTRY_CASES.length} entries)`, () => {
		const caseKeys = CONFIG_FILE_ENTRY_CASES.map(([key]) => key).sort();
		expect(caseKeys).toEqual(Object.keys(CONFIG_FILE_ENTRIES).sort());
	});

	it.each(CONFIG_FILE_ENTRY_CASES)(
		"%s → canonical %j, categories %j",
		(key, canonical, categories) => {
			const entry = CONFIG_FILE_ENTRIES[key];
			expect(entry).toBeDefined();
			expect(entry?.canonical).toBe(canonical);
			expect(entry?.categories).toEqual(categories);
		},
	);
});

describe("PACKAGE_ENTRIES / CONFIG_FILE_ENTRIES — unknown keys (negative)", () => {
	it("a name that is not a tracked npm package resolves to undefined", () => {
		expect(PACKAGE_ENTRIES.react).toBeUndefined();
		expect(PACKAGE_ENTRIES.lodash).toBeUndefined();
		expect(PACKAGE_ENTRIES["@types/jest"]).toBeUndefined();
	});

	it("a filename that is not a tracked config basename resolves to undefined", () => {
		expect(CONFIG_FILE_ENTRIES["tsconfig.json"]).toBeUndefined();
		expect(CONFIG_FILE_ENTRIES["package.json"]).toBeUndefined();
		expect(CONFIG_FILE_ENTRIES["README.md"]).toBeUndefined();
	});
});

// ===========================================
// LOCKFILE_TO_PACKAGE_MANAGER
// ===========================================
// Already fully exercised (all 5 keys, exact canonical manager names) via
// detectLockfileMultiplicity in decision-surface.test.ts — no survivors
// against this record in the kill-brief. Kept here as a direct, colocated
// completeness check since it's the third exported table in this module.

describe("LOCKFILE_TO_PACKAGE_MANAGER — exact per-key manager name (positive)", () => {
	it("maps every lockfile basename to its exact canonical manager name", () => {
		expect(LOCKFILE_TO_PACKAGE_MANAGER).toEqual({
			"package-lock.json": "npm",
			"yarn.lock": "yarn",
			"pnpm-lock.yaml": "pnpm",
			"bun.lockb": "bun",
			"bun.lock": "bun",
		});
	});
});
