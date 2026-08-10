// Self-healing sweep for leaked in-repo fixture directories.
//
// The overlay/gate suites (content-gate, diff-overlay, tsc-overlay,
// multi-edit) MUST mkdtemp their fixtures inside the repo — tsc resolves
// tsconfig.json by walking up, biome resolves biome.json from projectRoot, and
// the check-engine filters findings to projectRoot-relative paths, so a
// fixture in os.tmpdir() silently yields zero findings. The cost: an
// interrupted run leaks `_<name>_fixtures-<random>` where every walker can see
// it (observed 2026-08-09: 10 leaked dirs, one of which kept the build-
// staleness probe firing a false STALE BUILD warning for weeks).
//
// Rather than an exit hook (which a SIGKILL still skips), each suite calls
// `sweepStaleFixtureDirs(root)` once at load: leaked dirs from PAST runs are
// removed, fresh dirs (a parallel live run) are left alone.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Matches every fixture family: `_content_gate_fixtures-x`, `_tsc_overlay_fixtures-y`, … */
const FIXTURE_DIR_RE = /^_.+_fixtures-/;

/** Older than this = leaked by a dead run. Suites finish in seconds; 30 min is generous. */
const DEFAULT_STALE_MS = 30 * 60 * 1000;

/**
 * Remove stale `_*_fixtures-*` directories under `root`; return what was
 * removed. Never throws: an unreadable root or a dir another parallel sweep
 * already removed is skipped silently.
 */
export function sweepStaleFixtureDirs(root: string, olderThanMs = DEFAULT_STALE_MS): string[] {
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return removed;
	}
	const cutoff = Date.now() - olderThanMs;
	for (const name of entries) {
		if (!FIXTURE_DIR_RE.test(name)) continue;
		const full = join(root, name);
		try {
			if (statSync(full).mtimeMs > cutoff) continue;
			rmSync(full, { recursive: true, force: true });
			removed.push(full);
			// interlinked-ignore: empty_catch — losing the race means another sweep or a live run owns the dir; there is nothing to handle or log in a test-load path
		} catch {}
	}
	return removed;
}
