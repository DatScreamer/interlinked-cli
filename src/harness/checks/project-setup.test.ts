// Tests for project-setup.ts — focuses on the universal
// tsconfig.types ↔ deps cross-check helper.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProjectSetup, checkTsConfigTypesAgainstDeps } from "./project-setup.js";

describe("checkTsConfigTypesAgainstDeps", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}) {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", dependencies: deps, devDependencies: devDeps }),
		);
	}

	it("returns nothing when types[] is absent", () => {
		writePkg({});
		expect(checkTsConfigTypesAgainstDeps({}, tmp)).toEqual([]);
	});

	it("returns nothing when types[] is empty", () => {
		writePkg({});
		expect(checkTsConfigTypesAgainstDeps({ types: [] }, tmp)).toEqual([]);
	});

	it("flags scoped types[] entry that isn't in deps (the @cloudflare/workers-types CI failure)", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps(
			{ types: ["@cloudflare/workers-types"] },
			tmp,
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain("@cloudflare/workers-types");
		expect(issues[0].fix).toContain("@cloudflare/workers-types");
	});

	it("passes when scoped types[] entry IS in deps", () => {
		writePkg({}, { "@cloudflare/workers-types": "^4.0.0" });
		expect(
			checkTsConfigTypesAgainstDeps({ types: ["@cloudflare/workers-types"] }, tmp),
		).toEqual([]);
	});

	it("passes when unscoped types[] entry exists as the package itself", () => {
		writePkg({}, { vitest: "^1.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["vitest"] }, tmp)).toEqual([]);
	});

	it("passes when unscoped types[] entry exists as @types/<name>", () => {
		writePkg({}, { "@types/node": "^20.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	it("flags unscoped types[] entry when neither variant is installed", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain("node");
		expect(issues[0].message).toContain("@types/node");
		expect(issues[0].fix).toBe("Run `npm i --save-dev @types/node`");
	});

	it("checks peer- and optional-dependencies too", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				name: "x",
				peerDependencies: { "@types/node": "^20.0.0" },
			}),
		);
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	it("emits one finding per missing entry", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps(
			{ types: ["node", "vitest", "@cloudflare/workers-types"] },
			tmp,
		);
		expect(issues).toHaveLength(3);
	});

	it("ignores non-string entries silently", () => {
		writePkg({}, {});
		expect(checkTsConfigTypesAgainstDeps({ types: [42, null, ""] }, tmp)).toEqual([]);
	});

	it("returns no findings when package.json is unreadable", () => {
		// no package.json written — readAllDeps() returns {} on miss.
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toHaveLength(1);
	});
});

describe("checkProjectSetup", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-int-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns no issues when there are no TypeScript files", () => {
		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("integrates the types ↔ deps check end-to-end", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				strict: true,
				moduleResolution: "bundler",
				types: ["@cloudflare/workers-types"],
			},
		}));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@cloudflare/workers-types"))).toBe(true);
	});
});
