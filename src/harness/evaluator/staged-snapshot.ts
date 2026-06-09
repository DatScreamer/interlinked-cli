// ===========================================
// Staged-snapshot materialization (commit-time gate, finding 3)
// ===========================================
// A plain `git commit` captures the INDEX (the staged tree), not the working
// tree. The commit gate must therefore evaluate the staged snapshot, or it can
// (a) false-block on unrelated unstaged work and (b) — the soundness hole —
// false-ALLOW a broken staged change that an unstaged edit masks green.
//
// This materializes the index into a temp tree the suite can run against:
//   - `git checkout-index --all --prefix=<tmp>/` writes EXACTLY the staged tree
//     (no unstaged modifications, no untracked files) — the would-be commit.
//   - node_modules is symlinked back (gitignored, so absent from the index) so
//     the runner can still resolve dependencies, mirroring the coverage overlay.
//
// Fail-safe: any failure returns null and the caller falls back to evaluating the
// working tree (no worse than before this fix). The tree is rooted UNDER
// projectRoot/.interlinked (never os.tmpdir) for the same path-resolution reason
// the coverage overlay documents.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const INTERLINKED_DIR = ".interlinked";
const SNAPSHOT_PREFIX = ".commit-snapshot-";
const GIT_TIMEOUT_MS = 30_000;

/** A materialized staged tree the caller runs a suite against, then cleans up. */
export interface StagedSnapshot {
	/** Absolute path to the snapshot root (mirrors the repo root, staged content). */
	root: string;
	/** Remove the snapshot tree. Idempotent / best-effort (never throws). */
	cleanup(): void;
}

/** Symlink the real node_modules into the snapshot (best-effort). */
function linkNodeModules(projectRoot: string, root: string): void {
	try {
		symlinkSync(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
	} catch {
		// No node_modules, or the platform refused the symlink — the runner may
		// still work (pure-stdlib) or the caller fail-opens. Best-effort by design.
	}
}

/** Best-effort recursive remove (never throws). */
function removeTree(root: string): void {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup — a leaked temp dir under .interlinked is harmless
		// and is reclaimed on the next run or by the OS temp sweeper.
	}
}

/**
 * Materialize the INDEX (staged tree) of the git repo at `projectRoot` into a
 * temp tree under `projectRoot/.interlinked`, with node_modules symlinked.
 * Returns the snapshot, or null on any failure (the caller falls back to the
 * working tree). The materialized tree is the exact content a plain `git commit`
 * would write — no unstaged edits, no untracked files.
 */
export function materializeIndexSnapshot(projectRoot: string): StagedSnapshot | null {
	let root: string | null = null;
	try {
		const parent = join(projectRoot, INTERLINKED_DIR);
		mkdirSync(parent, { recursive: true });
		root = realpathSync(mkdtempSync(join(parent, SNAPSHOT_PREFIX)));
		execFileSync("git", ["checkout-index", "--all", `--prefix=${root}/`], {
			cwd: projectRoot,
			timeout: GIT_TIMEOUT_MS,
			stdio: "ignore",
		});
		linkNodeModules(projectRoot, root);
		const snapshotRoot = root;
		return {
			root: snapshotRoot,
			cleanup: () => removeTree(snapshotRoot),
		};
	} catch {
		if (root !== null) removeTree(root);
		return null;
	}
}
