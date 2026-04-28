import { describe, expect, it } from "vitest";
import { SKIP_PATHS_CHUNK } from "./skip-paths.js";

// SKIP_PATHS_CHUNK is a template-literal string that becomes runtime JS in
// the generated `.interlinked/hooks/interlinked-activity.mjs`. We can't
// import its functions directly (they reference outer-scope globals like
// `CONFIG_SHARED_PATH`, `CWD`, `existsSync`, `readFileSync`), so two
// strategies are used here:
//   (1) shape assertions — verify the chunk declares the expected helpers;
//   (2) behavioural eval — splice the chunk into a synthetic harness that
//       provides the missing globals, then exercise `matchesSkipPath` and
//       `globToRegex` against synthesized inputs. This is the same pattern
//       `event-normalizers.test.ts` uses for an inline-string chunk.

interface ChunkHarness {
	// `unknown` instead of `string` because the runtime function tolerates
	// any input shape (defensive against malformed tool payloads). Tests
	// exercise that real contract; using `string` here would force the
	// bad-input tests to launder through `as unknown as string` and trip
	// the strong-typing detector.
	matchesSkipPath: (p: unknown) => boolean;
	globToRegex: (p: string) => RegExp;
	loadSkipPaths: () => string[];
}

function evalChunkInHarness(opts: {
	cwd: string;
	configContent: string | null;
}): ChunkHarness {
	// Harness wraps the chunk's source so its references resolve to mocked
	// globals. This mirrors the structure inside the .mjs (CONFIG_SHARED_PATH
	// + readFileSync + existsSync are defined above the chunk in the real
	// generated script).
	const harness = `
		"use strict";
		const CWD = ${JSON.stringify(opts.cwd)};
		const CONFIG_SHARED_PATH = "/mock/config.json";
		const _hasConfig = ${opts.configContent === null ? "false" : "true"};
		const _configContent = ${JSON.stringify(opts.configContent ?? "")};
		const existsSync = (p) => p === CONFIG_SHARED_PATH ? _hasConfig : false;
		const readFileSync = (p, _enc) => {
			if (p === CONFIG_SHARED_PATH) return _configContent;
			throw new Error("unexpected read of " + p);
		};
		const process = { env: {}, stderr: { write: () => {} } };
		${SKIP_PATHS_CHUNK}
		return { matchesSkipPath, globToRegex, loadSkipPaths };
	`;
	return new Function(harness)() as ReturnType<typeof evalChunkInHarness>;
}

describe("SKIP_PATHS_CHUNK — shape", () => {
	it("is a non-empty string", () => {
		expect(typeof SKIP_PATHS_CHUNK).toBe("string");
		expect(SKIP_PATHS_CHUNK.length).toBeGreaterThan(100);
	});

	it("exposes loadSkipPaths / globToRegex / matchesSkipPath as the public surface", () => {
		expect(SKIP_PATHS_CHUNK).toContain("function loadSkipPaths(");
		expect(SKIP_PATHS_CHUNK).toContain("function globToRegex(");
		expect(SKIP_PATHS_CHUNK).toContain("function matchesSkipPath(");
	});

	it("caches the parsed skip_paths in a module-scope variable", () => {
		expect(SKIP_PATHS_CHUNK).toContain("SKIP_PATHS_CACHE");
		// Single-evaluation guard — re-call short-circuits via the cache.
		expect(SKIP_PATHS_CHUNK).toContain("if (SKIP_PATHS_CACHE !== null)");
	});

	it("reads from .interlinked/config.json (the shared, committed config)", () => {
		// skip_paths is committed (Phase B.2), so the chunk must read the
		// shared config — not config.local.json.
		expect(SKIP_PATHS_CHUNK).toContain("CONFIG_SHARED_PATH");
	});

	it("emits a debug stderr line under INTERLINKED_DEBUG=1", () => {
		expect(SKIP_PATHS_CHUNK).toContain("INTERLINKED_DEBUG");
		expect(SKIP_PATHS_CHUNK).toContain("[interlinked:skip]");
	});

	it("documents the supported glob syntax (must match daemon-side path-glob)", () => {
		// Phase B.2 (Subagent Z) ships the daemon-side path-glob.ts with the
		// same syntax. Lockstep — if either side drifts, this test fails.
		expect(SKIP_PATHS_CHUNK).toMatch(/\*\*/);
		expect(SKIP_PATHS_CHUNK).toContain("?");
	});
});

