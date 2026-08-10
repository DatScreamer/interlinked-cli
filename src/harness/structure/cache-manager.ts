// ===========================================
// Generic Artifact Structure V1 — Cache Manager
// ===========================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import type {
	AdoptionReport,
	BaselineEntry,
	BaselineFile,
	CatalogItem,
	CatalogMeta,
	CategoryCatalog,
	Determinism,
	Provenance,
} from "./types.js";

// -------------------------------------------
// Constants
// -------------------------------------------

const CURRENT_SCHEMA_VERSION = 1;
const CACHE_DIR_NAME = "structure-cache";
const INTERLINKED_DIR = ".interlinked";
const MANIFEST_DIR = "interlinked";

// -------------------------------------------
// Cache directory helpers
// -------------------------------------------

export function getCacheDir(cwd: string): string {
	return join(cwd, INTERLINKED_DIR, CACHE_DIR_NAME);
}

export function ensureCacheDir(cwd: string): void {
	mkdirSync(getCacheDir(cwd), { recursive: true });
}

// -------------------------------------------
// Safe JSON read
// -------------------------------------------

function readJsonSafe(filePath: string): unknown {
	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// -------------------------------------------
// Per-artifact validators
// -------------------------------------------
// Every cache file here is self-written by this module, but a stale schema
// version or a hand-edited file can still parse as syntactically valid JSON
// that is the wrong shape. `readJsonSafe` returns `unknown`; these parsers
// are the one place that narrows it into a domain type via a CONSTRUCTED
// literal, so a required field added to a type in ./types.js fails this
// file to compile instead of silently reading `undefined` downstream.

function isProvenance(value: unknown): value is Provenance {
	return value === "declared" || value === "extracted" || value === "inferred";
}

function isDeterminism(value: unknown): value is Determinism {
	return (
		value === "fully_deterministic" || value === "partially_deterministic" || value === "heuristic"
	);
}

function parseCatalogItem(value: unknown): CatalogItem | null {
	if (!isJsonObject(value)) return null;
	const { local_id, global_ref, file, provenance, determinism_ceiling } = value;
	if (typeof local_id !== "string") return null;
	if (typeof global_ref !== "string") return null;
	if (typeof file !== "string") return null;
	if (!isProvenance(provenance)) return null;
	if (!isDeterminism(determinism_ceiling)) return null;
	return { local_id, global_ref, file, provenance, determinism_ceiling };
}

function parseBaselineEntry(value: unknown): BaselineEntry | null {
	if (!isJsonObject(value)) return null;
	const { finding_name, artifact_ref, source_file, determinism, required_companion_files, context_hash } =
		value;
	if (typeof finding_name !== "string") return null;
	if (typeof artifact_ref !== "string") return null;
	if (typeof source_file !== "string") return null;
	if (!isDeterminism(determinism)) return null;
	if (
		!Array.isArray(required_companion_files) ||
		!required_companion_files.every((f): f is string => typeof f === "string")
	) {
		return null;
	}
	if (typeof context_hash !== "string") return null;
	return { finding_name, artifact_ref, source_file, determinism, required_companion_files, context_hash };
}

function parseCatalogMeta(value: unknown): CatalogMeta | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== CURRENT_SCHEMA_VERSION) return null;
	const { cli_version, built_at, repo_root, last_scanned_commit, manifest_hash, extractor_versions } = value;
	if (typeof cli_version !== "string") return null;
	if (typeof built_at !== "string") return null;
	if (typeof repo_root !== "string") return null;
	if (typeof last_scanned_commit !== "string") return null;
	if (typeof manifest_hash !== "string") return null;
	if (!isJsonObject(extractor_versions)) return null;
	const versions: Record<string, number> = {};
	for (const [key, v] of Object.entries(extractor_versions)) {
		if (typeof v !== "number") return null;
		versions[key] = v;
	}
	return {
		schema_version: 1,
		cli_version,
		built_at,
		repo_root,
		last_scanned_commit,
		manifest_hash,
		extractor_versions: versions,
	};
}

function parseCategoryCatalog(value: unknown): CategoryCatalog | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== CURRENT_SCHEMA_VERSION) return null;
	if (!Array.isArray(value.items)) return null;
	const items: CatalogItem[] = [];
	for (const raw of value.items) {
		const item = parseCatalogItem(raw);
		if (!item) return null;
		items.push(item);
	}
	return { schema_version: 1, items };
}

function parseBaselineFile(value: unknown): BaselineFile | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== CURRENT_SCHEMA_VERSION) return null;
	if (!Array.isArray(value.entries)) return null;
	const entries: BaselineEntry[] = [];
	for (const raw of value.entries) {
		const entry = parseBaselineEntry(raw);
		if (!entry) return null;
		entries.push(entry);
	}
	return { schema_version: 1, entries };
}

