import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFuzzTargets } from "./fuzz-targets.js";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fuzz-targets-"));
	mkdirSync(join(cwd, "src", "sub"), { recursive: true });
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

describe("detectFuzzTargets", () => {
	it("finds test files that import or call fast-check", () => {
		write("src/a.test.ts", `import fc from "fast-check";\nfc.assert(fc.property());\n`);
		write("src/sub/b.test.ts", `import { fc } from "fast-check";\n`);
		const targets = detectFuzzTargets(cwd);
		expect(targets.sort()).toEqual(["src/a.test.ts", "src/sub/b.test.ts"]);
	});

	it("does NOT match a test file that merely has 'property' in its name", () => {
		write("src/property-budget.test.ts", `import { x } from "./x.js";\nexpect(x).toBe(1);\n`);
		expect(detectFuzzTargets(cwd)).toEqual([]);
	});

	it("does NOT match non-test source files even if they use fast-check", () => {
		write("src/helper.ts", `import fc from "fast-check";\n`);
		expect(detectFuzzTargets(cwd)).toEqual([]);
	});

	it("returns [] on a repo with no src or no fast-check usage", () => {
		expect(detectFuzzTargets(join(cwd, "does-not-exist"))).toEqual([]);
		write("src/plain.test.ts", `expect(1).toBe(1);\n`);
		expect(detectFuzzTargets(cwd)).toEqual([]);
	});
});
