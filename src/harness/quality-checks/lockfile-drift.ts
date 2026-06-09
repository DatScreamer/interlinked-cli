// ===========================================
// Lockfile Drift Detection
// ===========================================
// When a package manifest is edited, check if the corresponding lockfile
// is stale (older mtime) or missing. Stale lockfiles mean `npm install`
// will silently resolve to different versions than the manifest declares.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Mapping from manifest filename to candidate lockfile names. */
export const LOCKFILE_MAP: Record<string, string[]> = {
	// JS/TS
	"package.json": ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"],
	// Rust
	"Cargo.toml": ["Cargo.lock"],
	// Python
	"pyproject.toml": ["poetry.lock", "uv.lock", "pdm.lock"],
	"requirements.in": ["requirements.txt"],
	"Pipfile": ["Pipfile.lock"],
	// Ruby
	Gemfile: ["Gemfile.lock"],
	// PHP
	"composer.json": ["composer.lock"],
	// Elixir
	"mix.exs": ["mix.lock"],
	// Swift
	"Package.swift": ["Package.resolved"],
	// Dart / Flutter
	"pubspec.yaml": ["pubspec.lock"],
	// Go
	"go.mod": ["go.sum"],
};

/**
 * Grace window (ms): if a manifest was modified within this many milliseconds
 * of "now", we assume the user is mid edit→regen flow and suppress drift.
 *
 * This prevents false positives on the PostToolUse event that fires immediately
 * after a manifest edit (before the user has had a chance to run `npm install`).
 * On any subsequent check (>5s later), drift fires normally if the lockfile
 * still hasn't been regenerated.
 */
const LOCKFILE_DRIFT_GRACE_MS = 5_000;

export interface LockfileDriftResult {
	drifted: boolean;
	manifest: string;
	lockfile?: string;
	reason: "stale" | "missing" | "none" | "grace";
}

