// ===========================================
// Adapter-multiplexing installer + installer manifest
// ===========================================
// Writes merge-safe hook fragments to each runner's settings file, records
// exactly what was added in `.interlinked/installer-manifest.json`, and
// uninstalls precisely what it installed. See docs/design/free-cli-architecture.md
// §"Installer architecture".

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import {
	buildAllAdapters,
	getAdapter,
	type InstallerManifestEntry,
	type RunnerAdapter,
} from "./adapters/index.js";
import type { RunnerId } from "./unified-event.js";

export type InstallScope = "user" | "project" | "local";

export interface InstallOptions {
	/** Repo root (used for project/local scope paths). */
	cwd: string;
	/** Absolute path to the hook binary that runners should invoke. */
	binaryPath: string;
	/** Runners to install. Empty = install to every known runner the
	 *  adapter's `detectFromEnv` recognizes in the current environment. */
	runners: RunnerId[];
	/** Install scope. Defaults to "project". */
	scope?: InstallScope;
	/** When true, do not write files; return what *would* be changed. */
	dryRun?: boolean;
}

export interface InstallResult {
	entries: InstallerManifestEntry[];
	skipped: Array<{ runner: RunnerId; reason: string }>;
	manifest_path: string;
}

const MANIFEST_FILENAME = "installer-manifest.json";
const MANIFEST_SCHEMA_VERSION = "1" as const;

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

export function manifestPath(cwd: string): string {
	return join(cwd, ".interlinked", MANIFEST_FILENAME);
}

function resolveSettingsPath(cwd: string, relPath: string): string {
	if (relPath.startsWith("~/")) return join(homedir(), relPath.slice(2));
	if (relPath.startsWith("/")) return relPath;
	return join(cwd, relPath);
}

// -----------------------------------------------------------------------------
// Install
// -----------------------------------------------------------------------------

export function installHooks(opts: InstallOptions): InstallResult {
	const scope: InstallScope = opts.scope ?? "project";
	const dryRun = opts.dryRun ?? false;
	const adapters = buildAllAdapters();
	const selected = selectAdapters(adapters, opts.runners);
	const entries: InstallerManifestEntry[] = [];
	const skipped: InstallResult["skipped"] = [];
	const binaryAbs = resolve(opts.binaryPath);
	const nowIso = new Date().toISOString();

	for (const adapter of selected) {
		const outcome = installSingle(adapter, binaryAbs, scope, opts.cwd, nowIso, dryRun);
		if (outcome.ok) {
			entries.push(outcome.entry);
		} else {
			skipped.push({ runner: adapter.id, reason: outcome.reason });
		}
	}

	const mfPath = manifestPath(opts.cwd);
	if (!dryRun) writeManifest(mfPath, entries);

	return { entries, skipped, manifest_path: mfPath };
}

interface InstallSingleSuccess {
	ok: true;
	entry: InstallerManifestEntry;
}
interface InstallSingleFailure {
	ok: false;
	reason: string;
}

function installSingle(
	adapter: RunnerAdapter,
	binaryAbs: string,
	scope: InstallScope,
	cwd: string,
	installedAt: string,
	dryRun: boolean,
): InstallSingleSuccess | InstallSingleFailure {
	const fragment = adapter.renderSettingsFragment(binaryAbs, scope);
	const target = resolveSettingsPath(cwd, fragment.path);
	const existing = readJson(target);
	if (existing === null && existsSync(target)) {
		return { ok: false, reason: `malformed JSON at ${target}` };
	}
	const base = existing ?? {};
	const addedPaths: string[] = [];
	const merged = mergeSettings(base, fragment.fragment, fragment.mergeStrategy, "", addedPaths);

	if (!dryRun) {
		ensureDir(dirname(target));
		writeAtomic(target, merged);
	}

	return {
		ok: true,
		entry: {
			runner: adapter.id,
			scope,
			settings_path: target,
			added_paths: addedPaths,
			binary_path: binaryAbs,
			installed_at: installedAt,
			schema_version: MANIFEST_SCHEMA_VERSION,
		},
	};
}

// -----------------------------------------------------------------------------
// Uninstall
// -----------------------------------------------------------------------------

