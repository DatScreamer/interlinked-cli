// Survivor-kill tests for src/harness/project-graph.ts — PASS-1 W6/lean-mode
// campaign (see scratch/fleet-r3/CONTRACT-W6.md). Targets the 29-mutant
// survivor set reported by `mutation survivors --file src/harness/project-graph.ts`
// at generation 1771. Complements project-graph.test.ts (real temp dirs) and
// project-graph.coverage.test.ts (same node:fs mock pattern reused below) —
// this file exists specifically so mutation-kill assertions ship under the
// `*.mutation-kill.test.ts` companion the runner is guaranteed to pick up.
//
// node:fs is mocked so directory-listing ORDER and "neither file nor
// directory" dirents are fully controllable — several survivors live in the
// walkDir sort comparator, where real-filesystem readdir order can't be
// pinned deterministically.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ChildEntry {
	name: string;
	dir: boolean;
	other?: boolean;
}
const fileContents = new Map<string, string>();
const dirEntries = new Map<string, ChildEntry[]>();

interface DirentLike {
	name: string;
	isDirectory: () => boolean;
	isFile: () => boolean;
}

vi.mock("node:fs", () => ({
	existsSync: vi.fn((p: string) => fileContents.has(p) || dirEntries.has(p)),
	statSync: vi.fn((p: string) => {
		if (fileContents.has(p)) return { isFile: () => true, isDirectory: () => false };
		if (dirEntries.has(p)) return { isFile: () => false, isDirectory: () => true };
		throw new Error(`ENOENT: ${p}`);
	}),
	readFileSync: vi.fn((p: string) => {
		const content = fileContents.get(p);
		if (content !== undefined) return content;
		throw new Error(`ENOENT: ${p}`);
	}),
	readdirSync: vi.fn((p: string, opts?: { withFileTypes?: boolean }) => {
		const entries = dirEntries.get(p);
		if (!entries) throw new Error(`ENOTDIR: ${p}`);
		if (opts?.withFileTypes) {
			return entries.map(
				(e): DirentLike => ({
					name: e.name,
					isDirectory: () => e.dir,
					isFile: () => !e.dir && e.other !== true,
				}),
			);
		}
		return entries.map((e) => e.name);
	}),
}));

import { nonNull } from "../lib/non-null.js";
import { ProjectGraph } from "./project-graph.js";

function resetFs(): void {
	fileContents.clear();
	dirEntries.clear();
}
function addFile(path: string, content: string): void {
	fileContents.set(path, content);
}
function addDir(path: string, children: ChildEntry[]): void {
	dirEntries.set(path, children);
}

beforeEach(() => {
	resetFs();
});

// ---------------------------------------------------------------------------
// walkDir sort comparator — kills the ArrowFunction/ConditionalExpression/
// EqualityOperator survivors on `(a,b) => a.name<b.name?-1:a.name>b.name?1:0`
// and the MethodExpression survivor that drops `.sort(...)` entirely.
// ---------------------------------------------------------------------------
describe("ProjectGraph.walkDir — directory listing sort order", () => {
	// test-contract: invariant — walkDir must index a directory's files in
	// ascending name order regardless of the order readdirSync happens to
	// return them in; asserting the raw (unsorted-by-the-test) allFiles()
	// output is the only way to observe the comparator's own correctness.
	it("keeps an already-ascending listing in place", () => {
		addDir("/sroot", [
			{ name: "apple.ts", dir: false },
			{ name: "zebra.ts", dir: false },
		]);
		addFile("/sroot/apple.ts", "export const a = 1;");
		addFile("/sroot/zebra.ts", "export const z = 1;");
		const graph = new ProjectGraph("/sroot");
		graph.initialize();
		expect(graph.allFiles()).toEqual(["/sroot/apple.ts", "/sroot/zebra.ts"]);
	});

	// test-contract: invariant — same guarantee as above, exercised against a
	// listing that arrives in strictly descending order so a comparator that
	// silently forces "no swap" (or a constant "always swap") is exposed.
	it("reorders a descending listing to ascending", () => {
		addDir("/sroot2", [
			{ name: "zebra.ts", dir: false },
			{ name: "apple.ts", dir: false },
		]);
		addFile("/sroot2/zebra.ts", "export const z = 1;");
		addFile("/sroot2/apple.ts", "export const a = 1;");
		const graph = new ProjectGraph("/sroot2");
		graph.initialize();
		expect(graph.allFiles()).toEqual(["/sroot2/apple.ts", "/sroot2/zebra.ts"]);
	});

	// test-contract: invariant — a five-entry scramble forces multiple
	// pairwise comparator calls; a dropped `.sort()` call (the
	// MethodExpression survivor) or a broken comparator each leave at least
	// one adjacent pair mis-ordered in the final listing.
	it("fully sorts a scrambled multi-entry listing", () => {
		addDir("/sroot3", [
			{ name: "zebra.ts", dir: false },
			{ name: "apple.ts", dir: false },
			{ name: "kiwi.ts", dir: false },
			{ name: "mango.ts", dir: false },
			{ name: "banana.ts", dir: false },
		]);
		for (const n of ["zebra", "apple", "kiwi", "mango", "banana"]) {
			addFile(`/sroot3/${n}.ts`, `export const v_${n} = 1;`);
		}
		const graph = new ProjectGraph("/sroot3");
		graph.initialize();
		expect(graph.allFiles()).toEqual([
			"/sroot3/apple.ts",
			"/sroot3/banana.ts",
			"/sroot3/kiwi.ts",
			"/sroot3/mango.ts",
			"/sroot3/zebra.ts",
		]);
	});
});

