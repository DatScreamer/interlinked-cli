import { describe, expect, it } from "vitest";
import { collectLocalDeps, LOCAL_DEP_CAP } from "./local-deps.js";

/** A tiny in-memory repo: path -> content. */
function diskOf(files: Record<string, string>) {
	return (p: string) => files[p] ?? null;
}

describe("collectLocalDeps — carrying uncommitted siblings to the runner", () => {
	it("finds a direct relative import", () => {
		const disk = diskOf({
			"src/a.ts": `import { x } from "./b.js";`,
			"src/b.ts": "export const x = 1;",
		});
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("follows imports transitively — a new file may import another new file", () => {
		// This is the case that broke live: the edited file imported a new module
		// which itself imported a second new module.
		const disk = diskOf({
			"src/a.ts": `import "./b.js";`,
			"src/b.ts": `import "../lib/c.js";`,
			"lib/c.ts": "export const c = 1;",
		});
		expect(collectLocalDeps("src/a.ts", disk).sort()).toEqual(["lib/c.ts", "src/b.ts"]);
	});

	it("ignores package imports — the worktree already has node_modules", () => {
		const disk = diskOf({ "src/a.ts": `import { z } from "zod";\nimport fs from "node:fs";` });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual([]);
	});

	it("resolves a .js specifier to its .ts source, as TS ESM requires", () => {
		const disk = diskOf({ "src/a.ts": `import "./b.js";`, "src/b.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("resolves a directory import to its index file", () => {
		const disk = diskOf({ "src/a.ts": `import "./sub/index.js";`, "src/sub/index.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/sub/index.ts"]);
	});

	it("skips specifiers that resolve to nothing on disk", () => {
		const disk = diskOf({ "src/a.ts": `import "./ghost.js";` });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual([]);
	});

	it("terminates on an import cycle", () => {
		const disk = diskOf({ "src/a.ts": `import "./b.js";`, "src/b.ts": `import "./a.js";` });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("never includes the entry file itself", () => {
		const disk = diskOf({ "src/a.ts": `import "./a.js";` });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual([]);
	});

	it("stops at the cap rather than walking a whole repo into one request", () => {
		// A per-edit gate has a budget; an unbounded fan-out would blow the payload.
		const files: Record<string, string> = {};
		const n = LOCAL_DEP_CAP + 20;
		for (let i = 0; i < n; i++) files[`src/f${i}.ts`] = `import "./f${i + 1}.js";`;
		files[`src/f${n}.ts`] = "";
		expect(collectLocalDeps("src/f0.ts", diskOf(files)).length).toBe(LOCAL_DEP_CAP);
	});

	it("returns nothing when the entry file is unreadable", () => {
		expect(collectLocalDeps("src/gone.ts", () => null)).toEqual([]);
	});

	it("picks up export-from and dynamic import specifiers too", () => {
		const disk = diskOf({
			"src/a.ts": `export { y } from "./b.js";\nconst m = await import("./c.js");`,
			"src/b.ts": "",
			"src/c.ts": "",
		});
		expect(collectLocalDeps("src/a.ts", disk).sort()).toEqual(["src/b.ts", "src/c.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: a mutation run showed 29 survivors of 75 in this module.
// Each test below pins a resolution rule the suite exercised but did not check.
// ---------------------------------------------------------------------------

describe("specifier resolution — the .js-to-source rewrite", () => {
	it("rewrites every JS-ish extension TypeScript ESM emits", () => {
		// The [cm] class and the optional x are load-bearing: .mjs/.cjs/.jsx all
		// appear in real ESM specifiers and each must find its TS source.
		const cases: Array<[string, string]> = [
			["./b.js", "src/b.ts"],
			["./b.mjs", "src/b.ts"],
			["./b.cjs", "src/b.ts"],
			["./b.jsx", "src/b.ts"],
		];
		for (const [spec, expected] of cases) {
			const disk = diskOf({ "src/a.ts": `import "${spec}";`, [expected]: "" });
			expect(collectLocalDeps("src/a.ts", disk)).toEqual([expected]);
		}
	});

	it("rewrites a .js specifier to a .tsx source when that is what exists", () => {
		const disk = diskOf({ "src/a.ts": `import "./b.js";`, "src/b.tsx": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.tsx"]);
	});

	it("only rewrites the extension at the END of the specifier", () => {
		// Unanchored, "./x.js.helper" would have its inner .js rewritten and the
		// real file would never be found.
		const disk = diskOf({ "src/a.ts": `import "./b.js.helper";`, "src/b.js.helper.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.js.helper.ts"]);
	});

	it("prefers the exact path when it exists as written", () => {
		const disk = diskOf({ "src/a.ts": `import "./b.ts";`, "src/b.ts": "x" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("falls back through the extension list for a bare specifier", () => {
		const disk = diskOf({ "src/a.ts": `import "./b";`, "src/b.tsx": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.tsx"]);
	});

	it("resolves a bare directory specifier to its index file", () => {
		const disk = diskOf({ "src/a.ts": `import "./sub";`, "src/sub/index.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/sub/index.ts"]);
	});

	it("resolves a parent-relative specifier", () => {
		const disk = diskOf({ "src/deep/a.ts": `import "../b.js";`, "src/b.ts": "" });
		expect(collectLocalDeps("src/deep/a.ts", disk)).toEqual(["src/b.ts"]);
	});
});

describe("specifier scanning — which forms count", () => {
	it("picks up require() as well as import/export", () => {
		const disk = diskOf({ "src/a.ts": `const b = require("./b.js");`, "src/b.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("ignores a bare package specifier that merely contains a dot", () => {
		const disk = diskOf({ "src/a.ts": `import "lodash.merge";`, "lodash.merge.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual([]);
	});

	it("returns each dependency once even when imported repeatedly", () => {
		const disk = diskOf({ "src/a.ts": `import "./b.js";\nimport "./b.js";`, "src/b.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("keeps walking after a specifier that resolves to nothing", () => {
		// A broken import must not truncate discovery of the ones after it.
		const disk = diskOf({ "src/a.ts": `import "./ghost.js";\nimport "./b.js";`, "src/b.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});
});

describe("whitespace tolerance in specifier syntax", () => {
	it("finds a specifier written with no space after the keyword", () => {
		// `import"./b.js"` is legal and appears in compact / generated output.
		const disk = diskOf({ "src/a.ts": `import"./b.js";`, "src/b.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("finds a require with space before and inside the parens", () => {
		const disk = diskOf({ "src/a.ts": `const b = require ( "./b.js" );`, "src/b.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk)).toEqual(["src/b.ts"]);
	});

	it("resolves .mts and .cts sources, not just .ts", () => {
		const mts = diskOf({ "src/a.ts": `import "./b.js";`, "src/b.mts": "" });
		expect(collectLocalDeps("src/a.ts", mts)).toEqual(["src/b.mts"]);
		const cts = diskOf({ "src/a.ts": `import "./c";`, "src/c.cts": "" });
		expect(collectLocalDeps("src/a.ts", cts)).toEqual(["src/c.cts"]);
	});
});

describe("the cap", () => {
	it("honours a caller-supplied cap below the default", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 10; i++) files[`src/f${i}.ts`] = `import "./f${i + 1}.js";`;
		files["src/f10.ts"] = "";
		expect(collectLocalDeps("src/f0.ts", diskOf(files), 3)).toHaveLength(3);
	});

	it("returns everything when the graph is smaller than the cap", () => {
		const disk = diskOf({ "src/a.ts": `import "./b.js";`, "src/b.ts": `import "./c.js";`, "src/c.ts": "" });
		expect(collectLocalDeps("src/a.ts", disk).sort()).toEqual(["src/b.ts", "src/c.ts"]);
	});
});
