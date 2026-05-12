// ===========================================
// Dirty-dependent pre-commit check
// ===========================================
//
// Catches the failure class that produced commit 7219b48 → red CI:
//   1. Agent edits A.ts (production code) AND B.test.ts (its consumer).
//   2. Tests pass locally because both files are dirty in the working tree.
//   3. Agent stages + commits A.ts only.
//   4. CI checks out a fresh tree — only A's changes are present, B.test.ts
//      reverts to its older shape, the test that depended on the coordinated
//      change now fails. Main turns red.
//
// Detection: when the agent runs `git commit`, walk each staged file's
// transitive importers via the live project graph. If any importer is also
// modified in the working tree but NOT in the index (i.e., dirty but
// unstaged), flag it. The warning names the staged file, the dirty
// importer, and the hop count, with a stronger phrasing when the dirty
// importer is a test file (the canonical failure mode).
//
// This file is pure: caller injects `getImporters` (direct importers, one
// hop) and `isTestFile`. Transitive walk + dedup live here.

const DEFAULT_MAX_DEPTH = 5;

export interface DirtyDependent {
	/** Path the agent is about to commit (staged). */
	staged: string;
	/** Path that imports `staged` (direct or transitive) AND has
	 *  uncommitted-but-unstaged changes in the working tree. */
	dirtyImporter: string;
	/** 1 = direct importer of staged, 2+ = transitive via that many hops. */
	hopCount: number;
	/** Whether `dirtyImporter` is a test file. Stronger signal — the
	 *  failure class we're catching almost always manifests through a
	 *  dirty importer test. */
	isTest: boolean;
}

export interface FindDirtyDependentsArgs {
	/** Files in the index (staged for commit). */
	stagedFiles: readonly string[];
	/** Files modified in the working tree but NOT in the index. */
	unstagedDirtyFiles: readonly string[];
	/** Direct-importer lookup for a file. One hop only — transitive walk
	 *  happens inside this function. */
	getImporters: (file: string) => readonly string[];
	/** Whether a file is a test file. Used to label the match severity. */
	isTestFile: (file: string) => boolean;
	/** Cap on transitive walk depth. Defaults to 5 — beyond that the
	 *  match is too indirect to be actionable. */
	maxDepth?: number;
}

/**
 * Public — find every (staged, dirtyImporter) pair where dirtyImporter
 * imports staged (directly or transitively) AND is dirty-unstaged.
 *
 * One pair per (staged, dirtyImporter); if the same dirty importer hits
 * via two different staged files, both pairs are returned. Hop count is
 * the minimum over reachable paths.
 */
export function findDirtyDependents(args: FindDirtyDependentsArgs): DirtyDependent[] {
	const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
	if (args.stagedFiles.length === 0 || args.unstagedDirtyFiles.length === 0) {
		return [];
	}
	const ctx: WalkCtx = {
		dirtySet: new Set(args.unstagedDirtyFiles),
		stagedSet: new Set(args.stagedFiles),
		getImporters: args.getImporters,
		isTestFile: args.isTestFile,
		maxDepth,
		matches: [],
		seenPair: new Set<string>(),
		// Placeholders — set per-iteration by walkImporters before any
		// helper that reads them runs.
		staged: "",
		depth: 0,
	};
	for (const staged of args.stagedFiles) {
		walkImporters(staged, ctx);
	}
	ctx.matches.sort(compareMatches);
	return ctx.matches;
}

interface WalkCtx {
	dirtySet: Set<string>;
	stagedSet: Set<string>;
	getImporters: (file: string) => readonly string[];
	isTestFile: (file: string) => boolean;
	maxDepth: number;
	matches: DirtyDependent[];
	seenPair: Set<string>;
	/** Top-level staged file the current BFS walk started from. Mutated
	 *  per outer iteration so the helpers can read it without taking it
	 *  as an extra parameter. */
	staged: string;
	/** Current BFS hop count, updated each level. Lives on ctx for the
	 *  same reason as `staged`. */
	depth: number;
}

/** BFS over the importer graph from a single staged file. Each frontier
 *  hop records dirty-unstaged hits and queues new transitive importers
 *  for the next depth. Visited set prevents revisits / cycles. */
