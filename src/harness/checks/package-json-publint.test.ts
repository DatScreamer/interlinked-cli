// Tests for the `publint` dynamic-import path inside
// `checkPackageJsonPublishInvariantsWithPublint` / `runPublint`. Isolated into
// its own file (rather than `package-json.test.ts`) because `vi.mock` is
// hoisted file-wide — mocking the `publint` module here would otherwise
// change the "publint unavailable" degrade-gracefully assertions in the
// companion file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkPackageJsonPublishInvariantsWithPublint } from "./package-json.js";

const FULL_PKG = {
	name: "my-pkg",
	version: "1.0.0",
	license: "MIT",
};

let tmp = "";
let pkgPath = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pjpi-publint-mock-"));
	writeFileSync(join(tmp, "package-lock.json"), "{}");
	pkgPath = join(tmp, "package.json");
	writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	vi.doUnmock("publint");
	vi.resetModules();
});

describe("checkPackageJsonPublishInvariantsWithPublint — publint installed", () => {
	it("appends one finding per publint error message", async () => {
		vi.doMock("publint", () => ({
			publint: vi.fn(async () => ({
				messages: [
					{ code: "IMPLICIT_INDEX_JS", type: "error", args: ["./index.js"] },
					{ code: "USE_EXPORTS", type: "warning", args: [] },
				],
			})),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("IMPLICIT_INDEX_JS");
	});

	it("returns base findings only when publint reports zero errors", async () => {
		vi.doMock("publint", () => ({
			publint: vi.fn(async () => ({ messages: [] })),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toEqual([]);
	});

	it("returns base findings when the dynamic import itself rejects", async () => {
		vi.doMock("publint", () => {
			throw new Error("simulated import failure");
		});
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toEqual([]);
	});
});

// NOTE: the "mod is not an object" and "candidate is not a function" guards
// inside `runPublint` are covered in their own dedicated single-mock files
// (`package-json-publint-not-object.test.ts`, `package-json-publint-no-fn.test.ts`)
// — a per-test `vi.doMock` against the same bare "publint" specifier inside
// one file was empirically unreliable for a plain dynamic `import(variable)`
// (branch hits didn't match the per-test mock shape), while one hoisted
// `vi.mock` per file resolved deterministically.

describe("checkPackageJsonPublishInvariantsWithPublint", () => {
	it("does not fall into the publint branch at all when the base finding is a parse error", async () => {
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			'{ "name": "x", ',
			pkgPath,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("not valid JSON");
	});

	it("skips publint when the post-edit content itself is private", async () => {
		// Pre-edit is NOT private (so we get past the pre-check), but post-edit
		// flips to private — the check must still short-circuit before publint.
		const postEdit = { ...FULL_PKG, private: true };
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(postEdit),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});
});
