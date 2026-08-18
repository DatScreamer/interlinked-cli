// Mutation-kill companion for project-graph/resolve.ts.
// Campaign: scratch/fleet-r3/CONTRACT-W6.md (LEAN MODE). Every fixture lives
// under one mkdtemp root created once in beforeAll; each case asserts the
// exact resolved path (never a truthy/falsy or toContain check) because the
// surviving mutants are almost all StringLiteral/ConditionalExpression edits
// to individual extension literals and fallback branches — only an
// exact-value assertion distinguishes "resolved to the right file" from
// "resolved to something, or nothing, or the wrong sibling".

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveImportPath, tryResolveFile } from "./resolve.js";

// The exact declared order of resolve.ts's (unexported) RESOLVE_EXTENSIONS.
// Duplicated deliberately: search ORDER is the behavior under test — the
// first matching extension wins, so each entry's position is load-bearing.
const EXTENSIONS_IN_ORDER = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "resolve-mutkill-"));

	// extension search order (withExt loop) — one isolated dir per extension,
	// containing ONLY that extension's file, so an earlier-ordered entry can
	// never accidentally satisfy a later one's case.
	for (const ext of EXTENSIONS_IN_ORDER) {
		const dir = join(root, "ext", ext.slice(1));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `mod${ext}`), "export {};");
	}

	// /index fallback loop
	const indexDir = join(root, "index-loop", "moddir");
	mkdirSync(indexDir, { recursive: true });
	writeFileSync(join(indexDir, "index.ts"), "export {};");

	// exact match (candidate already has an extension)
	const exactDir = join(root, "exact-match");
	mkdirSync(exactDir, { recursive: true });
	writeFileSync(join(exactDir, "foo.json"), "{}");

	// .js -> .ts mapping: a genuine ".js" candidate resolves via its .ts sibling
	const jsFallbackA = join(root, "js-fallback-a");
	mkdirSync(jsFallbackA, { recursive: true });
	writeFileSync(join(jsFallbackA, "mod.ts"), "export {};");

	// .js mapping must be conditional: a candidate NOT ending in .js must reach
	// its real target via ordinary extension search, not the sliced-suffix decoy
	// a wrongly-forced-true mapping would compute (slice(0,-3) of "sample" -> "sam")
	const jsFallbackB = join(root, "js-fallback-b");
	mkdirSync(jsFallbackB, { recursive: true });
	writeFileSync(join(jsFallbackB, "sam.ts"), "export {}; // decoy, must be ignored");
	writeFileSync(join(jsFallbackB, "sample.ts"), "export {}; // real target");

	// .mjs -> .mts mapping: a genuine ".mjs" candidate resolves via its .mts sibling
	const mjsFallbackA = join(root, "mjs-fallback-a");
	mkdirSync(mjsFallbackA, { recursive: true });
	writeFileSync(join(mjsFallbackA, "mod2.mts"), "export {};");

	// .mjs mapping must be conditional, mirroring jsFallbackB
	// (slice(0,-4) of "sample2" -> "sam")
	const mjsFallbackB = join(root, "mjs-fallback-b");
	mkdirSync(mjsFallbackB, { recursive: true });
	writeFileSync(join(mjsFallbackB, "sam.mts"), "export {}; // decoy, must be ignored");
	writeFileSync(join(mjsFallbackB, "sample2.ts"), "export {}; // real target");

	// resolveImportPath: relative specifier
	const relDir = join(root, "rel-specifier", "src");
	mkdirSync(relDir, { recursive: true });
	writeFileSync(join(relDir, "target.ts"), "export {};");

	// resolveImportPath: bare specifier must never fall back to relative
	// resolution, even when a same-named file happens to sit alongside the importer
	const bareDir = join(root, "bare-specifier", "src");
	mkdirSync(bareDir, { recursive: true });
	writeFileSync(join(bareDir, "commander.ts"), "export {}; // decoy, must be ignored");

	// resolveImportPath: bare specifier with a trailing slash is still bare
	const slashDir = join(root, "trailing-slash", "src");
	mkdirSync(slashDir, { recursive: true });
	writeFileSync(join(slashDir, "pkg.ts"), "export {}; // decoy, must be ignored");

	// resolveImportPath: tsconfig path-alias resolution
	const aliasRoot = join(root, "alias");
	mkdirSync(join(aliasRoot, "src"), { recursive: true });
	writeFileSync(join(aliasRoot, "lib.ts"), "export {};");
	mkdirSync(join(aliasRoot, "lib"), { recursive: true });
	writeFileSync(join(aliasRoot, "lib", "util.ts"), "export {};");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("tryResolveFile — extension search order (RESOLVE_EXTENSIONS)", () => {
	// test-contract: public-api — tryResolveFile's docstring: "Try resolving a
	// path by appending extensions"; RESOLVE_EXTENSIONS is searched in its
	// declared order, so each literal entry must independently resolve to
	// exactly candidate+ext when it is the only match on disk.
	it.each(EXTENSIONS_IN_ORDER)("resolves a bare candidate via the %s entry, and only that file", (ext) => {
		const dir = join(root, "ext", ext.slice(1));
		const candidate = join(dir, "mod");
		expect(tryResolveFile(candidate)).toBe(join(dir, `mod${ext}`));
	});
});

