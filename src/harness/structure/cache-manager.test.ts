import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCache,
	computeManifestHash,
	ensureCacheDir,
	getCacheDir,
	isCacheStale,
	readAdoptionReport,
	readBaseline,
	readCatalogMeta,
	readCategoryCache,
	writeAdoptionReport,
	writeBaseline,
	writeCatalogMeta,
	writeCategoryCache,
} from "./cache-manager.js";
import type { AdoptionReport, BaselineFile, CatalogMeta, CategoryCatalog } from "./types.js";

// -------------------------------------------
// Fixtures
// -------------------------------------------

function makeCatalogMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
	return {
		schema_version: 1,
		cli_version: "0.2.0",
		built_at: "2026-03-26T00:00:00Z",
		repo_root: "/tmp/test-repo",
		last_scanned_commit: "abc123",
		manifest_hash: "deadbeef",
		extractor_versions: { public_api: 1 },
		...overrides,
	};
}

function makeCategoryCatalog(): CategoryCatalog {
	return {
		schema_version: 1,
		items: [
			{
				local_id: "pkg-index#createClient",
				global_ref: "public_symbol:pkg-index#createClient",
				file: "src/index.ts",
				provenance: "declared",
				determinism_ceiling: "fully_deterministic",
			},
		],
	};
}

function makeBaselineFile(): BaselineFile {
	return {
		schema_version: 1,
		entries: [
			{
				finding_name: "missing_doc",
				artifact_ref: "public_symbol:foo",
				source_file: "src/foo.ts",
				determinism: "fully_deterministic",
				required_companion_files: ["docs/foo.md"],
				context_hash: "abc123",
			},
		],
	};
}

function makeAdoptionReport(): AdoptionReport {
	return {
		schema_version: 1,
		categories: {
			public_api: 0.8,
			env: 0.5,
			config: 0.3,
			tests: 0.6,
			docs: 0.4,
			examples: 0.2,
			glossary: 0.1,
			layers: 0.9,
			packages: 1.0,
		},
	};
}

// -------------------------------------------
// Test setup
// -------------------------------------------

// Private per-process tmp root. Parallel-safety: the prior `TEST_CWD` lived in
// the repo tree (`process.cwd()/.test-cache-manager-<pid>`); under
// `--file-parallelism` a stray dir there can surface in `git status` / trip the
// fixture-leak detector if a worker is killed before afterEach runs. A mkdtemp
// root under os.tmpdir() is process-unique, off the repo tree, and removed
// wholesale in afterAll. TEST_CWD is just a `cwd` arg the cache-manager joins
// `.interlinked/structure-cache` onto, so any directory works.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "interlinked-cache-manager-"));
const TEST_CWD = join(TMP_ROOT, "cwd");

beforeEach(() => {
	mkdirSync(TEST_CWD, { recursive: true });
});

afterEach(() => {
	if (existsSync(TEST_CWD)) {
		rmSync(TEST_CWD, { recursive: true, force: true });
	}
});

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		// intentional: best-effort cleanup of the per-process tmp root.
	}
});

// -------------------------------------------
// Tests
// -------------------------------------------

describe("getCacheDir", () => {
	it("returns the expected path", () => {
		expect(getCacheDir("/my/project")).toBe("/my/project/.interlinked/structure-cache");
	});
});

describe("ensureCacheDir", () => {
	it("creates the cache directory recursively", () => {
		ensureCacheDir(TEST_CWD);
		expect(existsSync(getCacheDir(TEST_CWD))).toBe(true);
	});

	it("does not throw if directory already exists", () => {
		ensureCacheDir(TEST_CWD);
		ensureCacheDir(TEST_CWD);
		expect(existsSync(getCacheDir(TEST_CWD))).toBe(true);
	});
});

describe("CatalogMeta", () => {
	it("round-trips write and read", () => {
		const meta = makeCatalogMeta();
		writeCatalogMeta(TEST_CWD, meta);
		const result = readCatalogMeta(TEST_CWD);
		expect(result).toEqual(meta);
	});

	it("returns null when file does not exist", () => {
		expect(readCatalogMeta(TEST_CWD)).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		ensureCacheDir(TEST_CWD);
		writeFileSync(join(getCacheDir(TEST_CWD), "catalog-meta.json"), "not json", "utf-8");
		expect(readCatalogMeta(TEST_CWD)).toBeNull();
	});

	it("returns null for wrong schema version", () => {
		ensureCacheDir(TEST_CWD);
		const bad = { ...makeCatalogMeta(), schema_version: 99 };
		writeFileSync(
			join(getCacheDir(TEST_CWD), "catalog-meta.json"),
			JSON.stringify(bad),
			"utf-8",
		);
		expect(readCatalogMeta(TEST_CWD)).toBeNull();
	});
});

