// Survivor-kill tests for src/harness/project-graph.ts, sourced from the
// 90-survivor manifest export at scratch/fleet-r3/pg-survivors-with-ordinals.json
// (generation 751). Every fixture here is empirically verified against BOTH
// the pristine module and a dynamically-built copy carrying each survivor's
// EXACT textual mutation — see
// scratch/fleet-r3/src_harness_project-graph.ts-shadow-verify.mts (companion
// scratch script, not part of the shipped suite) for the AST-based mutant
// offset resolver, the fixtures, and the equivalence fuzz pass.
//
// 7 of the 90 survivors were proven equivalent_candidate by a 300-320-input
// fuzz pass (zero divergence) after analytical review — see the shadow-verify
// script's EQUIVALENCE_CANDIDATE_IDS / EQUIV_WHY for the reasoning (a
// redundant existsSync fast-path already covered by the same try/catch; a
// bogus placeholder array element with no `.toFile` property that a
// `for...of` loop silently no-ops on; and a "find matching entry, then
// break" loop whose downstream regex-scan outcome depends only on file
// content text, never on which array entry triggered it). Those are NOT
// re-asserted here since no observable behavior distinguishes them.
//
// Real (not mocked) temporary directories are used throughout — project-graph
// resolves import targets and tsconfig paths via real `existsSync`/`statSync`
// calls in ./project-graph/resolve.ts, so a filesystem mock would need to
// reproduce that resolution logic faithfully; real disk avoids that risk.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectGraph } from "./project-graph.js";

function makeTempRoot(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), `pg-mutkill-${prefix}-`));
}

function write(root: string, rel: string, content: string): string {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}

