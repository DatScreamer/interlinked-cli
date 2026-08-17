// Tests for `interlinked deadcode` — the whole-repo dead-code scan verb
// (operator request 2026-08-17: per-edit detection and repo scanning are two
// separate controls; this is the scan half).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDeadCode } from "./deadcode.js";

let tmp: string;

function seed(rel: string, content: string): void {
	const abs = join(tmp, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-deadcode-"));
	seed(
		"package.json",
		JSON.stringify({ name: "fixture", bin: { fixture: "./dist/index.js" } }),
	);
	seed("src/index.ts", 'import { used } from "./a.js";\nconsole.log(used);\n');
	seed(
		"src/a.ts",
		'import { helper } from "./b.js";\nimport { neverTouched } from "./b.js";\nexport const used = helper();\n',
	);
	seed("src/b.ts", "export function helper(): number { return 1; }\nexport const neverTouched = 2;\n");
	seed("src/orphan.ts", "export const island = 1;\n");
	seed("src/orphan.test.ts", "// tests never count as importers for reachability\n");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("scanDeadCode — positive (must report)", () => {
	// test-contract: behavior — the three layers report their own finding kinds:
	// unreachable files, dead import bindings, and dead exports
	it("P1: reports the orphan file, the unused import binding, and the unused export", () => {
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).toContain("src/orphan.ts");
		const bindings = r.deadImportBindings.map((b) => `${b.file}:${b.binding}`);
		expect(bindings).toContain("src/a.ts:neverTouched");
	});
});

describe("scanDeadCode — negative (must not report)", () => {
	// test-contract: boundary — entry points resolved from package.json bin and
	// reachable/used files never appear as unreachable candidates
	it("N1: the bin entry and imported files are not unreachable candidates", () => {
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/index.ts");
		expect(r.unreachableFiles).not.toContain("src/a.ts");
		expect(r.unreachableFiles).not.toContain("src/b.ts");
	});

	it("N2: test files are excluded from the unreachable list entirely", () => {
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/orphan.test.ts");
	});

	// test-contract: bug-class — files consumed ONLY through `export … from`
	// barrels looked importerless on first landing (the graph tracks import
	// statements, not re-export edges); checks/pii.ts was the live FP
	it("N3: a file reached only via a re-export barrel is not unreachable", () => {
		seed("src/barrel.ts", 'export * from "./leaf.js";\nexport { pick } from "./leaf2.js";\n');
		seed("src/leaf.ts", "export const viaStarOnly = 1;\n");
		seed("src/leaf2.ts", "export const pick = 2;\n");
		seed("src/index2.ts", 'import { viaStarOnly } from "./barrel.js";\nconsole.log(viaStarOnly);\n');
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/leaf.ts");
		expect(r.unreachableFiles).not.toContain("src/leaf2.ts");
	});
});
