// ===========================================
// interlinked structure — behavioral coverage
// ===========================================
// Drives every branch of the six exported `structure*Command` handlers in
// ./structure.ts. The module lazy-imports every harness/structure/* helper
// (dynamic `await import(...)`) to keep startup fast; vi.mock intercepts those
// specifiers the same as static imports, so each harness boundary is scripted
// deterministically with zero real I/O:
//   - ../lib/formatter        → identity `c.*` (assert raw substrings, no ANSI)
//   - node:fs                 → virtual filesystem (existsSync/readFileSync/
//                               writeFileSync/mkdirSync/rmSync)
//   - node:child_process      → execSync (git rev-parse stub / throw path)
//   - ../harness/structure/*  → loader, cache-manager, artifact-graph,
//                               extractors, structure-checks, schema-validator,
//                               rules — each a vi.fn we set per-test
// We assert real emitted strings (console.log / console.error), the JSON shape
// under --json, written-file side-effects, process.exitCode on the error/fatal
// paths, and EVERY branch (subcommands, dry-run vs --write, incremental vs full,
// ternaries, &&/||/?? short-circuits, catch handlers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AdoptionReport,
	ArtifactNode,
	BaselineFile,
	CatalogMeta,
	CategoryCatalog,
	StructureConfig,
	StructureFinding,
} from "../harness/structure/types.js";

// ---- ../lib/formatter mock: identity pass-through ----------------------
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
		cyan: (s: string) => s,
	},
}));

// ---- node:fs mock: virtual filesystem ---------------------------------
// fsFiles maps absolute path -> contents. existsSync = key present. writes
// mutate fsFiles; mkdirSync records dirs; rmSync deletes; fsReadThrows forces
// a read failure (parse/IO path).
let fsFiles: Record<string, string>;
let fsReadThrows: Set<string>;
let mkdirCalls: string[];
let mkdirThrows: string | null;
let writeCalls: Array<{ path: string; data: string }>;
let rmCalls: string[];

vi.mock("node:fs", () => ({
	existsSync: (p: string) => p in fsFiles,
	readFileSync: (p: string) => {
		if (fsReadThrows.has(p)) throw new Error(`EACCES ${p}`);
		if (!(p in fsFiles)) throw new Error(`ENOENT ${p}`);
		return fsFiles[p];
	},
	writeFileSync: (p: string, data: string) => {
		fsFiles[p] = data;
		writeCalls.push({ path: p, data });
	},
	mkdirSync: (p: string) => {
		if (mkdirThrows) throw new Error(mkdirThrows);
		mkdirCalls.push(p);
	},
	rmSync: (p: string) => {
		rmCalls.push(p);
		delete fsFiles[p];
	},
}));

// ---- node:child_process mock: git rev-parse ---------------------------
const execSyncMock = vi.fn<(cmd: string) => string>();
vi.mock("node:child_process", () => ({
	execSync: (cmd: string) => execSyncMock(cmd),
}));

// ---- ../harness/structure/* mocks -------------------------------------
// Each scripted helper is a vi.fn the tests set per-case.
const loadStructureConfig = vi.fn();
const getImplicitConfig = vi.fn();
const loadArtifactFile = vi.fn();
vi.mock("../harness/structure/structure-loader.js", () => ({
	loadStructureConfig: (...a: unknown[]) => loadStructureConfig(...a),
	getImplicitConfig: () => getImplicitConfig(),
	loadArtifactFile: (...a: unknown[]) => loadArtifactFile(...a),
}));

const readCatalogMeta = vi.fn();
const readAdoptionReport = vi.fn();
const isCacheStale = vi.fn();
const computeManifestHash = vi.fn();
const ensureCacheDir = vi.fn();
const writeCatalogMeta = vi.fn();
const writeCategoryCache = vi.fn();
const writeAdoptionReport = vi.fn();
const readCategoryCache = vi.fn();
const readBaseline = vi.fn();
const writeBaseline = vi.fn();
vi.mock("../harness/structure/cache-manager.js", () => ({
	readCatalogMeta: (...a: unknown[]) => readCatalogMeta(...a),
	readAdoptionReport: (...a: unknown[]) => readAdoptionReport(...a),
	isCacheStale: (...a: unknown[]) => isCacheStale(...a),
	computeManifestHash: (...a: unknown[]) => computeManifestHash(...a),
	ensureCacheDir: (...a: unknown[]) => ensureCacheDir(...a),
	writeCatalogMeta: (...a: unknown[]) => writeCatalogMeta(...a),
	writeCategoryCache: (...a: unknown[]) => writeCategoryCache(...a),
	writeAdoptionReport: (...a: unknown[]) => writeAdoptionReport(...a),
	readCategoryCache: (...a: unknown[]) => readCategoryCache(...a),
	readBaseline: (...a: unknown[]) => readBaseline(...a),
	writeBaseline: (...a: unknown[]) => writeBaseline(...a),
}));