export interface UninstallOptions {
	cwd: string;
	/** Subset of runners to remove; empty = all. */
	runners?: RunnerId[];
	dryRun?: boolean;
}

export interface UninstallResult {
	removed: InstallerManifestEntry[];
	remaining: InstallerManifestEntry[];
	manifest_path: string;
}

export function uninstallHooks(opts: UninstallOptions): UninstallResult {
	const mfPath = manifestPath(opts.cwd);
	const manifest = readManifest(mfPath);
	const filter = new Set(opts.runners ?? []);
	const removed: InstallerManifestEntry[] = [];
	const remaining: InstallerManifestEntry[] = [];

	for (const entry of manifest) {
		const shouldRemove = filter.size === 0 || filter.has(entry.runner);
		if (!shouldRemove) {
			remaining.push(entry);
			continue;
		}
		if (!opts.dryRun) removeEntry(entry);
		removed.push(entry);
	}

	if (!opts.dryRun) writeManifest(mfPath, remaining);

	return { removed, remaining, manifest_path: mfPath };
}

function removeEntry(entry: InstallerManifestEntry): void {
	const settings = readJson(entry.settings_path);
	if (settings === null) return;
	for (const path of entry.added_paths) {
		removeJsonPath(settings, path);
	}
	writeAtomic(entry.settings_path, settings);
}

// -----------------------------------------------------------------------------
// Manifest IO
// -----------------------------------------------------------------------------

export function readManifest(path: string): InstallerManifestEntry[] {
	if (!existsSync(path)) return [];
	const parsed = readJson(path);
	if (parsed === null) return [];
	if (parsed == null || typeof parsed !== "object") return [];
	const wrapper = parsed as { entries?: unknown };
	if (!Array.isArray(wrapper.entries)) return [];
	const rows: readonly unknown[] = wrapper.entries;
	const out: InstallerManifestEntry[] = [];
	for (const row of rows) {
		const entry = coerceManifestEntry(row);
		if (entry) out.push(entry);
	}
	return out;
}