// ==========================================================================
// Module scope: SKIP_DIRS (37 entries + whole array), TS_JS_EXTENSIONS
// (8 entries + whole array), and the `initialized = false` field default.
// One shared read-only fixture tree — a file per SKIP_DIRS entry (proving
// it's excluded from a real scan) plus one recognized-extension file per
// TS_JS_EXTENSIONS entry (proving each is included).
// ==========================================================================
describe("module scope — SKIP_DIRS / TS_JS_EXTENSIONS / initialized default", () => {
	let root: string;
	// Mirrors the literal SKIP_DIRS array in project-graph.ts. Any entry
	// removed from the real Set (a StringLiteral -> "" mutant) makes that
	// one subdirectory's marker.ts newly discoverable; emptying the whole
	// Set (ArrayDeclaration -> []) exposes all 37 at once.
	const SKIP_DIRS = [
		"node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage",
		".wrangler", ".cache", ".turbo", "out", ".interlinked", ".claude",
		".entire", "__pycache__", ".vscode", ".idea", "reference-repos",
		"vendor", "third_party", "third-party", "external", ".venv", "venv",
		"target", ".gradle", ".svelte-kit", ".output", ".stryker-tmp",
		".nyc_output", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
		".parcel-cache", ".vite", ".astro",
	];
	const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

	beforeAll(() => {
		root = makeTempRoot("module");
		for (const dir of SKIP_DIRS) write(root, path.join(dir, "marker.ts"), "export const marker = 1;\n");
		let i = 0;
		for (const ext of EXTENSIONS) write(root, path.join("src", `f${i++}${ext}`), `export const f = ${i};\n`);
		write(root, path.join("src", "ignore.md"), "# not code\n");
		write(root, path.join("src", "ignore.json"), "{}\n");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("initialized defaults to false before any scan (constructor block survivor)", () => {
		const pg = new ProjectGraph(root);
		expect(pg.isInitialized).toBe(false);
	});

	it("a full scan indexes exactly the 8 recognized-extension files, none of the 37 skip-dirs", () => {
		const pg = new ProjectGraph(root);
		pg.initialize();
		expect(pg.isInitialized).toBe(true);
		expect(pg.fileCount).toBe(8);
		const rels = pg.allFiles().map((f) => pg.toRelative(f)).sort();
		expect(rels).toEqual(
			["f0.ts", "f1.tsx", "f2.js", "f3.jsx", "f4.mjs", "f5.cjs", "f6.mts", "f7.cts"]
				.map((n) => path.join("src", n))
				.sort(),
		);
	});

	it.each(SKIP_DIRS)("skip-dir %s is excluded from allFiles()", (dir) => {
		const pg = new ProjectGraph(root);
		pg.initialize();
		const rels = pg.allFiles().map((f) => pg.toRelative(f));
		expect(rels.some((r) => r.startsWith(`${dir}${path.sep}`))).toBe(false);
	});

	it.each(EXTENSIONS)("recognized extension %s is included in allFiles()", (ext) => {
		const pg = new ProjectGraph(root);
		pg.initialize();
		const rels = pg.allFiles().map((f) => pg.toRelative(f));
		expect(rels.some((r) => r.endsWith(ext))).toBe(true);
	});

	it("unrecognized extensions (.md, .json) are never indexed", () => {
		const pg = new ProjectGraph(root);
		pg.initialize();
		const rels = pg.allFiles().map((f) => pg.toRelative(f));
		expect(rels.some((r) => r.endsWith(".md") || r.endsWith(".json"))).toBe(false);
	});
});

describe("full scan — repository-specific ignored directories", () => {
	let root: string;

	beforeAll(() => {
		root = makeTempRoot("gitignore");
		execFileSync("git", ["init", "-q"], { cwd: root });
		write(root, ".gitignore", "ignored-output/\nscratch/*\n!scratch/README.md\n");
		write(root, "ignored-output/generated.ts", "export const ignoredOutput = 1;\n");
		write(root, "scratch/generated-1.ts", "export const generated1 = 1;\n");
		write(root, "scratch/nested/generated-2.mts", "export const generated2 = 2;\n");
		write(root, "scratch/README.md", "# Generated scratch work\n");
		write(root, "src/scratch/tracked.ts", "export const nestedScratch = 1;\n");
		write(root, "src/tracked.ts", "export const tracked = 1;\n");
		execFileSync(
			"git",
			["add", "--", ".gitignore", "scratch/README.md", "src/scratch/tracked.ts", "src/tracked.ts"],
			{ cwd: root },
		);
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("excludes ignored source trees, including root scratch with a README carve-out", () => {
		const graph = new ProjectGraph(root);
		graph.initialize();

		expect(graph.allFiles().map((file) => graph.toRelative(file))).toEqual([
			path.join("src", "scratch", "tracked.ts"),
			path.join("src", "tracked.ts"),
		]);
	});
});

// ==========================================================================
// constructor + loadTsconfigPaths: a real tsconfig.json path-alias, with a
// specifier ("@libFoo", no slash right after the alias prefix) chosen so
// resolveImportPath's `resolve(dirname(fromFile), "..", base, rest)` never
// receives a leading-slash `rest` segment — verified against real
// path.resolve semantics: a leading "/" segment is absolute and silently
// discards every argument before it, which a plain "@lib/*" -> "@app/foo"
// style specifier would trigger (a real resolve.ts quirk, out of scope for
// this file's mutants but load-bearing for constructing a fixture that
// actually resolves).
// ==========================================================================
describe("constructor + loadTsconfigPaths — real tsconfig.json alias resolution", () => {
	let root: string;
	let indexPath: string;
	const indexContent = 'import { libMarker } from "@libFoo";\nexport const indexMarker = 2;\n';

	beforeAll(() => {
		root = makeTempRoot("tsconfig");
		write(root, "libtarget/Foo.ts", "export const libMarker = 1;\n");
		write(
			root,
			"tsconfig.json",
			JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["libtarget/*"] } } }, null, 2),
		);
		indexPath = write(root, "src/index.ts", indexContent);
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("toRelative() does not throw — projectRoot was actually assigned", () => {
		const pg = new ProjectGraph(root);
		expect(() => pg.toRelative(indexPath)).not.toThrow();
		expect(pg.toRelative(indexPath)).toBe(path.join("src", "index.ts"));
	});

	it("a real tsconfig.json path alias resolves the import to the real target file", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(indexPath, indexContent);
		const deps = pg.getDependencies(indexPath);
		expect(deps).toHaveLength(1);
		expect(deps[0]?.specifier).toBe("@libFoo");
		expect(deps[0]?.toFile).not.toBe("");
	});
});

// ==========================================================================
// updateFile — the returned "old exports" on a never-before-indexed path
// exercises `this.exportIndex.get(absPath) || []`.
// ==========================================================================
describe("updateFile — old-exports return value", () => {
	let root: string;
	beforeAll(() => {
		root = makeTempRoot("updatefile");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("returns an empty array (not true/false/a placeholder) for a never-indexed path", () => {
		const pg = new ProjectGraph(root);
		const freshPath = path.join(root, "never-indexed.ts");
		const old = pg.updateFile(freshPath, "export const x = 1;\n");
		expect(old).toEqual([]);
	});

	it("returns the PRIOR exports (not [] again) on a second update of the same path", () => {
		const pg = new ProjectGraph(root);
		const p = path.join(root, "reindexed.ts");
		pg.updateFile(p, "export const x = 1;\n");
		const old = pg.updateFile(p, "export const x = 1;\nexport const y = 2;\n");
		expect(old).toEqual([expect.objectContaining({ name: "x" })]);
	});
});

// ==========================================================================
// getExports — own-export-* filtering, cycle-guard raw-direct-return
// merging, name-collision dedup, "export * as ns from" (a real named
// export sharing kind:"namespace" with the bare-star synthetic marker, but
// NOT name:"*" — isolates the name-check from the kind-check in the
// filter), and the never-indexed throw-vs-clean-return probe.
// ==========================================================================
describe("getExports — filter / cycle-guard / dedup / as-ns isolation", () => {
	let root: string;
	let f3Base: string;
	let f4X: string;
	let f2Plain: string;
	let f5Base: string;
	let f1NeverIndexed: string;

	beforeAll(() => {
		root = makeTempRoot("getexports");
		write(root, "f3-target.ts", "export const targetThing = 1;\n");
		f3Base = write(root, "f3-base.ts", "export const ownSymbol = 1;\nexport * from './f3-target';\n");
		f4X = write(root, "f4-x.ts", "export * from './f4-y';\nexport const shared = 999;\n");
		write(root, "f4-y.ts", "export * from './f4-x';\nexport const shared = 1;\n");
		f2Plain = write(root, "f2-plain.ts", "export const plainThing = 1;\n");
		write(root, "f5-nstarget.ts", "export const dummy1 = 1;\n");
		write(root, "f5-startarget.ts", "export const starTargetThing = 1;\n");
		f5Base = write(
			root,
			"f5-base.ts",
			"export * as ns from './f5-nstarget';\nexport * from './f5-startarget';\n",
		);
		f1NeverIndexed = path.join(root, "f1-never-indexed.ts");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("own export * combined with own named export: no stray \"*\" entry, star target merged in", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(path.join(root, "f3-target.ts"));
		pg.updateFile(f3Base);
		const names = pg.getExports(f3Base).map((e) => e.name).sort();
		expect(names).toEqual(["ownSymbol", "targetThing"]);
		expect(names).not.toContain("*");
	});

	it("mutual export * cycle with a name collision: own value wins, no raw \"*\" leaks through", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(f4X);
		pg.updateFile(path.join(root, "f4-y.ts"));
		const exports = pg.getExports(f4X);
		expect(exports).toEqual([expect.objectContaining({ name: "shared" })]);
	});

	it("plain file with no export *: visited-Set is untouched (early return, never reaches seen.add)", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(f2Plain);
		const mySet = new Set<string>();
		pg.getExports(f2Plain, mySet);
		expect(mySet.has(f2Plain)).toBe(false);
	});

	it('"export * as ns from" is a REAL named export, not a synthetic wildcard marker — must survive the filter', () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(path.join(root, "f5-nstarget.ts"));
		pg.updateFile(path.join(root, "f5-startarget.ts"));
		pg.updateFile(f5Base);
		const exports = pg.getExports(f5Base);
		expect(exports).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "ns", kind: "namespace" })]),
		);
		expect(exports).toEqual(expect.arrayContaining([expect.objectContaining({ name: "starTargetThing" })]));
		expect(exports.some((e) => e.name === "*")).toBe(false);
	});

	it("a never-indexed path returns [] without throwing", () => {
		const pg = new ProjectGraph(root);
		expect(() => pg.getExports(f1NeverIndexed)).not.toThrow();
		expect(pg.getExports(f1NeverIndexed)).toEqual([]);
	});
});