// A tiny in-memory ArtifactGraph stand-in. The handlers only use addNode,
// addEdge, getNodesByKind, toNodesJson, toEdgesJson, nodeCount, edgeCount.
class FakeGraph {
	nodes: ArtifactNode[] = [];
	edges: Array<{ id: string; provenance: string }> = [];
	addNode(n: ArtifactNode): void {
		this.nodes.push(n);
	}
	addEdge(e: { id: string; provenance: string }): void {
		this.edges.push(e);
	}
	getNodesByKind(kind: string): ArtifactNode[] {
		return this.nodes.filter((n) => n.kind === kind);
	}
	toNodesJson(): { nodes: ArtifactNode[] } {
		return { nodes: this.nodes };
	}
	toEdgesJson(): { edges: Array<{ id: string; provenance: string }> } {
		return { edges: this.edges };
	}
	get nodeCount(): number {
		return this.nodes.length;
	}
	get edgeCount(): number {
		return this.edges.length;
	}
}
vi.mock("../harness/structure/artifact-graph.js", () => ({
	ArtifactGraph: FakeGraph,
}));

const runAllExtractors = vi.fn();
vi.mock("../harness/structure/extractors/index.js", () => ({
	runAllExtractors: (...a: unknown[]) => runAllExtractors(...a),
}));

const layerDeclaredArtifacts = vi.fn();
vi.mock("../harness/structure/structure-checks.js", () => ({
	layerDeclaredArtifacts: (...a: unknown[]) => layerDeclaredArtifacts(...a),
}));

const validateStructureJson = vi.fn();
vi.mock("../harness/structure/schema-validator.js", () => ({
	validateStructureJson: (...a: unknown[]) => validateStructureJson(...a),
}));

const evaluateStructureRules = vi.fn();
vi.mock("../harness/structure/rules/index.js", () => ({
	evaluateStructureRules: (...a: unknown[]) => evaluateStructureRules(...a),
}));

import { nonNull } from "../lib/non-null.js";
import {
	structureAcceptCommand,
	structureBaselineCommand,
	structureDoctorCommand,
	structureInitCommand,
	structureScanCommand,
	structureStatusCommand,
} from "./structure.js";

// --- console capture ---------------------------------------------------
let logged: string[];
let errored: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function stdout(): string {
	return logged.join("\n");
}
function stderr(): string {
	return errored.join("\n");
}

const CWD = "/proj";

