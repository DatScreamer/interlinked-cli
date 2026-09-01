import { expectedCompanionTest } from "../coverage-pairing.js";
import { collectLocalDeps } from "./local-deps.js";

export interface MeasureOverlay {
	path: string;
	content: string;
}

/** Pushes `path`'s content onto `out` if not already present. Returns whether
 * the path is now represented in `out` (already-present counts as success) —
 * callers use this to distinguish "added/already there" from "could not be
 * read", which they must report rather than silently swallow. */
function pushIfNew(out: MeasureOverlay[], path: string, readDisk: (p: string) => string | null): boolean {
	if (out.some((o) => o.path === path)) return true;
	const content = readDisk(path);
	if (content === null) return false;
	out.push({ path, content });
	return true;
}

/**
 * The full overlay set for a whole-file out-of-band measurement: the target,
 * its companion test (if one exists on disk), and both files' transitive local
 * deps — the same shape gate.ts's `buildOverlays` ships for the per-edit path,
 * minus the ChangeSet machinery this single-file caller has no use for.
 *
 * Thin wrapper over {@link buildScopedMeasureOverlays} with an empty test
 * scope — kept as its own export because it is the stable, back-compat shape
 * (a plain array) every existing caller and test already depends on.
 */
export function buildMeasureOverlays(
	file: string,
	content: string,
	readDisk: (path: string) => string | null,
): MeasureOverlay[] {
	return buildScopedMeasureOverlays(file, content, readDisk).overlays;
}

/**
 * Ceiling on distinct files placed in one measurement's overlay set (target +
 * companion + full test scope + their transitive local-dep closure). A test
 * scope widened via the reverse import graph (test-scope.ts) can resolve to
 * dozens of test files (this repo's own worst case, `session-state.ts`,
 * resolves to 61) whose OWN dependency fan-out could in principle be large;
 * this is a belt-and-braces backstop, not the primary bound — the primary
 * bound is `test-scope.ts`'s own `MAX_MUTATION_TEST_SCOPE` (150), which caps
 * how many test files are even considered before this function ever runs.
 * Set comfortably above the measured worst case so a legitimate hub file's
 * complete closure is never truncated in practice, while still refusing to
 * let a pathological fan-in balloon one request without bound.
 */
export const MAX_MEASURE_OVERLAYS = 1400;
// Raised 600 -> 1400 on 2026-08-01 against a MEASURED worst case rather than an
// estimate. A graph-scoped run of `session-state.ts` selects 60 affected tests
// whose transitive closure is 845 files — roughly 80% of the tree, because
// `session-state.ts` is imported by `server.ts` and the server's tests reach
// nearly everything. At 600 the run still failed, just loudly instead of
// silently (245 files dropped and named, versus the earlier truncation at 40
// that reported nothing at all).
//
// 845 is the real number for this repo's worst hub file, so 1400 leaves genuine
// headroom without being unbounded. The bound still exists for a reason: it is
// the difference between "this closure is large" and "a pathological fan-in is
// shipping the universe every request".
//
// Worth recording for the cloud design: when a wide test scope's closure is
// most of the repository, per-job content shipping stops being viable and
// content-addressed storage with dedup becomes a requirement, not an
// optimisation — almost every blob is identical between consecutive jobs.

export interface ScopedOverlayResult {
	overlays: MeasureOverlay[];
	/**
	 * Every path this build needed (target, companion, a scope test, or a
	 * transitive local dep) but could not read from disk. MUST be surfaced by
	 * the caller, never silently dropped — a closure that quietly omits a file
	 * is exactly the failure mode this function exists to close (an
	 * incomplete overlay set looks like a working run until the scope widens
	 * enough to expose the gap).
	 */
	unreadable: string[];
	/**
	 * Present only when the candidate set exceeded {@link MAX_MEASURE_OVERLAYS}
	 * AND at least one file was actually dropped as a result. `file`, the
	 * companion, and every path in the requested `testScope` are NEVER
	 * truncated (the caller explicitly asked for them); only the
	 * dependency-closure overflow can be dropped, and it is named here so a
	 * caller can report it rather than measuring against a silently
	 * incomplete closure. Absent when the required set alone exceeds the cap
	 * (nothing droppable — every requested file is still present, so there is
	 * nothing to warn about).
	 */
	capped?: { limit: number; candidateCount: number; dropped: string[] };
}

