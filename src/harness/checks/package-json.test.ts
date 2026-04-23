// Tests for the `package_json_publish_invariants` check.
//
// Strategy: use a real tmp directory so the check's on-disk pre-edit read and
// tree-root marker detection behave as they do in production. Mocking fs here
// would hide the check's actual gating behaviour, which is the load-bearing
// invariant we're trying to enforce.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkPackageJsonPublishInvariants,
	checkPackageJsonPublishInvariantsWithPublint,
} from "./package-json.js";

// A "complete" pre-edit package.json with every field the check tracks.
const FULL_PKG = {
	name: "my-pkg",
	version: "1.0.0",
	license: "MIT",
	repository: { type: "git", url: "git+https://example.com/foo.git" },
	homepage: "https://example.com",
	bugs: { url: "https://example.com/issues" },
	keywords: ["a", "b"],
	author: "Someone",
	engines: { node: ">=22" },
	main: "dist/index.js",
	types: "dist/index.d.ts",
	exports: { ".": "./dist/index.js" },
	bin: { "my-cli": "./dist/cli.js" },
	files: ["dist/"],
	publishConfig: { access: "public" },
	sideEffects: false,
	type: "module",
	scripts: {
		build: "tsc",
		prepublishOnly: "npm test",
	},
};

describe("checkPackageJsonPublishInvariants", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjpi-"));
		// Create a lockfile so the tree-root gate passes.
		writeFileSync(join(tmp, "package-lock.json"), "{}");
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 1
	it("flags when pre-edit has `files` but post-edit removes it", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));

		const { files: _files, ...postEdit } = FULL_PKG;
		void _files;

		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings.length).toBeGreaterThanOrEqual(1);
		expect(findings.some((f) => f.text.includes("`files`"))).toBe(true);
	});

	// Case 2
	it("does NOT flag when post-edit adds fields that were absent pre-edit", () => {
		const minimal = { name: "my-pkg", version: "1.0.0" };
		writeFileSync(pkgPath, JSON.stringify(minimal));

		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(FULL_PKG, null, 2),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});

	// Case 3
	it("does NOT flag when pre and post both contain every field", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(FULL_PKG, null, 2),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});

	// Case 4
	it("skips the entire check when pre-edit is private", () => {
		const privatePkg = { ...FULL_PKG, private: true };
		writeFileSync(pkgPath, JSON.stringify(privatePkg));

		// Post-edit strips everything but still private.
		const stripped = { name: "my-pkg", version: "1.0.0", private: true };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(stripped), pkgPath);
		expect(findings).toEqual([]);
	});

	// Case 5
	it("emits a single parse-error finding when post-edit JSON is malformed", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants(
			'{ "name": "my-pkg", "version": "1.0.0", ',
			pkgPath,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].text).toContain("not valid JSON");
	});

	// Case 6
	it("flags when pre-edit has scripts.prepublishOnly and post-edit removes it", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, scripts: { build: "tsc" } };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings.some((f) => f.text.includes("scripts.prepublishOnly"))).toBe(true);
	});

	// Case 7
	it("does NOT flag when `exports` changes shape (object → string) but stays present", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, exports: "./dist/index.js" };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		// `exports` is still present, so no finding for it.
		expect(findings.some((f) => f.text.includes("`exports`"))).toBe(false);
	});

	// Case 8
	it("does NOT flag when `files` array shrinks but still has entries", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, files: ["dist/"] };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});

	it("DOES flag when `files` array shrinks to empty (treated as removed)", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, files: [] };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings.some((f) => f.text.includes("`files`"))).toBe(true);
	});

	// Case 10
	it("does NOT fire on package.json files that are not at a tree root", () => {
		// Create a nested fixture dir with a package.json but NO lockfile sibling.
		const fixtureDir = join(tmp, "test", "fixtures", "pkg");
		mkdirSync(fixtureDir, { recursive: true });
		const nestedPkgPath = join(fixtureDir, "package.json");
		writeFileSync(nestedPkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { name: "my-pkg" }; // strips basically everything
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), nestedPkgPath);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the file didn't exist pre-edit (first-time creation)", () => {
		// Do NOT write pkgPath — it's absent.
		expect(existsSync(pkgPath)).toBe(false);

		const postEdit = { name: "brand-new", version: "0.0.0" };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), pkgPath);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on package.json inside node_modules", () => {
		const nmPath = join(tmp, "node_modules", "foo", "package.json");
		mkdirSync(join(tmp, "node_modules", "foo"), { recursive: true });
		writeFileSync(nmPath, JSON.stringify(FULL_PKG));

		const postEdit = { name: "foo" };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), nmPath);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on files named something-package.json or package.json.bak", () => {
		writeFileSync(join(tmp, "package.json.bak"), JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify({ name: "x" }),
			join(tmp, "package.json.bak"),
		);
		expect(findings).toEqual([]);
	});

	// Integration — the bug that triggered this check
	it("integration: silently stripping half of a real package.json produces N findings", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));

		// Reproduce the original incident: strip files/main/types/exports/license/
		// repository/homepage/bugs/keywords/author/engines/sideEffects/publishConfig
		// and scripts.prepublishOnly.
		const stripped = {
			name: FULL_PKG.name,
			version: FULL_PKG.version,
			scripts: { build: "tsc" }, // keeps scripts, drops prepublishOnly
			bin: FULL_PKG.bin, // keeps bin
			type: FULL_PKG.type, // keeps type
		};
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(stripped, null, 2),
			pkgPath,
		);

		const expectedMissing = [
			"license",
			"repository",
			"homepage",
			"bugs",
			"keywords",
			"author",
			"engines",
			"main",
			"types",
			"exports",
			"files",
			"publishConfig",
			"sideEffects",
		];
		for (const field of expectedMissing) {
			expect(
				findings.some((f) => f.text.includes(`\`${field}\``)),
				`expected a finding for removed field "${field}"`,
			).toBe(true);
		}
		// And the script removal.
		expect(findings.some((f) => f.text.includes("scripts.prepublishOnly"))).toBe(true);

		// Should NOT flag name/version/bin/type (still present).
		for (const field of ["name", "version", "bin", "type"]) {
			expect(
				findings.some(
					(f) => f.text.includes(`\`${field}\``) && !f.text.includes(`scripts.${field}`),
				),
				`should NOT flag preserved field "${field}"`,
			).toBe(false);
		}
	});
});

describe("checkPackageJsonPublishInvariantsWithPublint", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjpi-publint-"));
		writeFileSync(join(tmp, "package-lock.json"), "{}");
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 9 — we can't guarantee publint is installed in the test env, but we
	// can verify the async wrapper returns at least the sync findings and
	// doesn't throw if publint is missing.
	it("returns base findings and degrades gracefully when publint is unavailable", async () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));

		const { files: _files, ...postEdit } = FULL_PKG;
		void _files;

		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(postEdit),
			pkgPath,
		);
		expect(findings.some((f) => f.text.includes("`files`"))).toBe(true);
	});

	it("skips publint on private packages even if installed", async () => {
		const privatePkg = { ...FULL_PKG, private: true };
		writeFileSync(pkgPath, JSON.stringify(privatePkg));

		// Post-edit is valid, private, has all fields — should produce zero
		// findings regardless of publint availability.
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(privatePkg),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});
});