export interface LockfileDriftOptions {
	/** Override the grace window (ms). Defaults to LOCKFILE_DRIFT_GRACE_MS. */
	graceWindowMs?: number;
	/** Override "now" (ms since epoch). Defaults to Date.now(). Used for tests. */
	now?: number;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Check if the lockfile corresponding to a manifest file is stale or missing.
 * Returns drift info. A lockfile is "stale" if its mtime is older than the manifest's.
 *
 * Suppresses drift findings when the manifest was modified within the grace window
 * (default 5s). This avoids firing twice in a single edit→regen turn.
 */
export function checkLockfileDrift(
	manifestPath: string,
	options: LockfileDriftOptions = {},
): LockfileDriftResult {
	const fileName = manifestPath.replace(/\\/g, "/").split("/").pop() || "";
	const candidates = LOCKFILE_MAP[fileName];
	if (!candidates) return { drifted: false, manifest: fileName, reason: "none" };

	const dir = dirname(manifestPath);
	const graceWindowMs = options.graceWindowMs ?? LOCKFILE_DRIFT_GRACE_MS;
	const now = options.now ?? Date.now();

	// Stat the manifest once — used both for grace-window check and drift comparison.
	let manifestMtime: number | null = null;
	try {
		manifestMtime = statSync(manifestPath).mtimeMs;
	} catch (_err) {
		/* intentional: can't stat manifest — fall through, best-effort */
	}

	// Grace window: if the manifest was just edited, the user is likely mid-regen.
	// Suppress drift reporting for this turn; a later check will catch genuine staleness.
	const withinGrace = manifestMtime !== null && now - manifestMtime < graceWindowMs;

	// Find which lockfile exists in the same directory
	let lockfilePath: string | null = null;
	let lockfileName: string | null = null;
	for (const candidate of candidates) {
		const candidatePath = resolve(dir, candidate);
		if (existsSync(candidatePath)) {
			lockfilePath = candidatePath;
			lockfileName = candidate;
			break;
		}
	}

	if (!lockfilePath || !lockfileName) {
		// No lockfile at all — warn about missing lockfile, unless the manifest
		// was just created/edited (user is probably about to run install).
		if (withinGrace) {
			return { drifted: false, manifest: fileName, reason: "grace" };
		}
		return { drifted: true, manifest: fileName, reason: "missing" };
	}

	// Compare mtimes: if manifest is newer than lockfile, it's drifted
	try {
		const lockfileMtime = statSync(lockfilePath).mtimeMs;
		if (manifestMtime !== null && manifestMtime > lockfileMtime) {
			if (withinGrace) {
				return {
					drifted: false,
					manifest: fileName,
					lockfile: lockfileName,
					reason: "grace",
				};
			}
			return {
				drifted: true,
				manifest: fileName,
				lockfile: lockfileName,
				reason: "stale",
			};
		}
	} catch (_err) {
		/* intentional: can't stat lockfile — best-effort, skip */
	}

	return { drifted: false, manifest: fileName, lockfile: lockfileName, reason: "none" };
}

// ===========================================
// Semantic classification drift (finding 7)
// ===========================================
// The mtime check above answers "was the lockfile regenerated after the
// manifest changed?". It cannot answer "does the lockfile correctly REPRESENT
// the manifest's dependency classification?" — the exact gap that let a
// `typescript` reclassified devDependencies → optionalDependencies in
// package.json keep a stale `dev: true` lock entry, so `npm ci --omit=dev`
// would wrongly drop it. This is a structural compare of the npm
// package-lock.json's root sections against package.json — deterministic, and
// (unlike the mtime check) NOT suppressed by the grace window.

export type DepSection = "dependencies" | "devDependencies" | "optionalDependencies";

const DEP_SECTIONS: DepSection[] = ["dependencies", "devDependencies", "optionalDependencies"];

export interface LockfileClassificationDrift {
	drifted: boolean;
	manifest: string;
	mismatches: { name: string; manifestSection: DepSection; lockSection: DepSection | "absent" }[];
}

/** Parse a JSON file, or null on any read / parse error (best-effort). */
function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * The section `name` sits in within a manifest or lock-root object, or null when
 * absent. optionalDependencies takes precedence over dependencies (npm treats a
 * dep listed as optional as optional even if also a regular dependency), so both
 * sides are classified the same way and compare consistently.
 */
function sectionOf(obj: Record<string, unknown>, name: string): DepSection | null {
	const order: DepSection[] = ["optionalDependencies", "dependencies", "devDependencies"];
	for (const section of order) {
		const block = obj[section];
		if (block && typeof block === "object" && name in (block as object)) return section;
	}
	return null;
}

/** Every dependency name declared anywhere in a manifest/lock-root object. */
function declaredNames(obj: Record<string, unknown>): Set<string> {
	const names = new Set<string>();
	for (const section of DEP_SECTIONS) {
		const block = obj[section];
		if (block && typeof block === "object") for (const k of Object.keys(block as object)) names.add(k);
	}
	return names;
}

/**
 * Compare the dependency CLASSIFICATION in package.json against package-lock.json's
 * root entry (`packages[""]`). A dep whose manifest section disagrees with its
 * lock section is drift. npm-specific: only package.json ↔ package-lock.json (v2/v3
 * lockfiles with a `packages` map); every other manifest/lock format returns clean.
 */
export function checkLockfileClassificationDrift(manifestPath: string): LockfileClassificationDrift {
	const fileName = manifestPath.replace(/\\/g, "/").split("/").pop() || "";
	const clean: LockfileClassificationDrift = { drifted: false, manifest: fileName, mismatches: [] };
	if (fileName !== "package.json") return clean;

	const lockPath = resolve(dirname(manifestPath), "package-lock.json");
	if (!existsSync(lockPath)) return clean;

	const manifest = readJson(manifestPath);
	const lock = readJson(lockPath);
	if (!manifest || !lock) return clean;
	const lockRoot = (lock.packages as Record<string, unknown> | undefined)?.[""];
	if (!lockRoot || typeof lockRoot !== "object") return clean; // v1 lock — no root entry

	const root = lockRoot as Record<string, unknown>;
	const mismatches: LockfileClassificationDrift["mismatches"] = [];
	for (const name of declaredNames(manifest)) {
		const manifestSection = sectionOf(manifest, name);
		if (!manifestSection) continue;
		const lockSection = sectionOf(root, name) ?? "absent";
		if (manifestSection !== lockSection) {
			mismatches.push({ name, manifestSection, lockSection });
		}
	}
	return { drifted: mismatches.length > 0, manifest: fileName, mismatches };
}