// ==========================================================================
// indexFile — content-vs-disk precedence, the resolvedImports/starTargets
// ArrayDeclaration literals, double-space regex weakening, and a dangling
// (unresolvable) star target.
// ==========================================================================
describe("indexFile — content precedence / accumulator literals / regex / dangling target", () => {
	let root: string;
	let contentA: string;
	let contentB: string;
	let zeroImports: string;
	let regexBase: string;
	let dangling: string;

	beforeAll(() => {
		root = makeTempRoot("indexfile");
		// Disk content DIFFERS from what tests pass explicitly, so a mutant
		// that ignores the passed `content` param is caught by name.
		contentA = write(root, "content-a.ts", "export const fromDisk = 1;\n");
		contentB = write(root, "content-b.ts", "export const onlyDisk = 3;\n");
		zeroImports = write(root, "zero-imports.ts", "export const noImportsHere = 1;\n");
		write(root, "regex-target.ts", "export const regexTargetThing = 1;\n");
		regexBase = write(root, "regex-base.ts", "export  *  from  './regex-target';\n");
		dangling = write(root, "dangling.ts", "export * from './totally-does-not-exist-xyz';\n");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("explicit content wins over disk content (`content` truthy branch)", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(contentA, "export const fromParam = 2;\n");
		expect(pg.getExports(contentA).map((e) => e.name)).toEqual(["fromParam"]);
	});

	it("omitting content falls back to a real disk read (`content` falsy branch)", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(contentB);
		expect(pg.getExports(contentB).map((e) => e.name)).toEqual(["onlyDisk"]);
	});

	it("a file with zero imports has an empty dependency list (resolvedImports accumulator)", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(zeroImports);
		expect(pg.getDependencies(zeroImports)).toEqual([]);
	});

	it("a bogus prior graph entry at the literal key never leaks into a plain file's exports (starTargets accumulator)", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile("Stryker was here", "export const bogusMarker = 1;\n");
		const basePath = path.join(root, "ord1-base.ts");
		pg.updateFile(basePath, "export const baseThing = 1;\n");
		const names = pg.getExports(basePath).map((e) => e.name);
		expect(names).toEqual(["baseThing"]);
		expect(names).not.toContain("bogusMarker");
	});

	it("double-space at every gap of the star-export regex still resolves the real target", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(path.join(root, "regex-target.ts"));
		pg.updateFile(regexBase);
		expect(pg.getExports(regexBase)).toEqual([expect.objectContaining({ name: "regexTargetThing" })]);
	});

	it("a dangling (unresolvable) star target does not crash getExports", () => {
		const pg = new ProjectGraph(root);
		pg.updateFile(dangling);
		expect(() => pg.getExports(dangling)).not.toThrow();
		// Unresolvable => no real target to follow => the raw synthetic "*"
		// marker is returned as-is (the early-return branch, since
		// starTargets correctly stayed empty).
		expect(pg.getExports(dangling)).toEqual([expect.objectContaining({ name: "*", kind: "namespace" })]);
	});
});

