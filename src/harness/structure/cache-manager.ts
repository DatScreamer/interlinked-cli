// ===========================================
// Generic Artifact Structure V1 — Cache Manager
// ===========================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdoptionReport, BaselineFile, CatalogMeta, CategoryCatalog } from "./types.js";

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

function readJsonSafe<T>(filePath: string): T | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function hasValidSchemaVersion(data: { schema_version?: unknown }): boolean {
	return data.schema_version === CURRENT_SCHEMA_VERSION;
}

// -------------------------------------------
// Catalog Meta
// -------------------------------------------

export function readCatalogMeta(cwd: string): CatalogMeta | null {
	const filePath = join(getCacheDir(cwd), "catalog-meta.json");
	const data = readJsonSafe<CatalogMeta>(filePath);
	if (!data || !hasValidSchemaVersion(data)) {
		return null;
	}
	return data;
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
	const data = readJsonSafe<CategoryCatalog>(filePath);
	if (!data || !hasValidSchemaVersion(data)) {
		return null;
	}
	return data;
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
	const data = readJsonSafe<BaselineFile>(filePath);
	if (!data || !hasValidSchemaVersion(data)) {
		return { schema_version: 1, entries: [] };
	}
	return data;
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
	const data = readJsonSafe<AdoptionReport>(filePath);
	if (!data || !hasValidSchemaVersion(data)) {
		return null;
	}
	return data;
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