// --- fixtures ----------------------------------------------------------
function fullConfig(over: Partial<StructureConfig> = {}): StructureConfig {
	return {
		version: 1,
		mode: "standard",
		artifacts: {},
		verify: {
			fail_on_deterministic: true,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: {
			emit_deterministic: true,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 5,
		},
		adoption: {
			coverage_thresholds: {
				public_api: 0,
				env: 0,
				config: 0,
				tests: 0,
				docs: 0,
				examples: 0,
				glossary: 0,
				layers: 0,
				packages: 0,
			},
		},
		builtins: {
			public_symbol_companions: true,
			env_key_companions: true,
			config_key_companions: true,
			layer_boundary_violations: true,
			glossary_residue: true,
			package_boundary_violations: true,
		},
		...over,
	};
}

function meta(over: Partial<CatalogMeta> = {}): CatalogMeta {
	return {
		schema_version: 1,
		cli_version: "0.0.0",
		built_at: "2026-01-01T00:00:00.000Z",
		repo_root: CWD,
		last_scanned_commit: "abc",
		manifest_hash: "hash",
		extractor_versions: {},
		...over,
	};
}

function node(over: Partial<ArtifactNode> = {}): ArtifactNode {
	return {
		id: "module:m",
		kind: "module",
		label: "m",
		file: "src/m.ts",
		provenance: "extracted",
		determinism_ceiling: "fully_deterministic",
		...over,
	};
}

function catalog(items: CategoryCatalog["items"]): CategoryCatalog {
	return { schema_version: 1, items };
}

beforeEach(() => {
	fsFiles = {};
	fsReadThrows = new Set();
	mkdirCalls = [];
	mkdirThrows = null;
	writeCalls = [];
	rmCalls = [];
	logged = [];
	errored = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errored.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	});

	// Reset every scripted helper + neutral defaults.
	for (const fn of [
		loadStructureConfig,
		getImplicitConfig,
		loadArtifactFile,
		readCatalogMeta,
		readAdoptionReport,
		isCacheStale,
		computeManifestHash,
		ensureCacheDir,
		writeCatalogMeta,
		writeCategoryCache,
		writeAdoptionReport,
		readCategoryCache,
		readBaseline,
		writeBaseline,
		runAllExtractors,
		layerDeclaredArtifacts,
		validateStructureJson,
		evaluateStructureRules,
		execSyncMock,
	])
		fn.mockReset();

	getImplicitConfig.mockReturnValue(fullConfig({ mode: "minimal" }));
	loadStructureConfig.mockReturnValue({ config: null, errors: [], implicit: true });
	computeManifestHash.mockReturnValue("hash");
	execSyncMock.mockReturnValue("deadbeef\n");
	vi.spyOn(process, "cwd").mockReturnValue(CWD);

	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

// ===========================================
// 1. structure init
// ===========================================

describe("structureInitCommand", () => {
	it("dry-run (no --write) lists files with create/overwrite tags and the --write hint", async () => {
		await structureInitCommand({});
		const o = stdout();
		expect(o).toContain("Structure init (dry-run)");
		expect(o).toContain("Mode: standard");
		expect(o).toContain("Categories: (none)");
		// structure.json does not exist -> "create" tag
		expect(o).toContain("create  interlinked/structure.json");
		expect(o).toContain("Run with --write to create files.");
		// dry-run never writes
		expect(writeCalls).toHaveLength(0);
	});

	it("dry-run marks an existing target as 'overwrite'", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{}";
		await structureInitCommand({});
		expect(stdout()).toContain("overwrite  interlinked/structure.json");
	});

	it("dry-run --json emits the planned shape", async () => {
		await structureInitCommand({ json: true, with: "env, docs" });
		const parsed = JSON.parse(stdout());
		expect(parsed).toEqual({
			dry_run: true,
			mode: "standard",
			categories: ["env", "docs"],
			files: [
				"interlinked/structure.json",
				"interlinked/artifacts/env.json",
				"interlinked/artifacts/docs.json",
			],
		});
	});

	it("--write creates structure.json + scaffolds and prints next-step hint", async () => {
		await structureInitCommand({ write: true, mode: "strict", with: "public_api" });
		const o = stdout();
		expect(o).toContain("Structure initialized.");
		expect(o).toContain("Mode: strict");
		expect(o).toContain("Artifacts: public_api");
		expect(o).toContain("interlinked structure scan");
		// structure.json carries mode + artifacts map; scaffold file written too
		const cfgWrite = writeCalls.find((w) => w.path === `${CWD}/interlinked/structure.json`);
		expect(cfgWrite).toBeDefined();
		expect(JSON.parse((cfgWrite as { data: string }).data)).toEqual({
			version: 1,
			mode: "strict",
			artifacts: { public_api: "artifacts/public-api.json" },
		});
		expect(
			writeCalls.some((w) => w.path === `${CWD}/interlinked/artifacts/public-api.json`),
		).toBe(true);
	});

	it("--write with no categories omits the artifacts key and the Artifacts line", async () => {
		await structureInitCommand({ write: true });
		const cfgWrite = writeCalls.find((w) => w.path === `${CWD}/interlinked/structure.json`);
		expect(JSON.parse((cfgWrite as { data: string }).data)).toEqual({ version: 1, mode: "standard" });
		expect(stdout()).not.toContain("Artifacts:");
	});

	it("--write --json reports created:true", async () => {
		await structureInitCommand({ write: true, json: true });
		expect(JSON.parse(stdout())).toEqual({
			created: true,
			mode: "standard",
			categories: [],
			files: ["interlinked/structure.json"],
		});
	});

	it("rejects an invalid mode via fatal (exitCode 1, no throw escaping)", async () => {
		await structureInitCommand({ mode: "bogus" });
		expect(stderr()).toContain('Invalid mode "bogus"');
		expect(stderr()).toContain("minimal, standard, strict");
		expect(process.exitCode).toBe(1);
	});

	it("rejects an unknown category via fatal", async () => {
		await structureInitCommand({ with: "nope" });
		expect(stderr()).toContain('Unknown category "nope"');
		expect(process.exitCode).toBe(1);
	});

	it("catch path: a non-fatal throw is reported and sets exitCode 1", async () => {
		// Force writeJson -> writeFileSync to throw on the --write branch.
		const boom = `${CWD}/interlinked/structure.json`;
		const realWrite = writeCalls;
		void realWrite;
		// Make the FS write throw by replacing fsFiles with a trapped proxy isn't
		// straightforward; instead drive a throw from VALID_MODES import path is
		// impossible. Use execSync? Not in init. Simplest: make mkdirSync throw.
		mkdirCalls = new Proxy([], {
			get() {
				throw new Error("disk full");
			},
		}) as unknown as string[];
		await structureInitCommand({ write: true });
		expect(stderr()).toContain("structure init failed: disk full");
		expect(process.exitCode).toBe(1);
		void boom;
	});
});

// ===========================================
// 2. structure scan
// ===========================================