describe("second survivor pass — initialization and import topology", () => {
	let root: string;

	beforeAll(() => {
		root = makeTempRoot("topology");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("initialize is idempotent and does not re-index a changed file", () => {
		const file = write(root, "idempotent.ts", "export const before = 1;\n");
		const pg = new ProjectGraph(root);
		pg.initialize();

		write(root, "idempotent.ts", "export const after = 2;\n");
		pg.initialize();

		expect(pg.getExports(file).map((entry) => entry.name)).toEqual(["before"]);
	});

	it("preserves exact resolved and unresolved import targets and reverse edges", () => {
		const target = write(root, "target.ts", "export const target = 1;\n");
		const source = write(
			root,
			"source.ts",
			'import { target } from "./target";\nimport "external-package";\n',
		);
		const pg = new ProjectGraph(root);

		pg.updateFile(source);

		expect(pg.getDependencies(source)).toEqual([
			expect.objectContaining({ specifier: "./target", toFile: target }),
			expect.objectContaining({ specifier: "external-package", toFile: "" }),
		]);
		expect(pg.getDependents(target)).toEqual([source]);
		expect(pg.getImporters(target)).toEqual([
			expect.objectContaining({ fromFile: source, toFile: target }),
		]);
	});

	it("maintains a shared reverse-edge set across updates", () => {
		const target = write(root, "shared-target.ts", "export const shared = 1;\n");
		const first = write(root, "first.ts", 'import "./shared-target";\n');
		const second = write(root, "second.ts", 'import "./shared-target";\n');
		const pg = new ProjectGraph(root);

		pg.updateFile(first);
		pg.updateFile(second);
		expect(pg.getDependents(target).sort()).toEqual([first, second].sort());

		pg.updateFile(first, "export const detached = 1;\n");
		expect(pg.getDependents(target)).toEqual([second]);
	});
});

describe("second survivor pass — scan depth and project boundaries", () => {
	let root: string;

	beforeAll(() => {
		root = makeTempRoot("walk");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("indexes files at depth 20 but stops before depth 21", () => {
		let atCapDir = "";
		for (let i = 0; i < 20; i++) atCapDir = path.join(atCapDir, `d${i}`);
		const atCap = write(root, path.join(atCapDir, "at-cap.ts"), "export const atCap = 1;\n");
		const beyond = write(root, path.join(atCapDir, "d20", "beyond.ts"), "export const beyond = 1;\n");
		const pg = new ProjectGraph(root);

		pg.initialize();

		expect(pg.hasFile(atCap)).toBe(true);
		expect(pg.hasFile(beyond)).toBe(false);
	});

	it("records the nearest package boundary and does not invent one for ordinary folders", () => {
		const serviceFile = write(root, "apps/service/src/service.ts", "export const service = 1;\n");
		write(root, "apps/service/package.json", "{}\n");
		const ordinaryFile = write(root, "apps/ordinary.ts", "export const ordinary = 1;\n");
		const pg = new ProjectGraph(root);

		pg.initialize();

		expect(pg.getProjectBoundary(serviceFile)).toBe(path.join(root, "apps/service"));
		expect(pg.getProjectBoundary(ordinaryFile)).toBe(root);
	});

	it("recurses into directories whose names have a source extension", () => {
		const nested = write(root, path.join("container.ts", "inside.ts"), "export const inside = 1;\n");
		const pg = new ProjectGraph(root);

		pg.initialize();

		expect(pg.hasFile(nested)).toBe(true);
	});
});

describe("second survivor pass — tsconfig path validation", () => {
	let root: string;

	beforeAll(() => {
		root = makeTempRoot("paths");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("strips a full single-line comment before parsing tsconfig", () => {
		const target = write(root, "comment-target/Foo.ts", "export const foo = 1;\n");
		write(
			root,
			"tsconfig.json",
			'{\n  "compilerOptions": {\n    // this comment has more than one character\n    "paths": {"@comment/*": ["comment-target/*"]}\n  }\n}\n',
		);
		const source = write(root, "src/comment-source.ts", 'import "@commentFoo";\n');
		const pg = new ProjectGraph(root);

		pg.updateFile(source);

		expect(pg.getDependencies(source)).toEqual([
			expect.objectContaining({ specifier: "@commentFoo", toFile: target }),
		]);
	});

	it("rejects a paths map when even one alias target has the wrong shape", () => {
		write(root, "mixed-target/Foo.ts", "export const foo = 1;\n");
		write(
			root,
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: {
					paths: {
						"@good/*": ["mixed-target/*"],
						"@bad/*": [123],
					},
				},
			}),
		);
		const source = write(root, "mixed-source.ts", 'import "@goodFoo";\n');
		const pg = new ProjectGraph(root);

		pg.updateFile(source);

		expect(pg.getDependencies(source)).toEqual([
			expect.objectContaining({ specifier: "@goodFoo", toFile: "" }),
		]);
	});

	it("ignores a valid-looking alias whose target array contains a non-string", () => {
		write(
			root,
			"tsconfig.json",
			JSON.stringify({ compilerOptions: { paths: { "@bad/*": [123] } } }),
		);
		const source = write(root, "invalid-element.ts", 'import "@badFoo";\n');
		const pg = new ProjectGraph(root);

		expect(() => pg.updateFile(source)).not.toThrow();
		expect(pg.getDependencies(source)).toEqual([
			expect.objectContaining({ specifier: "@badFoo", toFile: "" }),
		]);
	});
});
