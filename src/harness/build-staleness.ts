// ===========================================
// Build staleness guard
// ===========================================
// The harness daemon runs from compiled `dist/` (`node dist/harness/server.js`).
// If `src/` is edited but `dist/` is not rebuilt, the daemon silently enforces
// OLD code — the exact failure that let an over-cap edit through once. This
// module detects that drift so the daemon (at startup) and `harness status` can
// surface it. Fail-open: any error → treated as "not stale" (never blocks).

import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const MAX_ENTRIES = 50_000;
const WALK_BUDGET_MS = 500;

export interface DistStaleness {
	/** A src/ file is newer than the dist/ build artifact. */
	stale: boolean;
	/** Newest mtime (ms) found under src/. */
	newestSrcMs: number;
	/** mtime (ms) of the dist/ build artifact compared against. */
	buildMs: number;
}

/** Newest mtime under `dir`, bounded by entry count and a wall-clock budget so
 *  it never adds meaningful startup latency. Returns 0 if unreadable. */
function newestMtimeUnder(dir: string): number {
	let newest = 0;
	let visited = 0;
	const deadline = Date.now() + WALK_BUDGET_MS;
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		if (visited++ > MAX_ENTRIES || Date.now() > deadline) break;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				stack.push(join(current, entry.name));
			} else if (entry.isFile()) {
				try {
					const m = statSync(join(current, entry.name)).mtimeMs;
					if (m > newest) newest = m;
				} catch {
					/* best-effort */
				}
			}
		}
	}
	return newest;
}

/**
 * Public API — compare a repo's `dist/` build artifact against its `src/` tree.
 * Returns null when there's no `dist/index.js` (never built / running from
 * source, so staleness is meaningless) or `src/` is missing.
 */
export function distStaleness(repoRoot: string): DistStaleness | null {
	const distArtifact = join(repoRoot, "dist", "index.js");
	const srcDir = join(repoRoot, "src");
	let buildMs: number;
	try {
		buildMs = statSync(distArtifact).mtimeMs;
	} catch {
		return null; // no build to be stale against
	}
	const newestSrcMs = newestMtimeUnder(srcDir);
	if (newestSrcMs === 0) return null; // unreadable src
	return { stale: newestSrcMs > buildMs, newestSrcMs, buildMs };
}

/**
 * Public API — staleness for the CURRENTLY RUNNING module. Returns null when the
 * caller is executing from source (tsx/dev), where the running code is always
 * current and a stale `dist/` is irrelevant. Used by the daemon at startup.
 */
export function runningBuildStaleness(moduleUrl: string): DistStaleness | null {
	let here: string;
	try {
		here = fileURLToPath(moduleUrl);
	} catch {
		return null;
	}
	const marker = `${sep}dist${sep}`;
	const idx = here.indexOf(marker);
	if (idx === -1) return null; // running from src/ (tsx) — not a build
	return distStaleness(here.slice(0, idx));
}

/** Public API — one-line warning for a stale build, or null when fresh/unknown. */
export function stalenessWarning(s: DistStaleness | null): string | null {
	if (!s || !s.stale) return null;
	const minsNewer = Math.max(1, Math.round((s.newestSrcMs - s.buildMs) / 60_000));
	return (
		`STALE BUILD: src/ has edits ~${minsNewer} min newer than the running dist/ build — ` +
		"the harness is enforcing OLD code. Run: npm run build && interlinked harness restart"
	);
}
