// Isolated file (own hoisted `vi.mock`, single test) for the
// `typeof candidate !== "function"` guard inside `runPublint`. See
// `package-json-publint-not-object.test.ts` for why this needs its own file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

// The mocked module IS an object, but its `publint` export is not callable.
vi.mock("publint", () => ({ publint: "not-a-function" }));

const FULL_PKG = { name: "my-pkg", version: "1.0.0", homepage: "https://example.com" };

let tmp = "";
let pkgPath = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pjpi-publint-nofn-"));
	writeFileSync(join(tmp, "package-lock.json"), "{}");
	pkgPath = join(tmp, "package.json");
	writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkPackageJsonPublishInvariantsWithPublint — mocked publint export is not a function", () => {
	it("degrades to base findings only (runPublint returns null on the typeof guard)", async () => {
		const { checkPackageJsonPublishInvariantsWithPublint } = await import("./package-json.js");
		const { homepage: _homepage, ...postEdit } = FULL_PKG;
		void _homepage;
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(postEdit),
			pkgPath,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("`homepage`");
	});
});