function writeManifest(path: string, entries: InstallerManifestEntry[]): void {
	ensureDir(dirname(path));
	const payload = { schema_version: MANIFEST_SCHEMA_VERSION, entries };
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function coerceManifestEntry(row: unknown): InstallerManifestEntry | null {
	if (row == null || typeof row !== "object") return null;
	const r = row as JsonObject;
	if (typeof r.runner !== "string") return null;
	if (typeof r.settings_path !== "string") return null;
	if (!Array.isArray(r.added_paths)) return null;
	const scope = r.scope === "user" || r.scope === "local" ? r.scope : "project";
	return {
		runner: r.runner as RunnerId,
		scope,
		settings_path: r.settings_path,
		added_paths: r.added_paths.filter((x): x is string => typeof x === "string"),
		binary_path: typeof r.binary_path === "string" ? r.binary_path : "",
		installed_at: typeof r.installed_at === "string" ? r.installed_at : "",
		schema_version: MANIFEST_SCHEMA_VERSION,
	};
}

// -----------------------------------------------------------------------------
// Merge engine — records every path it wrote so uninstall is exact
// -----------------------------------------------------------------------------

export function mergeSettings(
	target: JsonObject,
	fragment: unknown,
	strategy: "deep-merge" | "array-append" | "replace-key",
	parentPath: string,
	addedPaths: string[],
): JsonObject {
	if (fragment == null || typeof fragment !== "object" || Array.isArray(fragment)) return target;
	const frag = fragment as JsonObject;
	for (const key of Object.keys(frag)) {
		const childPath = joinPath(parentPath, key);
		const nextValue = frag[key];
		if (Array.isArray(nextValue)) {
			mergeArrayField(target, key, nextValue, strategy, childPath, addedPaths);
			continue;
		}
		if (nextValue != null && typeof nextValue === "object") {
			const existing = readObjectField(target, key);
			target[key] = mergeSettings(existing, nextValue, strategy, childPath, addedPaths);
			continue;
		}
		// Scalar: only write if absent (so we don't clobber user values).
		if (!(key in target)) {
			target[key] = nextValue;
			addedPaths.push(childPath);
		}
	}
	return target;
}

function mergeArrayField(
	target: JsonObject,
	key: string,
	next: unknown[],
	strategy: "deep-merge" | "array-append" | "replace-key",
	childPath: string,
	addedPaths: string[],
): void {
	const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
	if (strategy === "replace-key") {
		target[key] = next;
		addedPaths.push(childPath);
		return;
	}
	// array-append / deep-merge: append items, recording indices we own.
	const startIndex = existing.length;
	const merged = [...existing, ...next];
	target[key] = merged;
	for (let i = 0; i < next.length; i++) {
		addedPaths.push(`${childPath}[${startIndex + i}]`);
	}
}

function readObjectField(target: JsonObject, key: string): JsonObject {
	const existing = target[key];
	if (existing != null && typeof existing === "object" && !Array.isArray(existing)) {
		return existing as JsonObject;
	}
	const fresh: JsonObject = {};
	target[key] = fresh;
	return fresh;
}

// -----------------------------------------------------------------------------
// JSON-pointer-style path helpers for precise uninstall
// -----------------------------------------------------------------------------

function joinPath(parent: string, key: string): string {
	return parent ? `${parent}.${key}` : key;
}

export function removeJsonPath(target: unknown, path: string): boolean {
	if (target == null || typeof target !== "object") return false;
	const segments = parsePath(path);
	let cursor: unknown = target;
	for (let i = 0; i < segments.length - 1; i++) {
		cursor = step(cursor, segments[i]);
		if (cursor == null) return false;
	}
	const last = segments[segments.length - 1];
	if (cursor == null) return false;
	if (last.kind === "index") {
		if (!Array.isArray(cursor)) return false;
		if (last.value < 0 || last.value >= cursor.length) return false;
		cursor.splice(last.value, 1);
		return true;
	}
	if (typeof cursor !== "object" || Array.isArray(cursor)) return false;
	const obj = cursor as JsonObject;
	if (!(last.value in obj)) return false;
	delete obj[last.value];
	return true;
}

type PathSegment = { kind: "key"; value: string } | { kind: "index"; value: number };

function parsePath(path: string): PathSegment[] {
	const out: PathSegment[] = [];
	const parts = path.split(".");
	for (const part of parts) {
		const indexMatches = part.match(/\[(\d+)\]/g);
		const keyPart = part.replace(/\[\d+\]/g, "");
		if (keyPart.length > 0) out.push({ kind: "key", value: keyPart });
		if (indexMatches) {
			for (const idx of indexMatches) {
				const n = Number.parseInt(idx.slice(1, -1), 10);
				if (Number.isFinite(n)) out.push({ kind: "index", value: n });
			}
		}
	}
	return out;
}

function step(cursor: unknown, seg: PathSegment): unknown {
	if (cursor == null) return undefined;
	if (seg.kind === "index") {
		if (!Array.isArray(cursor)) return undefined;
		return cursor[seg.value];
	}
	if (typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
	return (cursor as JsonObject)[seg.value];
}

// -----------------------------------------------------------------------------
// Low-level fs helpers
// -----------------------------------------------------------------------------

function readJson(path: string): JsonObject | null {
	if (!existsSync(path)) return {};
	let text = "";
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return {};
	return parsed as JsonObject;
}

function writeAtomic(path: string, payload: unknown): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
	try {
		// Atomic rename on same fs; throws on Windows volume boundary —
		// caller should keep tmp dir colocated with target.
		rmSync(path, { force: true });
	} catch (_err) {
		// intentional: target may not exist yet — the subsequent renameSync
		// below establishes the final state regardless. No error to surface.
		void _err;
	}
	// Rename the tmp file into place.
	renameSync(tmp, path);
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// -----------------------------------------------------------------------------
// Adapter selection
// -----------------------------------------------------------------------------

function selectAdapters(all: RunnerAdapter[], requested: RunnerId[]): RunnerAdapter[] {
	if (requested.length === 0) return all;
	const out: RunnerAdapter[] = [];
	for (const id of requested) {
		const a = getAdapter(id, all);
		if (a) out.push(a);
	}
	return out;
}