function walkImporters(staged: string, ctx: WalkCtx): void {
	ctx.staged = staged;
	let frontier: readonly string[] = [staged];
	const visited = new Set<string>([staged]);
	for (ctx.depth = 1; ctx.depth <= ctx.maxDepth && frontier.length > 0; ctx.depth++) {
		frontier = expandFrontier(frontier, visited, ctx);
	}
}

/** Expand one BFS level: for every node in `frontier`, walk its direct
 *  importers, record any new dirty-unstaged ones, and return the next
 *  layer of unvisited nodes to expand. */
function expandFrontier(
	frontier: readonly string[],
	visited: Set<string>,
	ctx: WalkCtx,
): string[] {
	const next: string[] = [];
	for (const f of frontier) {
		for (const imp of ctx.getImporters(f)) {
			if (visited.has(imp)) continue;
			visited.add(imp);
			recordIfDirty(imp, ctx);
			next.push(imp);
		}
	}
	return next;
}

/** If `imp` is dirty-unstaged (and not itself in the index), append a
 *  `DirtyDependent` match. A staged-and-dirty `imp` is skipped (the
 *  agent is shipping both halves together) but the walk continues past
 *  it via the caller in `expandFrontier`. */
function recordIfDirty(imp: string, ctx: WalkCtx): void {
	if (ctx.stagedSet.has(imp)) return;
	if (!ctx.dirtySet.has(imp)) return;
	const pairKey = `${ctx.staged} ${imp}`;
	if (ctx.seenPair.has(pairKey)) return;
	ctx.seenPair.add(pairKey);
	ctx.matches.push({
		staged: ctx.staged,
		dirtyImporter: imp,
		hopCount: ctx.depth,
		isTest: ctx.isTestFile(imp),
	});
}

/** Stable sort key: test-file matches first, then by hop count, then by
 *  (staged + importer) lexicographically so the output order is
 *  deterministic across runs. */
function compareMatches(a: DirtyDependent, b: DirtyDependent): number {
	if (a.isTest !== b.isTest) return a.isTest ? -1 : 1;
	if (a.hopCount !== b.hopCount) return a.hopCount - b.hopCount;
	return `${a.staged} ${a.dirtyImporter}`.localeCompare(`${b.staged} ${b.dirtyImporter}`);
}

export interface FormatDirtyDependentWarningOpts {
	matches: readonly DirtyDependent[];
	maxShown?: number;
}

/**
 * Public — render the PreToolUse warning string for the matches. Returns
 * null when there are no matches (caller doesn't push anything).
 *
 * Phrasing intentionally non-imperative: this is a warning, not a block.
 * The agent may legitimately be committing one half of a coordinated
 * change with the intent to commit the other half separately. The warning
 * exists to make sure that's a CONSCIOUS choice, not a mistake.
 */
export function formatDirtyDependentWarning(
	opts: FormatDirtyDependentWarningOpts,
): string | null {
	if (opts.matches.length === 0) return null;
	const maxShown = opts.maxShown ?? 5;
	const shown = opts.matches.slice(0, maxShown);
	const more =
		opts.matches.length > shown.length
			? `\n  ...and ${opts.matches.length - shown.length} more`
			: "";
	const lines = shown.map((m) => {
		const hop = m.hopCount === 1 ? "imports" : `imports (transitively, ${m.hopCount} hops)`;
		const tag = m.isTest ? " [TEST]" : "";
		return `  - ${m.dirtyImporter}${tag} ${hop} ${m.staged}, but is dirty in the working tree`;
	});
	const testHit = opts.matches.some((m) => m.isTest);
	const headline = testHit
		? `[interlinked:dirty-dependent] About to commit a file whose dirty importer is a TEST. Local tests may be passing only because of those uncommitted changes — CI will run against the committed snapshot WITHOUT them.`
		: `[interlinked:dirty-dependent] About to commit a file whose dirty importer has unstaged changes. The commit may not be self-contained.`;
	return (
		`${headline}\n${lines.join("\n")}${more}\n` +
		"Stage the importer too (`git add <file>`), stash it (`git stash --keep-index`), " +
		"or split the commit deliberately — but don't ship code whose tests passed only locally."
	);
}
