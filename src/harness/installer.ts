// ===========================================
// Adapter-multiplexing installer + installer manifest
// ===========================================
// Writes merge-safe hook fragments to each runner's settings file, records
// exactly what was added in `.interlinked/installer-manifest.json`, and
// uninstalls precisely what it installed. See docs/design/free-cli-architecture.md
// §"Installer architecture".
//
// Idempotency contract: every install first purges any prior Interlinked
// registration — legacy `.mjs` *or* adapter — from the arrays it is about to
// write, then appends exactly one canonical entry. Re-running install (or
// running it after the legacy `interlinked enable` path) therefore converges
// to one hook per event per runner instead of stacking duplicates. The shared
// recogniser lives in `../lib/hook-ownership.ts`.

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isInterlinkedHookEntry, isProjectOwnedHookEntry, withoutIncomingDuplicates } from "../lib/hook-ownership.js";
import type { JsonObject } from "../lib/json-types.js";
import {
	buildAllAdapters,
	getAdapter,
	type InstallerManifestEntry,
	type RunnerAdapter,
} from "./adapters/index.js";
import {
	ensureDir,
	mergeSettings,
	readJson,
	removeJsonPath,
	writeAtomic,
} from "./installer-merge-engine.js";
import type { RunnerId } from "./unified-event.js";

export { mergeSettings, removeJsonPath } from "./installer-merge-engine.js";

export type InstallScope = "user" | "project" | "local";

// Scope identities as named constants — `as const` keeps their literal types
// so equality checks narrow correctly (e.g. in `coerceManifestEntry`).
const SCOPE_USER = "user" as const;
const SCOPE_PROJECT = "project" as const;
const SCOPE_LOCAL = "local" as const;

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
	/** Count of prior Interlinked entries removed before insert (idempotency).
	 *  Non-zero means a re-run, a legacy `.mjs` install, or a stacked
	 *  duplicate was cleaned up. */
	purged: number;
	/** Count of Interlinked entries left in place because they belong to
	 *  *another* project — only ever non-zero at user scope. */
	foreign: number;
	/** Settings files (other than the ones this run wrote) that held a stale
	 *  prior install of a reinstalled runner and were cleaned. */
	orphans_cleaned: string[];
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
	const scope: InstallScope = opts.scope ?? SCOPE_PROJECT;
	const dryRun = opts.dryRun ?? false;
	const adapters = buildAllAdapters();
	const selected = selectAdapters(adapters, opts.runners);
	const entries: InstallerManifestEntry[] = [];
	const skipped: InstallResult["skipped"] = [];
	const binaryAbs = resolve(opts.binaryPath);
	const nowIso = new Date().toISOString();

	const mfPath = manifestPath(opts.cwd);
	// Snapshot the manifest before this run rewrites it. Used to (a) retain
	// entries for runners this run does not touch and (b) clean a prior
	// install of a reinstalled runner that landed in a *different* file.
	const priorManifest = readManifest(mfPath);

	let purged = 0;
	let foreign = 0;
	for (const adapter of selected) {
		const outcome = installSingle(adapter, binaryAbs, scope, opts.cwd, nowIso, dryRun);
		if (outcome.ok) {
			entries.push(outcome.entry);
			purged += outcome.purged;
			foreign += outcome.foreign;
		} else {
			skipped.push({ runner: adapter.id, reason: outcome.reason });
		}
	}

	// Stale-install cleanup: a prior install of a runner we just (re)installed
	// may have written a *different* settings file — e.g. a user→project scope
	// switch. The in-place purge in `installSingle` only reached the file this
	// run rewrote, so clear the old one here. Runners not in this run are left
	// untouched; the user installed those deliberately.
	const selectedIds = new Set(selected.map((a) => a.id));
	const newFiles = new Set(entries.map((e) => e.settings_path));
	const orphansCleaned: string[] = [];
	for (const prior of priorManifest) {
		if (!selectedIds.has(prior.runner)) continue;
		if (newFiles.has(prior.settings_path)) continue;
		const verdict = makePurgeVerdict(prior.scope, opts.cwd);
		const removed = cleanProjectOwnedHooks(prior.settings_path, verdict, dryRun);
		if (removed > 0) orphansCleaned.push(prior.settings_path);
	}

	// Cross-scope stale cleanup: a historical user-scope install may predate
	// the manifest, or may have been created by a different installer path. If
	// the current run installs project/local hooks, a matching user-scope hook
	// for the same project will be merged by runners like Claude Code and fire
	// in addition to the project hook. Remove this project's user-scope entries
	// from the same runner settings file, sparing other projects' hooks.
	if (scope !== SCOPE_USER) {
		const verdict = makePurgeVerdict(SCOPE_USER, opts.cwd);
		for (const adapter of selected) {
			const userFragment = adapter.renderSettingsFragment(binaryAbs, SCOPE_USER);
			const userTarget = resolveSettingsPath(opts.cwd, userFragment.path);
			if (newFiles.has(userTarget)) continue;
			const removed = cleanProjectOwnedHooks(userTarget, verdict, dryRun);
			if (removed > 0 && !orphansCleaned.includes(userTarget)) {
				orphansCleaned.push(userTarget);
			}
		}
	}

	// Non-clobbering manifest: keep prior entries for runners this run did not
	// touch, then add this run's entries. The previous code overwrote the whole
	// manifest with only the latest run — orphaning every other runner's
	// install (left in settings with no manifest record, so `uninstall` could
	// never find it again).
	const retained = priorManifest.filter((e) => !selectedIds.has(e.runner));
	if (!dryRun) writeManifest(mfPath, [...retained, ...entries]);

	return {
		entries,
		skipped,
		manifest_path: mfPath,
		purged,
		foreign,
		orphans_cleaned: orphansCleaned,
	};
}

