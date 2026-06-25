import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDirSkipper, resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

describe("SHARED_SKIP_DIRS", () => {
	it("includes the standard non-project directories", () => {
		for (const d of ["node_modules", ".git", "dist", "build", "target"]) {
			expect(SHARED_SKIP_DIRS.has(d)).toBe(true);
		}
	});

	it("includes interlinked's own data directories", () => {
		expect(SHARED_SKIP_DIRS.has(".interlinked")).toBe(true);
		expect(SHARED_SKIP_DIRS.has("interlinked")).toBe(true);
	});

	it("includes reference-repos (the load-bearing entry: 38K+ files lived there)", () => {
		expect(SHARED_SKIP_DIRS.has("reference-repos")).toBe(true);
	});

	it("does NOT include src — the actual project code must be walked", () => {
		expect(SHARED_SKIP_DIRS.has("src")).toBe(false);
	});

	it("does NOT include docs — docs-extractor needs to walk it", () => {
		expect(SHARED_SKIP_DIRS.has("docs")).toBe(false);
	});

	it("does NOT include test — test-extractor needs to walk it", () => {
		expect(SHARED_SKIP_DIRS.has("test")).toBe(false);
	});

	it("includes universal framework/cache artefact dirs", () => {
		for (const d of [".next", ".turbo", ".wrangler", "coverage", ".venv", ".pytest_cache"]) {
			expect(SHARED_SKIP_DIRS.has(d)).toBe(true);
		}
	});
});

describe("resolveIgnoredDirs (gitignore-aware)", () => {
	it("resolves fully-ignored directories to absolute paths", () => {
		const repoRoot = "/repo/ignored-abs";
		const runner = (): string => "external/\nevals/local-models/\n.next/\n";
		const ignored = resolveIgnoredDirs(repoRoot, runner);
		expect(ignored.has(join(repoRoot, "external"))).toBe(true);
		expect(ignored.has(join(repoRoot, "evals/local-models"))).toBe(true);
		expect(ignored.has(join(repoRoot, ".next"))).toBe(true);
	});

	it("prunes only directories — ignored FILES (no trailing slash) are kept walkable", () => {
		const repoRoot = "/repo/ignored-files";
		const runner = (): string => ".env\nfoo.log\nsecret-dir/\n";
		const ignored = resolveIgnoredDirs(repoRoot, runner);
		expect(ignored.has(join(repoRoot, ".env"))).toBe(false);
		expect(ignored.has(join(repoRoot, "foo.log"))).toBe(false);
		expect(ignored.has(join(repoRoot, "secret-dir"))).toBe(true);
	});

	it("fails open to an empty set when git is unavailable", () => {
		expect(resolveIgnoredDirs("/repo/no-git", () => null).size).toBe(0);
	});

	it("memoizes per repo within the TTL and refreshes after it", () => {
		const repoRoot = "/repo/ttl";
		let calls = 0;
		const runner = (): string => {
			calls++;
			return "x/\n";
		};
		resolveIgnoredDirs(repoRoot, runner, () => 1_000);
		resolveIgnoredDirs(repoRoot, runner, () => 1_500); // within TTL → cached
		expect(calls).toBe(1);
		resolveIgnoredDirs(repoRoot, runner, () => 1_000 + 60_001); // past TTL → refresh
		expect(calls).toBe(2);
	});
});

describe("resolveDirSkipper", () => {
	it("skips universal artefact basenames at any path", () => {
		const skip = resolveDirSkipper("/repo/sk-base", () => "");
		expect(skip("node_modules", "/repo/sk-base/pkg/node_modules")).toBe(true);
		expect(skip(".next", "/repo/sk-base/.next")).toBe(true);
	});

	it("skips gitignored directories by absolute path", () => {
		const repoRoot = "/repo/sk-ignored";
		const skip = resolveDirSkipper(repoRoot, () => "evals/local-models/\n");
		expect(skip("local-models", join(repoRoot, "evals/local-models"))).toBe(true);
	});

	it("is path-precise — a same-named dir elsewhere is NOT skipped", () => {
		const repoRoot = "/repo/sk-precise";
		const skip = resolveDirSkipper(repoRoot, () => "evals/local-models/\n");
		expect(skip("local-models", join(repoRoot, "src/local-models"))).toBe(false);
	});

	it("walks ordinary source directories", () => {
		const skip = resolveDirSkipper("/repo/sk-src", () => "");
		expect(skip("src", "/repo/sk-src/src")).toBe(false);
		expect(skip("components", "/repo/sk-src/src/components")).toBe(false);
	});
});
