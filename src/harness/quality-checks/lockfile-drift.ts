// ===========================================
// Lockfile Drift Detection
// ===========================================
// When a package manifest is edited, check if the corresponding lockfile
// is stale (older mtime) or missing. Stale lockfiles mean `npm install`
// will silently resolve to different versions than the manifest declares.

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Mapping from manifest filename to candidate lockfile names. */
export const LOCKFILE_MAP: Record<string, string[]> = {
	"package.json": ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"],
	"Cargo.toml": ["Cargo.lock"],
	"pyproject.toml": ["poetry.lock", "uv.lock", "pdm.lock"],
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