function parseAdoptionReport(value: unknown): AdoptionReport | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== CURRENT_SCHEMA_VERSION) return null;
	if (!isJsonObject(value.categories)) return null;
	const { public_api, env, config, tests, docs, examples, glossary, layers, packages } = value.categories;
	if (
		typeof public_api !== "number" ||
		typeof env !== "number" ||
		typeof config !== "number" ||
		typeof tests !== "number" ||
		typeof docs !== "number" ||
		typeof examples !== "number" ||
		typeof glossary !== "number" ||
		typeof layers !== "number" ||
		typeof packages !== "number"
	) {
		return null;
	}
	return {
		schema_version: 1,
		categories: { public_api, env, config, tests, docs, examples, glossary, layers, packages },
	};
}

// -------------------------------------------
// Catalog Meta
// -------------------------------------------

export function readCatalogMeta(cwd: string): CatalogMeta | null {
	const filePath = join(getCacheDir(cwd), "catalog-meta.json");
	return parseCatalogMeta(readJsonSafe(filePath));
}

export function writeCatalogMeta(cwd: string, meta: CatalogMeta): void {
	ensureCacheDir(cwd);
	const filePath = join(getCacheDir(cwd), "catalog-meta.json");
	writeFileSync(filePath, JSON.stringify(meta, null, 2), "utf-8");
}

// -------------------------------------------
// Category Cache
// -------------------------------------------

export function readCategoryCache(cwd: string, name: string): CategoryCatalog | null {
	const filePath = join(getCacheDir(cwd), `${name}.json`);
	return parseCategoryCatalog(readJsonSafe(filePath));
}

export function writeCategoryCache(cwd: string, name: string, catalog: CategoryCatalog): void {
	ensureCacheDir(cwd);
	const filePath = join(getCacheDir(cwd), `${name}.json`);
	writeFileSync(filePath, JSON.stringify(catalog, null, 2), "utf-8");
}

// -------------------------------------------
// Baseline
// -------------------------------------------

export function readBaseline(cwd: string): BaselineFile {
	const filePath = join(getCacheDir(cwd), "baseline.json");
	return parseBaselineFile(readJsonSafe(filePath)) ?? { schema_version: 1, entries: [] };
}

export function writeBaseline(cwd: string, baseline: BaselineFile): void {
	ensureCacheDir(cwd);
	const filePath = join(getCacheDir(cwd), "baseline.json");
	writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf-8");
}

// -------------------------------------------
// Adoption Report
// -------------------------------------------

export function readAdoptionReport(cwd: string): AdoptionReport | null {
	const filePath = join(getCacheDir(cwd), "adoption-report.json");
	return parseAdoptionReport(readJsonSafe(filePath));
}

export function writeAdoptionReport(cwd: string, report: AdoptionReport): void {
	ensureCacheDir(cwd);
	const filePath = join(getCacheDir(cwd), "adoption-report.json");
	writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
}

// -------------------------------------------
// Staleness Check
// -------------------------------------------

export function isCacheStale(cwd: string, manifestHash: string): boolean {
	const meta = readCatalogMeta(cwd);
	if (!meta) {
		return true;
	}
	return meta.manifest_hash !== manifestHash;
}

// -------------------------------------------
// Manifest Hash
// -------------------------------------------

export function computeManifestHash(cwd: string): string {
	const manifestDir = join(cwd, MANIFEST_DIR);
	const hash = createHash("sha256");

	// 1. Hash the root structure.json
	try {
		hash.update(readFileSync(join(manifestDir, "structure.json"), "utf-8"));
	} catch (_err) {
		void 0; /* intentional: no structure.json — still hash artifact files if they exist */
	}

	// 2. Hash all JSON files under interlinked/ and interlinked/artifacts/
	const dirsToScan = [manifestDir, join(manifestDir, "artifacts")];
	for (const dir of dirsToScan) {
		try {
			const files = readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort();
			for (const file of files) {
				hash.update(readFileSync(join(dir, file), "utf-8"));
			}
		} catch (_err) {
			void 0; /* intentional: directory doesn't exist, skip */
		}
	}

	return hash.digest("hex");
}

// -------------------------------------------
// Clear Cache
// -------------------------------------------

export function clearCache(cwd: string): void {
	const cacheDir = getCacheDir(cwd);
	if (existsSync(cacheDir)) {
		rmSync(cacheDir, { recursive: true, force: true });
	}
}
