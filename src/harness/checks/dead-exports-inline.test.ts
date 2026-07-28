import { describe, expect, it } from "vitest";
import { findDeadExports } from "./dead-exports-inline.js";

/**
 * Regression corpus from a live FP report (mcp-client-bio, 2026-07-28): the
 * detector flagged `describeUpstreamError` (imported by two sibling files),
 * and `registerSearch` / `registerGeneLookup` (consumed by the package entry
 * point) as unused. Root causes covered here: `.js` ESM specifiers not lining
 * up with `.ts` sources, re-export barrels not counting as consumption, and —
 * the umbrella — flagging EVERYTHING when the resolver produced no evidence.
 */
function repo(files: Record<string, string>) {
	return {
		listFiles: () => Object.keys(files),
		readFile: (p: string) => files[p] ?? null,
	};
}

const args = (file: string, content: string, cwd = "/repo") => ({
	content,
	filePath: file,
	cwd,
});

describe("findDeadExports — positive (must fire)", () => {
	it("P1: flags an export nothing imports, when resolution is proven working", () => {
		// `used` is imported (proving the resolver works for this pair); `dead`
		// is not — only `dead` may fire.
		const files = {
			"src/lib.ts": "export const used = 1;\nexport const dead = 2;\n",
			"src/main.ts": 'import { used } from "./lib.js";\nconsole.log(used);\n',
		};
		const out = findDeadExports(args("src/lib.ts", files["src/lib.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});
});

describe("findDeadExports — negative (must not fire)", () => {
	it("N1: a sibling importing via a .js ESM specifier counts (the upstream-error case)", () => {
		const files = {
			"src/lib/upstream-error.ts":
				"export function describeUpstreamError(): string {\n\treturn 'x';\n}\n",
			"src/tools/gene-lookup.ts":
				'import { describeUpstreamError } from "../lib/upstream-error.js";\ndescribeUpstreamError();\n',
		};
		const out = findDeadExports(
			args("src/lib/upstream-error.ts", files["src/lib/upstream-error.ts"]),
			repo(files),
		);
		expect(out).toEqual([]);
	});

	it("N2: a named re-export barrel counts as consumption (the registerSearch case)", () => {
		const files = {
			"src/tools/search.ts": "export function registerSearch(): void {}\n",
			"src/index.ts": 'export { registerSearch } from "./tools/search.js";\n',
		};
		const out = findDeadExports(args("src/tools/search.ts", files["src/tools/search.ts"]), repo(files));
		expect(out).toEqual([]);
	});

	it("N3: a wildcard re-export makes every export potentially consumed", () => {
		const files = {
			"src/api.ts": "export const a = 1;\nexport const b = 2;\n",
			"src/index.ts": 'export * from "./api.js";\n',
		};
		expect(findDeadExports(args("src/api.ts", files["src/api.ts"]), repo(files))).toEqual([]);
	});

	it("N4: EVIDENCE GUARD — mentioned by other files but zero edges resolve ⇒ silent", () => {
		// The umbrella failure: the module's name appears in imports the resolver
		// cannot line up (path aliases, unusual layouts). Flagging every export in
		// that state is how one resolver gap became a page of false debt. A
		// heuristic with no evidence must say nothing.
		const files = {
			"src/thing.ts": "export const x = 1;\nexport const y = 2;\n",
			"src/user.ts": 'import { x } from "@aliased/thing";\nconsole.log(x);\n',
		};
		expect(findDeadExports(args("src/thing.ts", files["src/thing.ts"]), repo(files))).toEqual([]);
	});

	it("N5: a file mentioned by NOBODY still reports (genuinely orphaned)", () => {
		// The guard must not swallow the true-positive shape: no other file even
		// mentions this module's basename, so absence of edges IS the evidence.
		const files = {
			"src/orphan.ts": "export const alone = 1;\n",
			"src/other.ts": "export const unrelated = 2;\n",
		};
		const out = findDeadExports(args("src/orphan.ts", files["src/orphan.ts"]), repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'alone'")]);
	});

	it("N6: barrels, tests, and d.ts files are exempt", () => {
		const files = { "src/index.ts": "export const a = 1;\n" };
		expect(findDeadExports(args("src/index.ts", files["src/index.ts"]), repo(files))).toEqual([]);
		expect(findDeadExports(args("src/a.test.ts", "export const t = 1;\n"), repo({}))).toEqual([]);
		expect(findDeadExports(args("src/a.d.ts", "export const d: number;\n"), repo({}))).toEqual([]);
	});
});
