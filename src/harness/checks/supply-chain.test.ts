// Tests for supply-chain checks. Primary focus here is the typosquat
// allowlist — legitimate dev tools whose short names sit at Levenshtein ≤2
// from a popular package were firing on every package.json edit before
// `KNOWN_LEGITIMATE_PACKAGES` and `ALLOWLISTED_SCOPES` shipped.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTyposquatDependencies } from "./supply-chain.js";
import { nonNull } from "../../lib/non-null.js";

describe("checkTyposquatDependencies — allowlist", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-allowlist-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does NOT flag tsup (distance 2 from popular 'yup')", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { tsup: "^8.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag tsx (distance 2 from popular 'ws')", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { tsx: "^4.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag vitest (allowlisted, also in POPULAR_PACKAGES)", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag a mixed package.json of legit dev tools", () => {
		// Mirrors what interlinked-cli's own package.json looks like when
		// only the `version` field is bumped. This was the original bug.
		writeFileSync(
			pkgPath,
			JSON.stringify({
				name: "interlinked-cli",
				version: "0.1.1",
				dependencies: { commander: "^12.0.0" },
				devDependencies: {
					"@types/node": "^20.0.0",
					tsup: "^8.0.0",
					tsx: "^4.0.0",
					typescript: "^5.5.0",
					vitest: "^3.0.0",
				},
			}),
		);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag scoped orgs (e.g. @types/*, @typescript-eslint/*)", () => {
		writeFileSync(
			pkgPath,
			JSON.stringify({
				devDependencies: {
					"@types/node": "^20.0.0",
					"@typescript-eslint/parser": "^7.0.0",
					"@vitest/coverage-v8": "^3.0.0",
				},
			}),
		);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("STILL flags a real typosquat ('chlk' → 'chalk')", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { chlk: "^5.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("chlk");
		expect(nonNull(matches[0]).text).toContain("chalk");
	});

	it("STILL flags 'expresss' (classic duplicate-letter typosquat)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { expresss: "^4.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("expresss");
		expect(nonNull(matches[0]).text).toContain("express");
	});

	it("STILL flags 'typescirpt' (transposition typosquat)", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { typescirpt: "^5.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("typescript");
	});
});

describe("checkTyposquatDependencies — JSON-loaded allowlist", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-data-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does NOT flag 'jose' (distance 2 from popular 'jest') — the user-reported FP", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { jose: "^5.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag 'effect' (FP library, distance to popular)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { effect: "^3.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});

	it("does NOT flag 'jiti' (unjs ecosystem)", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { jiti: "^2.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});

	it("does NOT flag 'vuex' (Vue ecosystem)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { vuex: "^4.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});
});