describe("tryResolveFile — /index fallback", () => {
	// test-contract: public-api — tryResolveFile's docstring: "...or /index."
	// A directory candidate must resolve to its index.ts file, not to the bare
	// directory path itself.
	it("resolves a directory candidate to its index.ts, not the bare directory", () => {
		const dir = join(root, "index-loop", "moddir");
		expect(tryResolveFile(dir)).toBe(join(dir, "index.ts"));
	});
});

describe("tryResolveFile — exact match", () => {
	// test-contract: public-api — source comment: "Exact match (already has
	// extension — includes .json, .ts, etc.)"; a candidate that is already a
	// real file must be returned verbatim.
	it("returns a candidate that already has an extension verbatim", () => {
		const path = join(root, "exact-match", "foo.json");
		expect(tryResolveFile(path)).toBe(path);
	});
});

describe("tryResolveFile — .js -> .ts/.tsx mapping", () => {
	// test-contract: public-api — source comment: "Handle .js -> .ts/.tsx
	// mapping (common in ESM TypeScript projects)."
	it("maps a genuine .js candidate to its sibling .ts file", () => {
		const dir = join(root, "js-fallback-a");
		expect(tryResolveFile(join(dir, "mod.js"))).toBe(join(dir, "mod.ts"));
	});

	// test-contract: public-api — the .js->.ts mapping is conditional on the
	// candidate literally ending in ".js"; a candidate that does not must reach
	// its target through ordinary extension search, never the mapping's decoy.
	it("does not apply the .js mapping to a candidate that does not end in .js", () => {
		const dir = join(root, "js-fallback-b");
		expect(tryResolveFile(join(dir, "sample"))).toBe(join(dir, "sample.ts"));
	});
});

describe("tryResolveFile — .mjs -> .mts mapping", () => {
	// test-contract: public-api — mirrors the .js->.ts mapping for ESM: a
	// genuine .mjs candidate resolves to its .mts source sibling.
	it("maps a genuine .mjs candidate to its sibling .mts file", () => {
		const dir = join(root, "mjs-fallback-a");
		expect(tryResolveFile(join(dir, "mod2.mjs"))).toBe(join(dir, "mod2.mts"));
	});

	// test-contract: public-api — same conditional-mapping contract as the
	// .js case, for the .mjs->.mts branch.
	it("does not apply the .mjs mapping to a candidate that does not end in .mjs", () => {
		const dir = join(root, "mjs-fallback-b");
		expect(tryResolveFile(join(dir, "sample2"))).toBe(join(dir, "sample2.ts"));
	});
});

describe("resolveImportPath — relative specifiers", () => {
	// test-contract: public-api — resolveImportPath's docstring: "Resolve a
	// relative import specifier to an absolute file path."
	it("resolves a './...' specifier against the importer's directory", () => {
		const dir = join(root, "rel-specifier", "src");
		const fromFile = join(dir, "caller.ts");
		expect(resolveImportPath(fromFile, "./target")).toBe(join(dir, "target.ts"));
	});
});

describe("resolveImportPath — bare (node_modules) specifiers", () => {
	// test-contract: public-api — resolveImportPath's docstring: "Returns null
	// for node_modules imports (non-relative specifiers)." A same-named file
	// alongside the importer must not be found by a relative-resolution fallback.
	it("returns null for a bare specifier even when a same-named file exists alongside the importer", () => {
		const dir = join(root, "bare-specifier", "src");
		const fromFile = join(dir, "caller.ts");
		expect(resolveImportPath(fromFile, "commander")).toBeNull();
	});

	// test-contract: boundary — the "." / "/" prefix check classifies by the
	// specifier's first character only; a bare specifier ending in "/" is
	// still bare and must not be resolved as a relative path.
	it("returns null for a bare specifier with a trailing slash", () => {
		const dir = join(root, "trailing-slash", "src");
		const fromFile = join(dir, "caller.ts");
		expect(resolveImportPath(fromFile, "pkg/")).toBeNull();
	});
});

describe("resolveImportPath — tsconfig path aliases", () => {
	// test-contract: public-api — resolveImportPath's third parameter,
	// tsconfigPaths, is the module header's documented "TypeScript's
	// path-alias extensions", consulted for non-relative specifiers.
	it("resolves an exact alias specifier through tsconfigPaths", () => {
		const aliasRoot = join(root, "alias");
		const fromFile = join(aliasRoot, "src", "caller.ts");
		const result = resolveImportPath(fromFile, "@lib", { "@lib/*": ["lib/*"] });
		expect(result).toBe(join(aliasRoot, "lib.ts"));
	});

	// test-contract: bug-class — wave-9 find (2026-08-17): the sliced alias
	// remainder kept its leading "/", and path.resolve treats an absolute
	// segment as a restart — every suffixed alias specifier ("@lib/util")
	// silently resolved to null, corrupting the graph (false "no importers")
	// on any repo using tsconfig path aliases.
	it("P: resolves an alias specifier WITH a suffix through tsconfigPaths", () => {
		const aliasRoot = join(root, "alias");
		const fromFile = join(aliasRoot, "src", "caller.ts");
		const result = resolveImportPath(fromFile, "@lib/util", { "@lib/*": ["lib/*"] });
		expect(result).toBe(join(aliasRoot, "lib", "util.ts"));
	});
});
