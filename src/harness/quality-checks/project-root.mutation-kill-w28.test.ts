import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutation-kill campaign (wave 28) for src/harness/quality-checks/project-root.ts.
//
// One test in this file (the "fixed-point directory" case) needs to simulate a
// directory that behaves like a filesystem root (`dirname(dir) === dir`)
// WITHOUT ever touching the real `/` — writing fixtures there would be unsafe
// and sandbox-hostile. `node:path`'s `dirname` is mocked to special-case one
// exact, per-test sentinel path (set via the hoisted ref below) and delegate
// everything else to the real implementation, so every other test in this
// file — and every other test file — sees ordinary `dirname` behavior.
const { sentinelPathRef } = vi.hoisted(() => ({
	// SAFETY: initialized to null and only ever assigned a directory path
	// string by a test's own setup; the type covers both states explicitly.
	sentinelPathRef: { current: null as string | null },
}));

vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return {
		...actual,
		dirname: (p: string) => {
			if (sentinelPathRef.current !== null && p === sentinelPathRef.current) {
				return p;
			}
			return actual.dirname(p);
		},
	};
});

const { findProjectRoot } = await import("./project-root.js");

// macOS tmpdir is a /var -> /private/var symlink. Realpath both fixture
// paths and expected results so equality holds regardless of symlinks.
const tmpRealRoot = realpathSync(tmpdir());

describe("findProjectRoot — mutation-kill w28", () => {
	const tmpDirs: string[] = [];

	function makeTmp(prefix: string): string {
		const dir = realpathSync(mkdtempSync(join(tmpRealRoot, prefix)));
		mkdirSync(dir, { recursive: true });
		tmpDirs.push(dir);
		return dir;
	}

	beforeEach(() => {
		sentinelPathRef.current = null;
	});

	afterEach(() => {
		sentinelPathRef.current = null;
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	// A Rust file must resolve via the Cargo.toml language-profile marker, not
	// the generic tsconfig/package.json fallback (absent from this fixture).
	// test-contract: public-api — findProjectRoot must use the language profile's own root markers, not silently fall back
	it("uses the Rust language profile's Cargo.toml marker, not the tsconfig/package.json fallback", () => {
		const cwd = makeTmp("interlinked-projroot-w28-rust-");
		writeFileSync(join(cwd, "Cargo.toml"), '[package]\nname = "w28"\n');
		const file = join(cwd, "main.rs");
		writeFileSync(file, "fn main() {}\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	// A file type outside every language profile (".md") must still resolve
	// via the generic tsconfig.json fallback walk directly in cwd.
	// test-contract: public-api — the tsconfig.json fallback walk must fire for any file type with no matching language profile
	it("finds tsconfig.json via the fallback walk for a file type outside all language profiles", () => {
		const cwd = makeTmp("interlinked-projroot-w28-tsconfig-fallback-");
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		const file = join(cwd, "notes.md");
		writeFileSync(file, "# notes\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	// The tsconfig fallback walk must keep climbing past a marker-less
	// intermediate directory to reach a tsconfig.json two levels up.
	// test-contract: boundary — the tsconfig fallback walk must continue past directories with no marker instead of stopping early
	it("climbs multiple directories via the tsconfig fallback walk to reach a distant root marker", () => {
		const cwd = makeTmp("interlinked-projroot-w28-tsconfig-nested-");
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		const deep = join(cwd, "a", "b");
		mkdirSync(deep, { recursive: true });
		const file = join(deep, "deep.md");
		writeFileSync(file, "# deep\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	// With no tsconfig.json anywhere, the package.json fallback walk must
	// still find a marker directly in cwd.
	// test-contract: public-api — the package.json fallback walk must fire when no tsconfig.json exists anywhere in the tree
	it("finds package.json via the fallback walk when no tsconfig.json exists", () => {
		const cwd = makeTmp("interlinked-projroot-w28-pkg-fallback-");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "w28" }));
		const file = join(cwd, "notes.md");
		writeFileSync(file, "# notes\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	// The package.json fallback walk must keep climbing past a marker-less
	// intermediate directory to reach a package.json two levels up — the
	// tsconfig-only fixtures above never exercise this loop's own break check.
	// test-contract: boundary — the package.json fallback walk must continue past directories with no marker instead of stopping early
	it("climbs multiple directories via the package.json fallback walk to reach a distant root marker", () => {
		const cwd = makeTmp("interlinked-projroot-w28-pkg-nested-");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "w28" }));
		const deep = join(cwd, "a", "b");
		mkdirSync(deep, { recursive: true });
		const file = join(deep, "deep.md");
		writeFileSync(file, "# deep\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	// Simulates a directory that is its own dirname (a filesystem-root fixed
	// point) via the sentinel node:path mock, without touching the real `/`.
	// Such a directory must never be treated as a walkable project ancestor,
	// so its tsconfig.json must stay unreachable.
	// test-contract: invariant — a filesystem-root fixed-point directory must never be inspected by the fallback walk
	it("never inspects a directory that is its own dirname (simulated filesystem-root fixed point)", () => {
		const root = makeTmp("interlinked-projroot-w28-fsroot-");
		writeFileSync(join(root, "tsconfig.json"), "{}");
		const file = join(root, "notes.md");
		writeFileSync(file, "# notes\n");

		sentinelPathRef.current = root;

		expect(findProjectRoot(file, root)).toBeNull();
	});
});