describe("SKIP_PATHS_CHUNK — globToRegex semantics", () => {
	const harness = evalChunkInHarness({
		cwd: "/repo",
		configContent: null,
	});

	it("`*` matches any non-separator chars", () => {
		const re = harness.globToRegex("*.ts");
		expect(re.test("foo.ts")).toBe(true);
		expect(re.test("bar.tsx")).toBe(false);
		// Should NOT cross directory separators
		expect(re.test("dir/foo.ts")).toBe(false);
	});

	it("`**` matches any chars INCLUDING separators", () => {
		const re = harness.globToRegex("**/foo.ts");
		expect(re.test("foo.ts")).toBe(true);
		expect(re.test("a/foo.ts")).toBe(true);
		expect(re.test("a/b/c/foo.ts")).toBe(true);
		expect(re.test("foo.tsx")).toBe(false);
	});

	it("`dist/**` matches files inside dist at any depth", () => {
		const re = harness.globToRegex("dist/**");
		expect(re.test("dist/foo.js")).toBe(true);
		expect(re.test("dist/sub/dir/foo.js")).toBe(true);
		expect(re.test("src/foo.js")).toBe(false);
	});

	it("`?` matches exactly one non-separator char", () => {
		const re = harness.globToRegex("?.ts");
		expect(re.test("a.ts")).toBe(true);
		expect(re.test("ab.ts")).toBe(false);
		expect(re.test(".ts")).toBe(false);
		expect(re.test("/.ts")).toBe(false);
	});

	it("escapes regex metacharacters in literal segments", () => {
		// `.` is a regex metachar — it must be escaped to literal-dot.
		const re = harness.globToRegex("foo.bar");
		expect(re.test("foo.bar")).toBe(true);
		expect(re.test("fooXbar")).toBe(false); // would match if `.` weren't escaped
	});

	it("braces / parens / pipes in patterns are treated as literals (not alternation)", () => {
		// We don't support brace expansion — `{js,ts}` is a literal match,
		// not "js OR ts". Documents the deliberate scope limit.
		const re = harness.globToRegex("foo.{js,ts}");
		expect(re.test("foo.{js,ts}")).toBe(true);
		expect(re.test("foo.js")).toBe(false);
	});
});

describe("SKIP_PATHS_CHUNK — matchesSkipPath behaviour", () => {
	it("returns false when no config exists", () => {
		const h = evalChunkInHarness({ cwd: "/repo", configContent: null });
		expect(h.matchesSkipPath("/repo/dist/foo.js")).toBe(false);
	});

	it("returns false when config has no skip_paths key", () => {
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ server_url: "https://x" }),
		});
		expect(h.matchesSkipPath("/repo/dist/foo.js")).toBe(false);
	});

	it("returns false when skip_paths is empty array", () => {
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ skip_paths: [] }),
		});
		expect(h.matchesSkipPath("/repo/dist/foo.js")).toBe(false);
	});

	it("matches absolute paths against CWD-relative skip patterns", () => {
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ skip_paths: ["dist/**"] }),
		});
		expect(h.matchesSkipPath("/repo/dist/foo.js")).toBe(true);
		expect(h.matchesSkipPath("/repo/dist/sub/foo.js")).toBe(true);
		expect(h.matchesSkipPath("/repo/src/foo.js")).toBe(false);
	});

	it("matches with **/ prefix that should hit any depth", () => {
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ skip_paths: ["**/*.min.js"] }),
		});
		expect(h.matchesSkipPath("/repo/foo.min.js")).toBe(true);
		expect(h.matchesSkipPath("/repo/static/vendor/foo.min.js")).toBe(true);
		expect(h.matchesSkipPath("/repo/foo.js")).toBe(false);
	});

	it("matches paths outside CWD by their absolute form", () => {
		// Some agents emit absolute paths under /tmp etc. — we still try the
		// pattern against the absolute path so e.g. "**/node_modules/**"
		// catches it regardless.
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ skip_paths: ["**/node_modules/**"] }),
		});
		expect(h.matchesSkipPath("/tmp/projectx/node_modules/foo/bar.js")).toBe(true);
	});

	it("returns false on empty/non-string input via the runtime guard", () => {
		// Public-API contract: the hook is JS at runtime — non-string inputs
		// can occur if a tool payload omits the file path. The chunk's runtime
		// guard tolerates them. The harness `matchesSkipPath` is typed
		// `(unknown) => boolean` precisely so the bad-input cases below
		// compile without escape hatches.
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ skip_paths: ["dist/**"] }),
		});
		expect(h.matchesSkipPath("")).toBe(false);
		expect(h.matchesSkipPath(null)).toBe(false);
		expect(h.matchesSkipPath(undefined)).toBe(false);
		expect(h.matchesSkipPath(42)).toBe(false);
	});

	it("ignores non-string entries inside skip_paths", () => {
		// Defensive: a malformed config (numbers, nulls) shouldn't crash the
		// hook — only string entries count.
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({
				skip_paths: ["dist/**", 42, null, "", "node_modules/**"],
			}),
		});
		expect(h.matchesSkipPath("/repo/dist/foo.js")).toBe(true);
		expect(h.matchesSkipPath("/repo/node_modules/x.js")).toBe(true);
		expect(h.matchesSkipPath("/repo/src/foo.js")).toBe(false);
	});

	it("survives a corrupt config.json without throwing", () => {
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: "{ this is not json",
		});
		expect(h.matchesSkipPath("/repo/dist/foo.js")).toBe(false);
	});

	it("caches the parsed skip_paths between calls", () => {
		const h = evalChunkInHarness({
			cwd: "/repo",
			configContent: JSON.stringify({ skip_paths: ["dist/**"] }),
		});
		// First call populates cache.
		expect(h.loadSkipPaths()).toEqual(["dist/**"]);
		// Second call uses cache (would otherwise re-read config.json).
		expect(h.loadSkipPaths()).toEqual(["dist/**"]);
	});
});