describe("structureScanCommand", () => {
	function primeExtractors(nodes: ArtifactNode[] = [node()]): void {
		runAllExtractors.mockReturnValue({ nodes, edges: [{ id: "e1", provenance: "extracted" }] });
	}

	it("full scan (no cache) writes caches, adoption, meta and prints summary", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		const o = stdout();
		expect(o).toContain("Scan complete.");
		expect(o).toContain("full scan");
		expect(o).toContain("Nodes:   1");
		expect(o).toContain("Edges:   1");
		expect(ensureCacheDir).toHaveBeenCalledWith(CWD);
		expect(writeCatalogMeta).toHaveBeenCalledTimes(1);
		expect(writeAdoptionReport).toHaveBeenCalledTimes(1);
		expect(layerDeclaredArtifacts).toHaveBeenCalledTimes(1);
		// git commit captured from execSync
		const writtenMeta = (writeCatalogMeta.mock.calls[0] as unknown[])[1] as CatalogMeta;
		expect(writtenMeta.last_scanned_commit).toBe("deadbeef");
	});

	it("incremental default kicks in when a cache exists", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(meta());
		await structureScanCommand({});
		expect(stdout()).toContain("incremental scan");
	});

	it("--full forces a full scan even when a cache exists", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(meta());
		await structureScanCommand({ full: true });
		expect(stdout()).toContain("full scan");
	});

	it("--incremental with no cache prints the fallback notice", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({ incremental: true });
		expect(stdout()).toContain("No cache found. Running full scan.");
		// incremental requested but reported as incremental mode (opts.incremental wins)
		expect(stdout()).toContain("incremental scan");
	});

	it("surfaces loader errors as warnings and uses the loaded config mode", async () => {
		primeExtractors();
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "strict" }),
			errors: ["bad-thing"],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stderr()).toContain("Warning: bad-thing");
		expect(stdout()).toContain("Config:  strict");
	});

	it("git unavailable: execSync throws, last_scanned_commit stays empty", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(null);
		execSyncMock.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		await structureScanCommand({});
		const writtenMeta = (writeCatalogMeta.mock.calls[0] as unknown[])[1] as CatalogMeta;
		expect(writtenMeta.last_scanned_commit).toBe("");
		expect(stdout()).toContain("Scan complete.");
	});

	it("--json emits the summary object", async () => {
		primeExtractors([node(), node({ id: "module:m2", label: "m2" })]);
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.mode).toBe("full");
		expect(parsed.nodes).toBe(2);
		expect(parsed.config_mode).toBe("minimal");
		expect(typeof parsed.elapsed_ms).toBe("number");
	});

	it("adoption: declared nodes contribute a non-zero ratio per category", async () => {
		// Two public_symbol nodes, one declared -> 0.5 adoption for public_api.
		runAllExtractors.mockReturnValue({
			nodes: [
				node({ id: "public_symbol:a#x", kind: "public_symbol", provenance: "declared" }),
				node({ id: "public_symbol:a#y", kind: "public_symbol", provenance: "extracted" }),
			],
			edges: [],
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		const report = (writeAdoptionReport.mock.calls[0] as unknown[])[1] as AdoptionReport;
		expect(report.categories.public_api).toBe(0.5);
		// a category with no nodes is 0
		expect(report.categories.docs).toBe(0);
	});

	it("node id without a ':' keeps its full id as the local_id (extractLocalId else)", async () => {
		runAllExtractors.mockReturnValue({
			nodes: [node({ id: "noColon", kind: "module", label: "noColon" })],
			edges: [],
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		// the artifact-nodes cache write carries local_id === full id (no prefix stripped)
		const nodesWrite = writeCategoryCache.mock.calls.find(
			(call) => (call as unknown[])[1] === "artifact-nodes",
		);
		const payload = (nodesWrite as unknown[])[2] as CategoryCatalog;
		expect(nonNull(payload.items[0]).local_id).toBe("noColon");
		expect(nonNull(payload.items[0]).global_ref).toBe("noColon");
	});

	it("catch path: extractor throwing sets exitCode 1 + structured error", async () => {
		runAllExtractors.mockImplementation(() => {
			throw new Error("extractor boom");
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stderr()).toContain("structure scan failed: extractor boom");
		expect(process.exitCode).toBe(1);
	});

	it("catch path: a throw with exitCode already 1 returns silently (no double-report)", async () => {
		// Simulate a downstream helper that set exitCode=1 (a fatal-style signal)
		// before throwing: the scan catch's `if (process.exitCode === 1) return`
		// must swallow it without emitting a second "scan failed" line.
		runAllExtractors.mockImplementation(() => {
			process.exitCode = 1;
			throw new Error("already-handled");
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stderr()).not.toContain("structure scan failed");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 3. structure status
// ===========================================

describe("structureStatusCommand", () => {
	it("implicit, no cache: prints not-built + implicit tag", async () => {
		readCatalogMeta.mockReturnValue(null);
		readAdoptionReport.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		await structureStatusCommand({});
		const o = stdout();
		expect(o).toContain("Structure Status");
		expect(o).toContain("Mode:     minimal (implicit, no structure.json)");
		expect(o).toContain("Cache:    not built");
	});

	it("fresh cache: Cache fresh + Built line + adoption table", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "standard" }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(meta({ built_at: "2026-02-02T00:00:00.000Z" }));
		isCacheStale.mockReturnValue(false);
		// 0.9 -> green (>=80), 0.6 -> yellow (>=50), 0.1 -> red (<50): all three
		// pctColor arms exercised in one render.
		readAdoptionReport.mockReturnValue({
			schema_version: 1,
			categories: { public_api: 0.9, env: 0.6, docs: 0.1 },
		} as unknown as AdoptionReport);
		await structureStatusCommand({});
		const o = stdout();
		expect(o).toContain("Cache:    fresh");
		expect(o).toContain("Built:    2026-02-02T00:00:00.000Z");
		expect(o).toContain("Adoption:");
		expect(o).toContain("public_api");
		expect(o).toContain("90%");
		expect(o).toContain("60%");
		expect(o).toContain("10%");
		// not implicit -> no implicit tag
		expect(o).not.toContain("(implicit");
	});

	it("stale cache: Cache stale", async () => {
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		await structureStatusCommand({});
		expect(stdout()).toContain("Cache:    stale");
	});

	it("invalid manifest references + loader errors are listed", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { env: "artifacts/env.json" } }),
			errors: ["loader-err"],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		// env.json does NOT exist in fsFiles -> flagged invalid
		await structureStatusCommand({});
		const o = stdout();
		expect(o).toContain("Invalid manifest references:");
		expect(o).toContain("missing  env: interlinked/artifacts/env.json");
		expect(o).toContain("error  loader-err");
	});

	it("a declared artifact that exists on disk is NOT flagged invalid", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { env: "artifacts/env.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/env.json`] = "{}";
		readCatalogMeta.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		await structureStatusCommand({});
		expect(stdout()).not.toContain("Invalid manifest references:");
	});

	it("--json returns the full data object and emits no human text", async () => {
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		readAdoptionReport.mockReturnValue({
			schema_version: 1,
			categories: { docs: 0.5 },
		} as unknown as AdoptionReport);
		await structureStatusCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.config_mode).toBe("minimal");
		expect(parsed.implicit).toBe(true);
		expect(parsed.cache_exists).toBe(true);
		expect(parsed.cache_stale).toBe(false);
		expect(parsed.cache_built_at).toBe("2026-01-01T00:00:00.000Z");
		expect(parsed.adoption).toEqual({ docs: 0.5 });
		expect(parsed.invalid_files).toEqual([]);
	});

	it("--json with no cache reports cache_built_at null + adoption null", async () => {
		readCatalogMeta.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		await structureStatusCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.cache_built_at).toBeNull();
		expect(parsed.adoption).toBeNull();
		expect(parsed.cache_stale).toBe(true);
	});

	it("catch path: loader throwing sets exitCode 1", async () => {
		loadStructureConfig.mockImplementation(() => {
			throw new Error("status boom");
		});
		await structureStatusCommand({});
		expect(stderr()).toContain("structure status failed: status boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 4. structure accept
// ===========================================

describe("structureAcceptCommand", () => {
	it("nothing cached: prints the 'Nothing to accept' hint", async () => {
		readCategoryCache.mockReturnValue(null);
		await structureAcceptCommand({});
		expect(stdout()).toContain("Nothing to accept. Run `interlinked structure scan` first.");
	});

	it("accepts new public symbols into a fresh public-api file", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "pkg-index#createClient",
							global_ref: "public_symbol:pkg-index#createClient",
							file: "src/index.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const o = stdout();
		expect(o).toContain("Structure Accept");
		expect(o).toContain("accepted  public_api: 1 items");
		// public-api.json written with the new module/symbol
		const w = writeCalls.find((x) => x.path.endsWith("artifacts/public-api.json"));
		expect(w).toBeDefined();
		const file = JSON.parse((w as { data: string }).data);
		expect(file.modules[0].id).toBe("pkg-index");
		expect(file.modules[0].symbols[0].name).toBe("createClient");
	});

	it("skips a symbol already declared (dedup) and reports the skip", async () => {
		// Pre-existing public-api.json already declares pkg#x.
		const apiPath = `${CWD}/interlinked/artifacts/public-api.json`;
		fsFiles[apiPath] = JSON.stringify({
			version: 1,
			modules: [{ id: "pkg", file: "src/pkg.ts", symbols: [{ name: "x" }] }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "pkg#x",
							global_ref: "public_symbol:pkg#x",
							file: "src/pkg.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const o = stdout();
		expect(o).toContain("Skipped (already declared):");
		expect(o).toContain("skip  public_api/pkg#x: already declared");
		// nothing new accepted -> file not rewritten
		expect(writeCalls.some((x) => x.path === apiPath)).toBe(false);
	});

	it("symbol local_id without a '#' becomes its own module id and symbol", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "bareName",
							global_ref: "public_symbol:bareName",
							file: "src/bare.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const w = writeCalls.find((x) => x.path.endsWith("artifacts/public-api.json"));
		const file = JSON.parse((w as { data: string }).data);
		expect(file.modules[0].id).toBe("bareName");
		expect(file.modules[0].symbols[0].name).toBe("bareName");
	});

	it("accepts new env keys and skips existing ones", async () => {
		const envPath = `${CWD}/interlinked/artifacts/env.json`;
		fsFiles[envPath] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "OLD_KEY" }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "env-keys"
				? catalog([
						{
							local_id: "NEW_KEY",
							global_ref: "env_key:NEW_KEY",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
						{
							local_id: "OLD_KEY",
							global_ref: "env_key:OLD_KEY",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const o = stdout();
		expect(o).toContain("accepted  env: 1 items");
		expect(o).toContain("skip  env/OLD_KEY: already declared");
		const w = writeCalls.find((x) => x.path === envPath);
		const file = JSON.parse((w as { data: string }).data);
		expect(file.keys.map((k: { name: string }) => k.name)).toEqual(["OLD_KEY", "NEW_KEY"]);
	});

	it("uses the configured artifact paths when structure.json declares them", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { public_api: "custom/api.json" } }),
			errors: [],
			implicit: false,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		expect(writeCalls.some((x) => x.path === `${CWD}/interlinked/custom/api.json`)).toBe(true);
	});

	it("truncates the skip list past 10 and prints '... and N more'", async () => {
		// 12 already-declared symbols -> all skipped, list truncated at 10.
		const mods = Array.from({ length: 12 }, (_, i) => ({
			id: `m${i}`,
			file: "src/x.ts",
			symbols: [{ name: "s" }],
		}));
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({
			version: 1,
			modules: mods,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog(
						Array.from({ length: 12 }, (_, i) => ({
							local_id: `m${i}#s`,
							global_ref: `public_symbol:m${i}#s`,
							file: "src/x.ts",
							provenance: "extracted" as const,
							determinism_ceiling: "fully_deterministic" as const,
						})),
					)
				: null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toContain("... and 2 more");
	});

	it("--json emits accepted + skipped arrays", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.accepted).toEqual([{ category: "public_api", count: 1 }]);
		expect(parsed.skipped).toEqual([]);
	});

	it("env cache present but with all keys already declared: nothing accepted, file untouched (n===0)", async () => {
		const envPath = `${CWD}/interlinked/artifacts/env.json`;
		fsFiles[envPath] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "EXISTING" }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "env-keys"
				? catalog([
						{
							local_id: "EXISTING",
							global_ref: "env_key:EXISTING",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		// all skipped -> n===0 -> env.json NOT rewritten
		expect(writeCalls.some((x) => x.path === envPath)).toBe(false);
		expect(stdout()).toContain("skip  env/EXISTING: already declared");
	});

	it("empty caches (present but zero items) accept nothing (length>0 guards both false)", async () => {
		// public-symbols and env-keys both present but with empty item lists ->
		// neither `*.items.length > 0` guard fires; result is the empty-accept hint.
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols" || name === "env-keys" ? catalog([]) : null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toContain("Nothing to accept. Run `interlinked structure scan` first.");
		expect(writeCalls).toHaveLength(0);
	});

	it("adds a new symbol to an already-present module (exercises the module .find hit)", async () => {
		// public-api.json already has module "pkg" with symbol "x"; the catalog
		// brings a SECOND symbol "y" on the SAME module -> the file.modules.find
		// callback must match the existing module and append to it.
		const apiPath = `${CWD}/interlinked/artifacts/public-api.json`;
		fsFiles[apiPath] = JSON.stringify({
			version: 1,
			modules: [{ id: "pkg", file: "src/pkg.ts", symbols: [{ name: "x" }] }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "pkg#y",
							global_ref: "public_symbol:pkg#y",
							file: "src/pkg.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const w = writeCalls.find((x) => x.path === apiPath);
		const file = JSON.parse((w as { data: string }).data);
		// Still one module, now two symbols.
		expect(file.modules).toHaveLength(1);
		expect(file.modules[0].symbols.map((s: { name: string }) => s.name)).toEqual(["x", "y"]);
	});

	it("corrupt artifact JSON falls back to an empty file (readJson catch)", async () => {
		// public-api.json exists but is unparseable -> readJson swallows + returns
		// the {version,modules:[]} fallback, so the symbol is accepted fresh.
		const apiPath = `${CWD}/interlinked/artifacts/public-api.json`;
		fsFiles[apiPath] = "{ this is not json";
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toContain("accepted  public_api: 1 items");
		const w = writeCalls.find((x) => x.path === apiPath);
		expect(JSON.parse((w as { data: string }).data).modules).toHaveLength(1);
	});

	it("catch path: cache read throwing sets exitCode 1", async () => {
		readCategoryCache.mockImplementation(() => {
			throw new Error("accept boom");
		});
		await structureAcceptCommand({});
		expect(stderr()).toContain("structure accept failed: accept boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 5. structure doctor
// ===========================================

describe("structureDoctorCommand", () => {
	it("clean repo (no structure.json, fresh cache): no issues", async () => {
		// structure.json absent -> info issue suppressed? No: doctorValidateConfig
		// returns an info issue when absent. So expect that info, plus a cache check.
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		loadArtifactFile.mockReturnValue({ data: null, errors: [] });
		await structureDoctorCommand({});
		const o = stdout();
		// the only issue is the implicit-mode info note
		expect(o).toContain("Structure Doctor: 1 issue(s)");
		expect(o).toContain("INFO  No interlinked/structure.json found (implicit minimal mode)");
	});

	it("reports invalid JSON in structure.json as an error and exits 1", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{ not json";
		fsReadThrows = new Set();
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("ERROR");
		expect(o).toContain("structure.json: invalid JSON");
		expect(process.exitCode).toBe(1);
	});

	it("reports schema-validation errors from a present, parseable structure.json", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1 });
		validateStructureJson.mockReturnValue({
			valid: false,
			errors: [{ path: ".mode", message: "required" }],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		expect(stdout()).toContain("structure.json .mode: required");
		expect(process.exitCode).toBe(1);
	});

	it("valid structure.json with no findings yields no config-validation error", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		loadArtifactFile.mockReturnValue({ data: null, errors: [] });
		await structureDoctorCommand({});
		expect(stdout()).toContain("Structure doctor: no issues found.");
		expect(process.exitCode).toBeUndefined();
	});

	it("missing artifact file => error; bad artifact-file errors => error", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { env: "artifacts/env.json", docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		// env.json missing on disk -> "Artifact file missing"
		// docs.json present but loadArtifactFile reports errors
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		loadArtifactFile.mockImplementation((_cwd: string, key: string) =>
			key === "docs" ? { data: null, errors: ["schema mismatch"] } : { data: null, errors: [] },
		);
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("Artifact file missing: interlinked/artifacts/env.json");
		expect(o).toContain("docs (artifacts/docs.json): schema mismatch");
		expect(process.exitCode).toBe(1);
	});

	it("warns on declared paths that do not exist on disk", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		// docs file loads with a declared path that is missing from disk
		loadArtifactFile.mockReturnValue({
			data: { docs: [{ file: "docs/missing.md" }, { root: "also/gone" }] },
			errors: [],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("WARN");
		expect(o).toContain("declared path not found: docs/missing.md");
		expect(o).toContain("declared path not found: also/gone");
		// warnings only -> no error exit
		expect(process.exitCode).toBeUndefined();
	});

	it("skips artifact entries whose declared path is falsy (empty string)", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			// env: "" is falsy -> both doctorCheckFiles and doctorCheckPaths `continue`.
			config: fullConfig({ artifacts: { env: "" } }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		// the falsy entry produced no file/path issues
		expect(o).not.toContain("Artifact file missing");
		expect(o).not.toContain("declared path not found");
		// loadArtifactFile never consulted for the empty entry
		expect(loadArtifactFile).not.toHaveBeenCalled();
	});

	it("a declared path that exists on disk produces no warning (existsSync true arm)", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		// the declared doc path DOES exist on disk -> existsSync true -> no warning
		fsFiles[`${CWD}/docs/present.md`] = "# present";
		loadArtifactFile.mockReturnValue({
			data: { docs: [{ file: "docs/present.md" }] },
			errors: [],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		expect(stdout()).not.toContain("declared path not found");
		expect(stdout()).toContain("Structure doctor: no issues found.");
	});

	it("ignores non-object items inside a declared path array", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		// docs array mixes a string and null (non-objects -> skipped) with one
		// real record whose file is missing on disk (-> the only warning).
		loadArtifactFile.mockReturnValue({
			data: { docs: ["just-a-string", null, { file: "docs/real-missing.md" }] },
			errors: [],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("declared path not found: docs/real-missing.md");
		// exactly one path-not-found warning (the non-objects contributed none)
		expect(o.match(/declared path not found/g)).toHaveLength(1);
	});

	it("warns when there is no scan cache", async () => {
		readCatalogMeta.mockReturnValue(null);
		await structureDoctorCommand({});
		expect(stdout()).toContain("No scan cache. Run `interlinked structure scan`.");
	});

	it("warns when the scan cache is stale", async () => {
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(true);
		await structureDoctorCommand({});
		expect(stdout()).toContain("Scan cache is stale. Re-run `interlinked structure scan`.");
	});

	it("--json emits issues + total", async () => {
		readCatalogMeta.mockReturnValue(null);
		await structureDoctorCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.total).toBe(parsed.issues.length);
		expect(parsed.issues.some((i: { message: string }) => i.message.includes("No scan cache"))).toBe(
			true,
		);
	});

	it("catch path: schema-validator throwing sets exitCode 1", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1 });
		validateStructureJson.mockImplementation(() => {
			throw new Error("doctor boom");
		});
		await structureDoctorCommand({});
		expect(stderr()).toContain("structure doctor failed: doctor boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 6. structure baseline
// ===========================================

describe("structureBaselineCommand", () => {
	function finding(over: Partial<StructureFinding> = {}): StructureFinding {
		return {
			name: "public_symbol_companions",
			severity: "warning",
			message: "missing companion",
			file: "src/m.ts",
			determinism: "fully_deterministic",
			provenance: "extracted",
			artifact_kind: "public_symbol",
			artifact_id: "m#s",
			required_updates: [{ file: "docs/m.md", kind: "doc", reason: "doc it" }],
			confidence: 1,
			...over,
		};
	}

	it("save: builds a baseline from rule findings and writes it", async () => {
		readCategoryCache.mockReturnValue(
			catalog([
				{
					local_id: "m#s",
					global_ref: "public_symbol:m#s",
					file: "src/m.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
		);
		evaluateStructureRules.mockReturnValue([finding(), finding({ name: "env_key_companions" })]);
		await structureBaselineCommand("save", {});
		const o = stdout();
		expect(o).toContain("Baseline saved.");
		expect(o).toContain("2 findings baselined.");
		expect(writeBaseline).toHaveBeenCalledTimes(1);
		const bl = (writeBaseline.mock.calls[0] as unknown[])[1] as BaselineFile;
		expect(bl.entries).toHaveLength(2);
		expect(bl.entries[0]).toMatchObject({
			finding_name: "public_symbol_companions",
			artifact_ref: "m#s",
			source_file: "src/m.ts",
			required_companion_files: ["docs/m.md"],
		});
	});

	it("save --json reports saved + entry_count", async () => {
		readCategoryCache.mockReturnValue(catalog([]));
		evaluateStructureRules.mockReturnValue([]);
		await structureBaselineCommand("save", { json: true });
		expect(JSON.parse(stdout())).toEqual({ saved: true, entry_count: 0 });
	});

	it("save with no scan cache => fatal exitCode 1", async () => {
		readCategoryCache.mockReturnValue(null);
		await structureBaselineCommand("save", {});
		expect(stderr()).toContain("No scan cache. Run `interlinked structure scan` first.");
		expect(process.exitCode).toBe(1);
		expect(writeBaseline).not.toHaveBeenCalled();
	});

	it("save: catalogToNode handles a global_ref with no ':' (kind defaults to module)", async () => {
		readCategoryCache.mockReturnValue(
			catalog([
				{
					local_id: "loose",
					global_ref: "loose",
					file: "src/loose.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
		);
		// Capture the graph passed to the rule evaluator to assert the node kind.
		let seenKind: string | undefined;
		evaluateStructureRules.mockImplementation((graph: FakeGraph) => {
			seenKind = graph.nodes[0]?.kind;
			return [];
		});
		await structureBaselineCommand("save", {});
		expect(seenKind).toBe("module");
	});

	it("clear: removes an existing baseline file", async () => {
		const p = `${CWD}/.interlinked/structure-cache/baseline.json`;
		fsFiles[p] = "{}";
		await structureBaselineCommand("clear", {});
		expect(rmCalls).toContain(p);
		expect(stdout()).toContain("Baseline cleared.");
	});

	it("clear when no baseline exists: reports nothing to clear", async () => {
		await structureBaselineCommand("clear", {});
		expect(rmCalls).toHaveLength(0);
		expect(stdout()).toContain("No baseline to clear.");
	});

	it("clear --json (present) emits cleared:true", async () => {
		fsFiles[`${CWD}/.interlinked/structure-cache/baseline.json`] = "{}";
		await structureBaselineCommand("clear", { json: true });
		expect(JSON.parse(stdout())).toEqual({ cleared: true });
	});

	it("clear --json (absent) emits cleared:false with reason", async () => {
		await structureBaselineCommand("clear", { json: true });
		expect(JSON.parse(stdout())).toEqual({ cleared: false, reason: "no baseline" });
	});

	it("status: empty baseline reports none saved", async () => {
		readBaseline.mockReturnValue({ schema_version: 1, entries: [] });
		await structureBaselineCommand("status", {});
		expect(stdout()).toContain("No baseline saved.");
	});

	it("status: groups entries by finding name", async () => {
		readBaseline.mockReturnValue({
			schema_version: 1,
			entries: [
				{ finding_name: "a", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
				{ finding_name: "a", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
				{ finding_name: "b", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
			],
		} as BaselineFile);
		await structureBaselineCommand("status", {});
		const o = stdout();
		expect(o).toContain("Baseline: 3 entries");
		expect(o).toMatch(/a\s+2/);
		expect(o).toMatch(/b\s+1/);
	});

	it("status --json (non-empty) emits by_finding map", async () => {
		readBaseline.mockReturnValue({
			schema_version: 1,
			entries: [
				{ finding_name: "x", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
			],
		} as BaselineFile);
		await structureBaselineCommand("status", { json: true });
		expect(JSON.parse(stdout())).toEqual({ exists: true, entry_count: 1, by_finding: { x: 1 } });
	});

	it("status --json (empty) emits exists:false", async () => {
		readBaseline.mockReturnValue({ schema_version: 1, entries: [] });
		await structureBaselineCommand("status", { json: true });
		expect(JSON.parse(stdout())).toEqual({ exists: false, entry_count: 0 });
	});

	it("unknown subcommand => fatal exitCode 1", async () => {
		await structureBaselineCommand("frobnicate", {});
		expect(stderr()).toContain('Unknown baseline subcommand "frobnicate"');
		expect(process.exitCode).toBe(1);
	});

	it("catch path (non-fatal): readBaseline throwing sets exitCode 1 with structured error", async () => {
		readBaseline.mockImplementation(() => {
			throw new Error("baseline boom");
		});
		await structureBaselineCommand("status", {});
		expect(stderr()).toContain("structure baseline failed: baseline boom");
		expect(process.exitCode).toBe(1);
	});
});
