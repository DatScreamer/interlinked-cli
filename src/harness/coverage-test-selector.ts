// ===========================================
// Affected-test selection — the keystone that makes per-edit coverage AFFORDABLE
// ===========================================
// The per-edit coverage / red-green / CRAP gate (evaluator/coverage-write-guard.ts)
// runs the project's suite under coverage against an apply-before-disk overlay. On
// a real repo with a slow suite that FULL run blows the ~25s per-edit budget, so
// the gate defers and never actually enforces. This module fixes that: given the
// edited file, it walks the REVERSE import graph (DependencyView.getDependents)
// transitively and returns ONLY the test files that could be affected by the edit
// — a tiny, fast subset the overlay run fits inside the budget. The runner is then
// pointed at exactly those tests (vitest run <paths> / pytest <paths>).
//
// Three return states, each load-bearing for the caller's decision:
//   - `null`  — selection could not produce a PROVABLY COMPLETE answer: the
//               edited file is not in the dependency graph (e.g. a brand-new
//               source file not yet indexed), the view only answers for its own
//               seed file (a per-file Supermodel shard — no honest transitive
//               walk), or the BFS hit its node cap with frontier remaining
//               (truncated ⇒ possibly missing tests). The caller must fall back
//               to the FULL suite — running a wrong/incomplete subset would
//               falsely pass the gate. "Don't know which tests" ≠ "no tests".
//   - `[]`    — the file IS in the graph but NO test transitively depends on it.
//               For a source edit this is the strict-TDD signal: the added
//               executable lines are exercised by nothing, so the caller BLOCKS
//               ("write the test for <file> in this edit").
//   - `[…]`   — the affected test paths (repo-relative POSIX), deduped + sorted
//               for a deterministic command. The caller runs only these.
//
// Why the reverse graph and not a fresh scan: the daemon already holds a
// `ProjectGraph` (built once on startup, refreshed incrementally) behind the
// `DependencyView` seam — the SAME graph PostToolUse impact analysis uses. We
// REUSE it; we never build a second graph here.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { DependencyView } from "./dependency-view.js";

/** Inputs for {@link selectAffectedTests}. */
export interface SelectAffectedTestsInput {
	/** Repo-relative POSIX path of the edited file (e.g. `src/m.ts`). */
	editedRelPath: string;
	/** Absolute project root the relative paths resolve against. */
	projectRoot: string;
	/** The dependency view the daemon already built (reverse import graph). */
	depView: DependencyView;
}

/** BFS node-expansion ceiling — the reverse graph is shallow, but a malformed
 *  cyclic graph must still terminate quickly. The `visited` set already
 *  guarantees termination; this is a belt-and-braces bound so a pathological
 *  fan-in can't make the per-edit gate slow (the very thing this module exists
 *  to avoid). Hitting the cap with frontier REMAINING means the collected set
 *  may be incomplete, so the selector returns `null` (full-suite fallback) —
 *  a truncated walk must never masquerade as a complete subset (finding
 *  2026-06: it returned the partial set, and a missed affected test let a
 *  breaking edit through the scoped run). */
const MAX_TRANSITIVE_HOPS = 1000;

/**
 * Is `relPath` a test/spec file? Matches the cross-language conventions the task
 * pins explicitly: `*.test.*` / `*.spec.*` (JS/TS and friends), `test_*.py`,
 * `*_test.py`, `*_test.go`, and anything under a `__tests__/` directory. Purely
 * path-based — the file need not exist on disk.
 */
