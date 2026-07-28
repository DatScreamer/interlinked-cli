// Phase A2 — tests for `entry-points.ts::collectEntryPoints`.
//
// Three sources cover-tested with ≥4 cases each (per Phase A2 plan):
//   - bin (string and map shapes, missing files, no package.json)
//   - lib_export (main, exports.import, exports subpath, package-root index)
//   - http_handler (RouteMap stub returns two endpoints)
// Plus the `includeTests` opt-in path and the dedupe contract.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nonNull } from "../../lib/non-null.js";
import type { EntryPoint } from "../entry-points.js";
import { collectEntryPoints } from "../entry-points.js";
import { RouteMap } from "../route-map.js";

let workdir: string;

function writePkg(extra: Record<string, unknown>): void {
	writeFileSync(
		join(workdir, "package.json"),
		JSON.stringify({ name: "x", version: "0.0.0", ...extra }),
	);
}

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), "interlinked-entry-points-"));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// bin source
// ---------------------------------------------------------------------------

describe("collectEntryPoints — bin source", () => {
	it("extracts a bin entry from a single-string package.json:bin", () => {
		writePkg({ bin: "./cli.js" });
		writeFileSync(join(workdir, "cli.js"), "// cli");

		const eps = collectEntryPoints(workdir);
		const bin = eps.filter((e) => e.kind === "bin");
		expect(bin).toHaveLength(1);
		expect(nonNull(bin[0]).file).toBe(join(workdir, "cli.js"));
		expect(nonNull(bin[0]).reason).toBe("package.json:bin");
	});

	it("extracts each entry from a map-shape package.json:bin", () => {
		writePkg({ bin: { foo: "./bin/foo.js", bar: "./bin/bar.js" } });
		mkdirSync(join(workdir, "bin"), { recursive: true });
		writeFileSync(join(workdir, "bin", "foo.js"), "// foo");
		writeFileSync(join(workdir, "bin", "bar.js"), "// bar");

		const eps = collectEntryPoints(workdir);
		const bin = eps.filter((e) => e.kind === "bin");
		expect(bin).toHaveLength(2);
		expect(bin.map((e) => e.reason).sort()).toEqual([
			"package.json:bin[bar]",
			"package.json:bin[foo]",
		]);
	});

	it("skips bin entries whose target file does not exist", () => {
		writePkg({ bin: "./missing.js" });
		const eps = collectEntryPoints(workdir);
		expect(eps.filter((e) => e.kind === "bin")).toHaveLength(0);
	});

	it("returns no bin entries when package.json is absent", () => {
		const eps = collectEntryPoints(workdir);
		expect(eps.filter((e) => e.kind === "bin")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// lib_export source
// ---------------------------------------------------------------------------

describe("collectEntryPoints — lib_export source", () => {
	it("extracts package.json:main when present and reachable", () => {
		writePkg({ main: "./dist/main.js" });
		mkdirSync(join(workdir, "dist"), { recursive: true });
		writeFileSync(join(workdir, "dist", "main.js"), "// main");

		const eps = collectEntryPoints(workdir);
		const lib = eps.filter((e) => e.kind === "lib_export");
		expect(lib).toHaveLength(1);
		expect(nonNull(lib[0]).file).toBe(join(workdir, "dist", "main.js"));
		expect(nonNull(lib[0]).reason).toBe("package.json:main");
	});

	it("walks package.json:exports.import / .require / subpath targets", () => {
		writePkg({
			exports: {
				".": { import: "./dist/index.mjs", require: "./dist/index.cjs" },
				"./extra": "./dist/extra.js",
			},
		});
		mkdirSync(join(workdir, "dist"), { recursive: true });
		writeFileSync(join(workdir, "dist", "index.mjs"), "// mjs");
		writeFileSync(join(workdir, "dist", "index.cjs"), "// cjs");
		writeFileSync(join(workdir, "dist", "extra.js"), "// extra");

		const eps = collectEntryPoints(workdir);
		const lib = eps.filter((e) => e.kind === "lib_export");
		const reasons = lib.map((e) => e.reason).sort();
		expect(reasons.some((r) => r.includes("exports.."))).toBe(true);
		expect(reasons.some((r) => r.includes("exports../extra"))).toBe(true);
		// All three target files surfaced.
		const files = lib.map((e) => e.file).sort();
		expect(files).toContain(join(workdir, "dist", "index.mjs"));
		expect(files).toContain(join(workdir, "dist", "index.cjs"));
		expect(files).toContain(join(workdir, "dist", "extra.js"));
	});

	it("adds a package-root index.* if not already named by main/exports", () => {
		writePkg({});
		writeFileSync(join(workdir, "index.ts"), "// root index");

		const eps = collectEntryPoints(workdir);
		const lib = eps.filter((e) => e.kind === "lib_export");
		expect(lib.some((e) => e.file === join(workdir, "index.ts"))).toBe(true);
		expect(lib.some((e) => e.reason === "index.ts at package root")).toBe(true);
	});

	it("does not duplicate index.* when main already names it", () => {
		writePkg({ main: "./index.ts" });
		writeFileSync(join(workdir, "index.ts"), "// dual purpose");

		const eps = collectEntryPoints(workdir);
		const lib = eps.filter(
			(e: EntryPoint) => e.kind === "lib_export" && e.file === join(workdir, "index.ts"),
		);
		// Exactly one record — `package.json:main` named it first, so the root-index
		// pass should NOT re-add it.
		expect(lib).toHaveLength(1);
		expect(nonNull(lib[0]).reason).toBe("package.json:main");
	});
});

// ---------------------------------------------------------------------------
// http_handler source
// ---------------------------------------------------------------------------

describe("collectEntryPoints — http_handler source", () => {
	it("returns no http_handler entries when no RouteMap is supplied", () => {
		writePkg({});
		const eps = collectEntryPoints(workdir);
		expect(eps.filter((e) => e.kind === "http_handler")).toHaveLength(0);
	});

	it("surfaces every endpoint from the supplied RouteMap as a separate entry", () => {
		// Note: no package.json in this test — framework detection is purely
		// content-driven for Express/Hono/MCP, and the fewer files in the
		// tmpdir the less interference there is from path-based detection.
		const apiFile = join(workdir, "api.ts");
		// Matches the route-extraction shape used by route-map.test.ts so
		// the Express adapter recognizes both registrations.
		writeFileSync(
			apiFile,
			[
				"const app = express();",
				"function getHealth(req, res) { res.json({}); }",
				"app.get('/health', getHealth);",
				"app.post('/users', (req, res) => res.json({}));",
			].join("\n"),
		);
		const routeMap = new RouteMap(workdir);
		routeMap.initialize([apiFile]);
		// Sanity: the RouteMap saw 2 endpoints. If this assertion fires it
		// means the adapter's regex didn't match — fix the fixture, not
		// `collectEntryPoints`.
		expect(routeMap.extractAllEndpoints().length).toBeGreaterThanOrEqual(2);

		const eps = collectEntryPoints(workdir, { routeMap });
		const http = eps.filter((e) => e.kind === "http_handler");
		expect(http.length).toBeGreaterThanOrEqual(2);
		expect(http.every((e) => e.file === apiFile)).toBe(true);
		const reasons = http.map((e) => e.reason).join(" | ");
		expect(reasons).toContain("/health");
		expect(reasons).toContain("/users");
	});

	it("encodes framework / method / path in the reason string", () => {
		writePkg({});
		const apiFile = join(workdir, "api.ts");
		writeFileSync(apiFile, "app.get('/foo', (req, res) => res.json({}));");
		const routeMap = new RouteMap(workdir);
		routeMap.initialize([apiFile]);

		const eps = collectEntryPoints(workdir, { routeMap });
		const http = eps.filter((e) => e.kind === "http_handler");
		expect(http.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(http[0]).reason).toMatch(/express GET \/foo/);
	});

	it("returns an empty list when the RouteMap has no endpoints", () => {
		writePkg({});
		const routeMap = new RouteMap(workdir);
		// Initialize with no files — nothing to extract.
		routeMap.initialize([]);

		const eps = collectEntryPoints(workdir, { routeMap });
		expect(eps.filter((e) => e.kind === "http_handler")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// includeTests opt-in + dedupe contract
// ---------------------------------------------------------------------------

describe("collectEntryPoints — opt-in tests and dedupe", () => {
	it("test files are excluded by default", () => {
		writePkg({});
		mkdirSync(join(workdir, "src", "__tests__"), { recursive: true });
		writeFileSync(join(workdir, "src", "__tests__", "x.test.ts"), "// test");

		const eps = collectEntryPoints(workdir);
		expect(eps.filter((e) => e.kind === "test")).toHaveLength(0);
	});

	it("test files surface when includeTests=true", () => {
		writePkg({});
		mkdirSync(join(workdir, "src", "__tests__"), { recursive: true });
		writeFileSync(join(workdir, "src", "__tests__", "thing.test.ts"), "// test");

		const eps = collectEntryPoints(workdir, { includeTests: true });
		const tests = eps.filter((e) => e.kind === "test");
		expect(tests).toHaveLength(1);
		expect(nonNull(tests[0]).file).toBe(join(workdir, "src", "__tests__", "thing.test.ts"));
	});

	it("collapses duplicate (kind, file) records but keeps cross-kind duplicates", () => {
		writePkg({ bin: "./dual.js", main: "./dual.js" });
		writeFileSync(join(workdir, "dual.js"), "// dual purpose");

		const eps = collectEntryPoints(workdir);
		const dualPath = join(workdir, "dual.js");
		const matches = eps.filter((e: EntryPoint) => e.file === dualPath);
		const kinds = matches.map((m) => m.kind).sort();
		expect(kinds).toEqual(["bin", "lib_export"]);
	});

	it("returns an empty list when nothing matches any source", () => {
		// No package.json, no route map, no tests requested → entirely empty.
		const eps = collectEntryPoints(workdir);
		expect(eps).toEqual([]);
	});
});