describe("CategoryCache", () => {
	it("round-trips write and read", () => {
		const catalog = makeCategoryCatalog();
		writeCategoryCache(TEST_CWD, "public_api", catalog);
		const result = readCategoryCache(TEST_CWD, "public_api");
		expect(result).toEqual(catalog);
	});

	it("returns null when file does not exist", () => {
		expect(readCategoryCache(TEST_CWD, "public_api")).toBeNull();
	});

	it("returns null for wrong schema version", () => {
		ensureCacheDir(TEST_CWD);
		const bad = { schema_version: 2, items: [] };
		writeFileSync(join(getCacheDir(TEST_CWD), "public_api.json"), JSON.stringify(bad), "utf-8");
		expect(readCategoryCache(TEST_CWD, "public_api")).toBeNull();
	});
});

describe("Baseline", () => {
	it("round-trips write and read", () => {
		const baseline = makeBaselineFile();
		writeBaseline(TEST_CWD, baseline);
		const result = readBaseline(TEST_CWD);
		expect(result).toEqual(baseline);
	});

	it("returns default empty baseline when file does not exist", () => {
		const result = readBaseline(TEST_CWD);
		expect(result).toEqual({ schema_version: 1, entries: [] });
	});

	it("returns default empty baseline for invalid JSON", () => {
		ensureCacheDir(TEST_CWD);
		writeFileSync(join(getCacheDir(TEST_CWD), "baseline.json"), "broken", "utf-8");
		const result = readBaseline(TEST_CWD);
		expect(result).toEqual({ schema_version: 1, entries: [] });
	});
});

describe("AdoptionReport", () => {
	it("round-trips write and read", () => {
		const report = makeAdoptionReport();
		writeAdoptionReport(TEST_CWD, report);
		const result = readAdoptionReport(TEST_CWD);
		expect(result).toEqual(report);
	});

	it("returns null when file does not exist", () => {
		expect(readAdoptionReport(TEST_CWD)).toBeNull();
	});
});

describe("isCacheStale", () => {
	it("returns true when no catalog meta exists", () => {
		expect(isCacheStale(TEST_CWD, "abc")).toBe(true);
	});

	it("returns true when hash does not match", () => {
		writeCatalogMeta(TEST_CWD, makeCatalogMeta({ manifest_hash: "old" }));
		expect(isCacheStale(TEST_CWD, "new")).toBe(true);
	});

	it("returns false when hash matches", () => {
		writeCatalogMeta(TEST_CWD, makeCatalogMeta({ manifest_hash: "same" }));
		expect(isCacheStale(TEST_CWD, "same")).toBe(false);
	});
});

describe("computeManifestHash", () => {
	it("produces a hex string", () => {
		// No manifest dir, but should still return a hash
		const hash = computeManifestHash(TEST_CWD);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("changes when manifest files change", () => {
		const manifestDir = join(TEST_CWD, "interlinked");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(join(manifestDir, "public_api.json"), '{"version":1}', "utf-8");

		const hash1 = computeManifestHash(TEST_CWD);

		writeFileSync(join(manifestDir, "public_api.json"), '{"version":2}', "utf-8");

		const hash2 = computeManifestHash(TEST_CWD);
		expect(hash1).not.toBe(hash2);
	});

	it("is deterministic for same content", () => {
		const manifestDir = join(TEST_CWD, "interlinked");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(join(manifestDir, "env.json"), '{"keys":[]}', "utf-8");

		const hash1 = computeManifestHash(TEST_CWD);
		const hash2 = computeManifestHash(TEST_CWD);
		expect(hash1).toBe(hash2);
	});
});

describe("clearCache", () => {
	it("removes the cache directory", () => {
		ensureCacheDir(TEST_CWD);
		writeCatalogMeta(TEST_CWD, makeCatalogMeta());
		expect(existsSync(getCacheDir(TEST_CWD))).toBe(true);

		clearCache(TEST_CWD);
		expect(existsSync(getCacheDir(TEST_CWD))).toBe(false);
	});

	it("does not throw if cache directory does not exist", () => {
		expect(() => clearCache(TEST_CWD)).not.toThrow();
	});
});