export function isTestPath(relPath: string): boolean {
	const norm = relPath.replace(/\\/g, "/");
	if (/(?:^|\/)__tests__\//.test(norm)) return true;
	const name = norm.split("/").pop() ?? "";
	if (/\.(?:test|spec)\.[^/]+$/.test(name)) return true;
	if (name.startsWith("test_") && name.endsWith(".py")) return true;
	if (/_test\.py$/.test(name)) return true;
	if (/_test\.go$/.test(name)) return true;
	return false;
}

/** Resolve a graph path (absolute or relative) to a repo-relative POSIX path, or
 *  null when it lands outside `projectRoot` (a foreign-repo dependent is not part
 *  of this repo's test run). */
function toRepoRel(p: string, projectRoot: string): string | null {
	const abs = isAbsolute(p) ? p : resolve(projectRoot, p);
	const rel = relative(projectRoot, abs).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

/**
 * Candidate companion test paths for a source file, e.g. `src/m.ts` →
 * `src/m.test.ts`, `src/m.spec.ts`, `src/__tests__/m.test.ts`, … Included only
 * when they actually exist on disk, so the runner is never pointed at a phantom.
 * The transitive BFS already finds a companion that *imports* the edited file;
 * this is the safety net for a companion the regex import graph missed (e.g. a
 * test that imports via a path alias the graph didn't resolve).
 */
function companionTestCandidates(editedRelPath: string): string[] {
	const norm = editedRelPath.replace(/\\/g, "/");
	const dot = norm.lastIndexOf(".");
	if (dot <= 0) return [];
	const stem = norm.slice(0, dot); // src/dir/m
	const ext = norm.slice(dot + 1); // ts
	const slash = stem.lastIndexOf("/");
	const dir = slash >= 0 ? stem.slice(0, slash) : "";
	const base = slash >= 0 ? stem.slice(slash + 1) : stem; // m
	const prefix = dir ? `${dir}/` : "";
	const tdir = dir ? `${dir}/__tests__/` : "__tests__/";
	return [
		`${prefix}${base}.test.${ext}`,
		`${prefix}${base}.spec.${ext}`,
		`${tdir}${base}.test.${ext}`,
		`${tdir}${base}.spec.${ext}`,
	];
}

/**
 * Select the test files transitively affected by an edit to `editedRelPath`.
 *
 * Algorithm: BFS the reverse import graph from the edited file. Each visited node
 * is asked for its dependents (`depView.getDependents`) — the files that import
 * it — and any dependent that is itself a test file is collected. The walk is
 * transitive (a test that imports a module that imports the edited file is
 * included) and cycle-safe (a `visited` set). The edited file's own companion
 * tests are added when they exist on disk. Returns repo-relative POSIX paths,
 * deduped + sorted; `null` when the edited file is not in the graph; `[]` when it
 * is but nothing tests it.
 *
 * Pure read over the already-built graph — never triggers a rebuild, never
 * touches the network, and (companion check aside) never touches the filesystem.
 */
export function selectAffectedTests(input: SelectAffectedTestsInput): string[] | null {
	const { editedRelPath, projectRoot, depView } = input;
	const editedAbs = resolve(projectRoot, editedRelPath);

	// A seed-only view (per-file Supermodel shard) answers EVERY getDependents
	// call with the seed file's dependents, whatever the argument — so a
	// "transitive" walk over it just re-expands hop 1 forever and silently
	// misses indirect tests (finding 2026-06: a nonempty-but-incomplete subset
	// skipped a failing indirect test). No honest transitive selection is
	// possible → full-suite fallback.
	if (depView.answerScope !== "repo") return null;

	// "Not in the graph" → null → caller runs the full suite. Distinguishing this
	// from `[]` is the whole point: an empty subset must never falsely pass.
	if (!depView.hasFile(editedAbs)) return null;

	const tests = new Set<string>();
	const visited = new Set<string>([editedAbs]);
	const queue: string[] = [editedAbs];
	let head = 0;
	for (; head < queue.length && head < MAX_TRANSITIVE_HOPS; head++) {
		const current = queue[head];
		if (current === undefined) break;
		for (const dependent of depView.getDependents(current)) {
			const depAbs = isAbsolute(dependent) ? dependent : resolve(projectRoot, dependent);
			if (visited.has(depAbs)) continue;
			visited.add(depAbs);
			queue.push(depAbs);
			const rel = toRepoRel(depAbs, projectRoot);
			if (rel && isTestPath(rel)) tests.add(rel);
		}
	}
	// Cap hit with frontier remaining → the walk was TRUNCATED and `tests` may be
	// missing affected tests beyond the cap. An incomplete subset must never be
	// returned as if complete — a scoped run drawn from it could skip the very
	// test this edit breaks and approve it (finding 2026-06). Full-suite fallback.
	if (head < queue.length) return null;

	// The edited file's own companion test(s), when present on disk — covers a
	// companion the import graph failed to link.
	for (const candidate of companionTestCandidates(editedRelPath)) {
		if (existsSync(resolve(projectRoot, candidate))) tests.add(candidate);
	}

	return [...tests].sort();
}