interface InstallSingleSuccess {
	ok: true;
	entry: InstallerManifestEntry;
	/** Prior Interlinked entries removed from this runner's file before insert. */
	purged: number;
	/** Foreign (other-project) Interlinked entries left in place. */
	foreign: number;
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

	// Idempotency: drop any prior Interlinked registration (legacy `.mjs` or
	// adapter) from the arrays this fragment writes, *before* the append-merge
	// below — so a re-run converges to exactly one canonical entry per event
	// rather than stacking duplicates. Scope-aware: a shared user-scope file
	// keeps other repos' Interlinked hooks (tallied as `foreign`).
	const report: PurgeReport = { removed: 0, foreign: 0 };
	purgePriorEntries(base, fragment.fragment, makePurgeVerdict(scope, cwd), report);

	const addedPaths: string[] = [];
	const merged = mergeSettings(base, fragment.fragment, fragment.mergeStrategy, "", addedPaths);

	if (!dryRun) {
		ensureDir(dirname(target));
		writeAtomic(target, merged);
	}

	// Adapter-specific post-install side-effects — e.g. Codex's
	// `[features] hooks = true` feature flag in `.codex/config.toml`
	// (legacy `codex_hooks` is auto-migrated by the writer). Adapters
	// that don't implement postInstall are no-ops here. Errors are caught
	// so a failed flag-write doesn't bubble up as a full install failure;
	// the caller still gets a manifest entry for the JSON fragment that
	// did land.
	if (adapter.postInstall) {
		const postInstallBase = scope === SCOPE_USER ? homedir() : cwd;
		try {
			adapter.postInstall({ cwd: postInstallBase, scope, dryRun });
		} catch (err) {
			process.stderr.write(
				`[interlinked] ${adapter.id} postInstall failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
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
		purged: report.removed,
		foreign: report.foreign,
	};
}

// -----------------------------------------------------------------------------
// Idempotent purge — drop prior Interlinked registrations before insert
// -----------------------------------------------------------------------------

/** Per-entry verdict for the pre-merge purge. */
type PurgeVerdict = "remove" | "foreign" | "keep";
const VERDICT_REMOVE: PurgeVerdict = "remove";
const VERDICT_FOREIGN: PurgeVerdict = "foreign";
const VERDICT_KEEP: PurgeVerdict = "keep";

interface PurgeReport {
	/** Interlinked entries removed (owned by this project). */
	removed: number;
	/** Interlinked entries left in place (owned by another project). */
	foreign: number;
}

/** Build the per-entry verdict for an install at `scope`. At project/local
 *  scope the settings file lives inside the repo, so every Interlinked entry
 *  in it belongs to this project and is replaced. At user scope the file is
 *  shared across repos: only entries this project registered are replaced;
 *  another repo's Interlinked hooks are left in place (reported as foreign)
 *  rather than silently uninstalled. */
function makePurgeVerdict(
	scope: InstallScope,
	projectRoot: string,
): (entry: unknown) => PurgeVerdict {
	if (scope === SCOPE_USER) {
		return (entry) => {
			if (!isInterlinkedHookEntry(entry)) return VERDICT_KEEP;
			return isProjectOwnedHookEntry(entry, projectRoot) ? VERDICT_REMOVE : VERDICT_FOREIGN;
		};
	}
	return (entry) => (isInterlinkedHookEntry(entry) ? VERDICT_REMOVE : VERDICT_KEEP);
}

/** Walk the fragment's structure and, for every hook array it will write,
 *  drop pre-existing Interlinked-owned entries from the matching array in
 *  `base`. Runs before `mergeSettings`, so the subsequent append converges to
 *  exactly the fragment's entries. Mutates `base` in place. */
function purgePriorEntries(
	base: JsonObject,
	fragment: unknown,
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): void {
	if (fragment == null || typeof fragment !== "object" || Array.isArray(fragment)) return;
	const frag = fragment as JsonObject;
	for (const key of Object.keys(frag)) {
		const fragValue = frag[key];
		if (Array.isArray(fragValue)) {
			const existing = base[key];
			if (Array.isArray(existing)) {
				// Duplicates first: sparing one re-adds it every install.
				const deduped = withoutIncomingDuplicates(existing, fragValue);
				report.removed += existing.length - deduped.length;
				base[key] = filterEntries(deduped, verdict, report);
			}
			continue;
		}
		if (fragValue != null && typeof fragValue === "object") {
			const childBase = base[key];
			if (childBase != null && typeof childBase === "object" && !Array.isArray(childBase)) {
				purgePriorEntries(childBase as JsonObject, fragValue, verdict, report);
			}
		}
	}
}

/** Filter one hook array by `verdict`, tallying removals/foreign hits. */
function filterEntries(
	existing: unknown[],
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): unknown[] {
	const kept: unknown[] = [];
	for (const item of existing) {
		const v = verdict(item);
		if (v === VERDICT_REMOVE) {
			report.removed++;
			continue;
		}
		if (v === VERDICT_FOREIGN) report.foreign++;
		kept.push(item);
	}
	return kept;
}

/** Remove this project's Interlinked hook entries from every hook array in the
 *  settings file at `settingsPath`, using a pre-built `verdict` (carries scope
 *  + project root). Used to clear a prior install that landed in a different
 *  file than the current run writes — the in-place purge can only reach the
 *  file being rewritten. At user scope the verdict spares other repos' hooks.
 *  Returns the number of entries removed. */
function cleanProjectOwnedHooks(
	settingsPath: string,
	verdict: (entry: unknown) => PurgeVerdict,
	dryRun: boolean,
): number {
	if (!existsSync(settingsPath)) return 0;
	const settings = readJson(settingsPath);
	// `null` = malformed JSON — leave a file we can't safely rewrite alone.
	if (settings === null) return 0;
	const hooks = settings.hooks;
	if (hooks == null || typeof hooks !== "object" || Array.isArray(hooks)) return 0;
	const hooksObj = hooks as JsonObject;
	let removed = 0;
	for (const event of Object.keys(hooksObj)) {
		const arr = hooksObj[event];
		if (!Array.isArray(arr)) continue;
		const kept = arr.filter((entry) => {
			if (verdict(entry) === VERDICT_REMOVE) {
				removed++;
				return false;
			}
			return true;
		});
		if (kept.length === arr.length) continue;
		// Drop an event key emptied entirely by the cleanup so the file does
		// not accrue `"PreToolUse": []` litter; otherwise write the survivors.
		if (kept.length === 0) {
			delete hooksObj[event];
		} else {
			hooksObj[event] = kept;
		}
	}
	if (removed > 0) {
		if (Object.keys(hooksObj).length === 0) delete settings.hooks;
		if (!dryRun) writeAtomic(settingsPath, settings);
	}
	return removed;
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
	const scope = r.scope === SCOPE_USER || r.scope === SCOPE_LOCAL ? r.scope : SCOPE_PROJECT;
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