interface OverlayBuildState {
	out: MeasureOverlay[];
	seeds: string[];
	unreadable: string[];
}

function collectRequestedOverlays(args: {
	file: string;
	content: string;
	readDisk: (path: string) => string | null;
	testScope: string[];
}): OverlayBuildState {
	const out: MeasureOverlay[] = [{ path: args.file, content: args.content }];
	const seeds = [args.file];
	const unreadable: string[] = [];
	const companion = expectedCompanionTest(args.file);
	if (companion !== args.file && pushIfNew(out, companion, args.readDisk)) seeds.push(companion);
	for (const testFile of args.testScope) {
		if (out.some((overlay) => overlay.path === testFile)) continue;
		if (pushIfNew(out, testFile, args.readDisk)) {
			seeds.push(testFile);
		} else {
			unreadable.push(testFile);
		}
	}
	return { out, seeds, unreadable };
}

function appendDependencyClosure(state: OverlayBuildState, readDisk: (path: string) => string | null): void {
	for (const entry of state.seeds) {
		// Use the outer overlay cap, not collectLocalDeps' per-edit default of 40.
		// A graph-scoped test seed can have hundreds of dependencies; the final
		// result below still names every dependency dropped by the outer cap.
		for (const dep of collectLocalDeps(entry, readDisk, MAX_MEASURE_OVERLAYS)) {
			if (state.out.some((overlay) => overlay.path === dep)) continue;
			if (!pushIfNew(state.out, dep, readDisk)) state.unreadable.push(dep);
		}
	}
}

function finishOverlayResult(state: OverlayBuildState): ScopedOverlayResult {
	if (state.out.length <= MAX_MEASURE_OVERLAYS) {
		return { overlays: state.out, unreadable: state.unreadable };
	}
	// Overflow keeps every explicit target, companion, and requested test while
	// capping only the dependency-closure spill.
	const required = new Set(state.seeds);
	const requiredOverlays = state.out.filter((overlay) => required.has(overlay.path));
	const depOverlays = state.out.filter((overlay) => !required.has(overlay.path));
	const budget = Math.max(0, MAX_MEASURE_OVERLAYS - requiredOverlays.length);
	const kept = depOverlays.slice(0, budget);
	const dropped = depOverlays.slice(budget).map((overlay) => overlay.path);
	// If the required set alone exceeds the cap, there is nothing droppable.
	// Preserve every requested file and omit a misleading `capped` verdict.
	if (dropped.length === 0) {
		return { overlays: [...requiredOverlays, ...kept], unreadable: state.unreadable };
	}
	return {
		overlays: [...requiredOverlays, ...kept],
		unreadable: state.unreadable,
		capped: { limit: MAX_MEASURE_OVERLAYS, candidateCount: state.out.length, dropped },
	};
}

/**
 * Full-closure overlay set for a test-SCOPE measurement: the target file, its
 * companion test, EVERY test file in `testScope`, and the transitive
 * local-dep closure of all of them combined — deduped by path.
 *
 * This is what makes a graph-widened test scope (test-scope.ts's
 * reverse-import-graph selection) actually loadable by a runner whose
 * worktree resets to HEAD before each run
 * (scratch/two-box-runner/runner.mjs::resetWorktree): every file Stryker will
 * load must travel as overlay CONTENT, or it comes from the runner's own
 * commit and can be stale relative to the uncommitted edit under measurement.
 * `buildMeasureOverlays` above is the `testScope: []` case of this function.
 */
export function buildScopedMeasureOverlays(
	file: string,
	content: string,
	readDisk: (path: string) => string | null,
	testScope: string[] = [],
): ScopedOverlayResult {
	const state = collectRequestedOverlays({ file, content, readDisk, testScope });
	appendDependencyClosure(state, readDisk);
	return finishOverlayResult(state);
}