// ---------------------------------------------------------------------------
// walkDir — entry.isFile() guard (d5bb4fdc93a4d551)
// ---------------------------------------------------------------------------
describe("ProjectGraph.walkDir — file-vs-other dirent guard", () => {
	// test-contract: boundary — a dirent that is neither a directory nor a
	// file (socket/symlink) must never be indexed, even when its name has a
	// recognised extension; only entry.isFile() may admit it.
	it("excludes a non-file, non-directory entry despite a .ts-shaped name", () => {
		addDir("/wroot", [
			{ name: "weird.ts", dir: false, other: true },
			{ name: "real.ts", dir: false },
		]);
		// Registered so a wrongly-admitted "weird.ts" would actually index
		// successfully under a broken guard, making the divergence visible.
		addFile("/wroot/weird.ts", "export const w = 1;");
		addFile("/wroot/real.ts", "export const r = 1;");
		const graph = new ProjectGraph("/wroot");
		graph.initialize();
		expect(graph.allFiles()).toEqual(["/wroot/real.ts"]);
	});
});

// ---------------------------------------------------------------------------
// indexFile — star-target detection guard on
// `exp.name === "*" && exp.kind === "namespace"`. A commented-out
// `export * from '...'` line is invisible to parseExports (comment-skipped)
// but still visible to indexFile's raw-content starRe scan, so an
// improperly-triggered guard pulls in a target export that a correct guard
// never would — an exact-value getExports() pin catches it.
// ---------------------------------------------------------------------------
describe("ProjectGraph.indexFile — star-target detection guard", () => {
	// test-contract: public-api — getExports must not treat an ordinary
	// export as a transitive `export * from` marker; with no real
	// name==="*"/kind==="namespace" export present, no target may be
	// resolved or merged into the result.
	it("never follows a star target when no export is actually a namespace star", () => {
		addFile("/proj/ghost_a.ts", "export const g = 1;");
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/ghost_a.ts", "export const g = 1;");
		graph.updateFile(
			"/proj/source_a.ts",
			["export const real = 1;", "// export * from './ghost_a';"].join("\n"),
		);
		expect(graph.getExports("/proj/source_a.ts")).toEqual([
			{ name: "real", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	// test-contract: public-api — an export literally named "*" whose kind
	// is NOT "namespace" (`export { * };`, a non-namespace re-export) must
	// not be treated as a star-from marker either.
	it("never follows a star target for a name-only '*' export", () => {
		addFile("/proj/ghost_b.ts", "export const gb = 1;");
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/ghost_b.ts", "export const gb = 1;");
		graph.updateFile(
			"/proj/source_b.ts",
			["export { * };", "// export * from './ghost_b';"].join("\n"),
		);
		expect(graph.getExports("/proj/source_b.ts")).toEqual([
			{ name: "*", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});

	// test-contract: public-api — a named namespace re-export
	// (`export * as foo from ...`) has kind==="namespace" but name!=="*";
	// it must not be treated as a star-from marker either.
	it("never follows a star target for a named namespace re-export", () => {
		addFile("/proj/ghost_c2.ts", "export const gc2 = 1;");
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/ghost_c2.ts", "export const gc2 = 1;");
		graph.updateFile(
			"/proj/source_c.ts",
			["export * as foo from './ghost_c';", "// export * from './ghost_c2';"].join("\n"),
		);
		expect(graph.getExports("/proj/source_c.ts")).toEqual([
			{ name: "foo", kind: "namespace", isTypeOnly: false, line: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// indexFile — starTargets initial-array default. NOTE: manifest cross-check
// (ordinalWithinSymbol) shows the CURRENT open ArrayDeclaration survivor for
// this symbol (a8708e898c6e7f5b) is ordinal 0 — the OLD-EDGES fallback array
// (`this.importGraph.get(absPath) || []`), not this one (ordinal 1, already
// killed elsewhere). This test is kept as a real regression pin — it just
// isn't the kill for that specific survivor; see the receipt for the actual
// disposition.
// ---------------------------------------------------------------------------
describe("ProjectGraph.indexFile — starTargets initial value", () => {
	// test-contract: public-api — a file with zero star exports must report
	// exactly its own direct exports; pre-indexing a file at the exact path
	// a corrupted initial array's placeholder text would resolve to (via
	// this.projectRoot) makes any accidental non-empty default observable.
	it("reports only direct exports when the file has no star export", () => {
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/Stryker was here", "export const bogus = 1;");
		graph.updateFile("/proj/source_init.ts", "export const normal = 1;");
		expect(graph.getExports("/proj/source_init.ts")).toEqual([
			{ name: "normal", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// indexFile — reverseGraph must never gain a raw (pre-fallback) key for an
// unresolved import (161e0301884af22c). The public API has no accessor for
// reverseGraph's key set, so this is the one legitimate internal-invariant
// check in this file.
// ---------------------------------------------------------------------------
describe("ProjectGraph.indexFile — reverseGraph key hygiene", () => {
	// test-contract: invariant — every reverseGraph write is guarded by a
	// truthy resolved toFile; an unresolved import must never leave a
	// literal null key behind.
	it("never inserts a null key into reverseGraph for an unresolved import", () => {
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/source_null.ts", "import { z } from './does-not-exist';");
		// SAFETY: reverseGraph is private with no public key-enumeration
		// accessor; this is the only way to observe the invariant above.
		const reverseGraph = (graph as unknown as { reverseGraph: Map<unknown, unknown> })
			.reverseGraph;
		expect(reverseGraph.has(null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getExports — the transitive-follow filter
// `!(e.name === "*" && e.kind === "namespace")` (f4071d11071d6aa0)
// ---------------------------------------------------------------------------
describe("ProjectGraph.getExports — namespace-marker filter", () => {
	// test-contract: public-api — the filter must drop ONLY the genuine
	// namespace-kind "*" marker, keeping any other export that happens to
	// share the name "*" (e.g. a non-namespace `export { * };`).
	it("keeps a non-namespace '*' export alongside resolved star-target exports", () => {
		const graph = new ProjectGraph("/proj");
		// addFile (not just updateFile) is required here: resolveImportPath
		// resolves "./target_d" through the mocked existsSync/statSync, which
		// only see fileContents-registered paths — updateFile's content param
		// bypasses that registration entirely.
		addFile("/proj/target_d.ts", "export const real = 1;");
		graph.updateFile("/proj/target_d.ts", "export const real = 1;");
		graph.updateFile(
			"/proj/source_d.ts",
			["export * from './target_d';", "export { * };"].join("\n"),
		);
		expect(graph.getExports("/proj/source_d.ts")).toEqual([
			{ name: "*", kind: "const", isTypeOnly: false, line: 2 },
			{ name: "real", kind: "const", isTypeOnly: false, line: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// getImporters — `!dependents` early-return guard (12c3fe84dada5ec0)
// ---------------------------------------------------------------------------
describe("ProjectGraph.getImporters — no-dependents guard", () => {
	// test-contract: public-api — getImporters must return [] (not throw)
	// for a file with zero recorded dependents; the guard is what prevents
	// iterating an undefined Set.
	it("returns [] without throwing when a file has no importers", () => {
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/lonely.ts", "export const x = 1;");
		expect(() => graph.getImporters("/proj/lonely.ts")).not.toThrow();
		expect(graph.getImporters("/proj/lonely.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// loadTsconfigPaths — every/some on the outer (per-alias) and inner
// (per-target-string) validation (d28f8804627d37c0, 0e5c230fdf714b43)
// ---------------------------------------------------------------------------
describe("ProjectGraph constructor — tsconfig paths validation strictness", () => {
	// test-contract: boundary — the whole paths map is trusted for alias
	// resolution only when EVERY alias's targets are well-shaped; one
	// malformed alias entry must reject resolution for a DIFFERENT,
	// otherwise-valid alias too.
	it("rejects all aliases when any one alias has a non-string-array target", () => {
		addFile(
			"/proj/tsconfig.json",
			JSON.stringify({
				compilerOptions: { paths: { "@good": ["./src/good.ts"], "@bad/*": [42] } },
			}),
		);
		addFile("/proj/src/good.ts", "export const g = 1;");
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/src/index.ts", `import { g } from '@good';`);
		expect(nonNull(graph.getDependencies("/proj/src/index.ts")[0]).toFile).toBe("");
	});

	// test-contract: boundary — within ONE alias's target array, every
	// element must be a string; a single non-string element must reject
	// that alias even though another element in the SAME array is valid.
	it("rejects an alias whose target array mixes a string with a non-string", () => {
		addFile(
			"/proj/tsconfig.json",
			JSON.stringify({ compilerOptions: { paths: { "@root": ["./src/good2.ts", 42] } } }),
		);
		addFile("/proj/src/good2.ts", "export const g2 = 1;");
		const graph = new ProjectGraph("/proj");
		graph.updateFile("/proj/src/index2.ts", `import { g2 } from '@root';`);
		expect(nonNull(graph.getDependencies("/proj/src/index2.ts")[0]).toFile).toBe("");
	});
});
