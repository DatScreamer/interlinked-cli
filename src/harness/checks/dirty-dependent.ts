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
// Detection runs in BOTH directions when the agent runs `git commit`:
//   - importer direction: a staged file's transitive *importer* is dirty-
//     unstaged (the canonical case — staged production, dirty consumer test).
//   - dependency direction: a staged file's transitive *dependency* is dirty-
//     unstaged (the mirror — e.g. a staged test whose production code stays
//     dirty; CI runs the new test against the old code).
//
// Precision: a candidate match is dropped when the injected `isRelevant`
// predicate reports the two files' changes are unrelated — the dirty file is
// dirty for a reason that has nothing to do with the staged change.
// `looksCoordinated` (exported, pure) is the predicate the caller builds on:
// it cross-references the two files' diffs by changed-definition name.
// Without `isRelevant` (e.g. in unit tests) every candidate is kept.
//
// This file is pure: caller injects `getImporters`, `getDependencies`,
// `isTestFile`, and (optionally) `isRelevant`. Graph walk, dedup, and the
// diff-cross-reference helpers live here.

const DEFAULT_MAX_DEPTH = 5;

/** Which way the import edge runs between `staged` and `dirtyFile`.
 *  - `importer`   → `dirtyFile` imports `staged`
 *  - `dependency` → `staged` imports `dirtyFile` */
export type DirtyDependentDirection = "importer" | "dependency";

export interface DirtyDependent {
	/** Path the agent is about to commit (staged). */
	staged: string;
	/** Path that is dirty-but-unstaged and graph-related to `staged`.
	 *  `direction` says how the two are connected. */
	dirtyFile: string;
	/** Edge direction between `staged` and `dirtyFile`. */
	direction: DirtyDependentDirection;
	/** 1 = direct, 2+ = transitive via that many hops. */
	hopCount: number;
	/** Whether `dirtyFile` is a test file. Stronger signal — the failure
	 *  class almost always manifests through a dirty test. */
	isTest: boolean;
}

export interface FindDirtyDependentsArgs {
	/** Files in the index (staged for commit). */
	stagedFiles: readonly string[];
	/** Files modified in the working tree but NOT in the index. */
	unstagedDirtyFiles: readonly string[];
	/** Direct importers of a file — one hop, reverse edges. Transitive walk
	 *  happens inside this function. */
	getImporters: (file: string) => readonly string[];
	/** Direct dependencies of a file — one hop, forward edges. Optional:
	 *  when omitted the dependency-direction walk is skipped (importer-only,
	 *  the pre-symmetric behavior). */
	getDependencies?: (file: string) => readonly string[];
	/** Whether a file is a test file. Used to label match severity. */
	isTestFile: (file: string) => boolean;
	/** Optional precision filter. Returns `false` to DROP a candidate match
	 *  whose two files are dirty/staged for unrelated reasons. Omitted →
	 *  every candidate is kept. */
	isRelevant?: (match: DirtyDependent) => boolean;
	/** Cap on transitive walk depth. Defaults to 5 — beyond that the match
	 *  is too indirect to be actionable. */
	maxDepth?: number;
}

/**
 * Public — find every (staged, dirtyFile) pair where the two are
 * import-graph related (either direction) AND `dirtyFile` is dirty-unstaged.
 *
 * One pair per (staged, dirtyFile, direction). Hop count is the minimum over
 * reachable paths. Candidates the `isRelevant` predicate rejects are removed
 * before the result is sorted (tests first, then hop count, then stable).
 */
export function findDirtyDependents(args: FindDirtyDependentsArgs): DirtyDependent[] {
	const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
	if (args.stagedFiles.length === 0 || args.unstagedDirtyFiles.length === 0) {
		return [];
	}
	const ctx: WalkCtx = {
		dirtySet: new Set(args.unstagedDirtyFiles),
		stagedSet: new Set(args.stagedFiles),
		isTestFile: args.isTestFile,
		maxDepth,
		matches: [],
		seenPair: new Set<string>(),
		// Placeholders — set per-walk by walkGraph before any helper reads them.
		staged: "",
		depth: 0,
		direction: "importer",
		expand: args.getImporters,
	};
	for (const staged of args.stagedFiles) {
		walkGraph(staged, ctx, args.getImporters, "importer");
		if (args.getDependencies) {
			walkGraph(staged, ctx, args.getDependencies, "dependency");
		}
	}
	const { isRelevant } = args;
	const result = isRelevant ? ctx.matches.filter((m) => isRelevant(m)) : ctx.matches;
	result.sort(compareMatches);
	return result;
}

interface WalkCtx {
	dirtySet: Set<string>;
	stagedSet: Set<string>;
	isTestFile: (file: string) => boolean;
	maxDepth: number;
	matches: DirtyDependent[];
	seenPair: Set<string>;
	/** Staged file the current walk started from. Mutated per walk so the
	 *  helpers can read it without an extra parameter. */
	staged: string;
	/** Current BFS hop count, updated each level. */
	depth: number;
	/** Direction of the current walk. */
	direction: DirtyDependentDirection;
	/** Neighbor function for the current walk (importers or dependencies).
	 *  Set per walk so `expandFrontier` stays a 3-parameter function. */
	expand: (file: string) => readonly string[];
}

/** BFS over the import graph from a single staged file, following `expand`
 *  (importers or dependencies). Each frontier hop records dirty-unstaged
 *  hits and queues new transitive nodes. Visited set prevents revisits and
 *  breaks cycles. */
function walkGraph(
	start: string,
	ctx: WalkCtx,
	expand: (file: string) => readonly string[],
	direction: DirtyDependentDirection,
): void {
	ctx.staged = start;
	ctx.direction = direction;
	ctx.expand = expand;
	let frontier: readonly string[] = [start];
	const visited = new Set<string>([start]);
	for (ctx.depth = 1; ctx.depth <= ctx.maxDepth && frontier.length > 0; ctx.depth++) {
		frontier = expandFrontier(frontier, visited, ctx);
	}
}

/** Expand one BFS level: for every node in `frontier`, walk `ctx.expand`,
 *  record any new dirty-unstaged hit, and return the next layer of
 *  unvisited nodes. */
function expandFrontier(
	frontier: readonly string[],
	visited: Set<string>,
	ctx: WalkCtx,
): string[] {
	const next: string[] = [];
	for (const f of frontier) {
		for (const related of ctx.expand(f)) {
			if (visited.has(related)) continue;
			visited.add(related);
			recordIfDirty(related, ctx);
			next.push(related);
		}
	}
	return next;
}

/** If `file` is dirty-unstaged (and not itself in the index), append a
 *  `DirtyDependent` match. A staged-and-dirty `file` is skipped (the agent
 *  is shipping both halves together) but the walk continues past it. */
function recordIfDirty(file: string, ctx: WalkCtx): void {
	if (ctx.stagedSet.has(file)) return;
	if (!ctx.dirtySet.has(file)) return;
	const pairKey = `${ctx.staged}\t${file}\t${ctx.direction}`;
	if (ctx.seenPair.has(pairKey)) return;
	ctx.seenPair.add(pairKey);
	ctx.matches.push({
		staged: ctx.staged,
		dirtyFile: file,
		direction: ctx.direction,
		hopCount: ctx.depth,
		isTest: ctx.isTestFile(file),
	});
}

/** Stable sort key: test-file matches first, then by hop count, then by
 *  (staged, dirtyFile, direction) lexicographically for deterministic
 *  output across runs. */
function compareMatches(a: DirtyDependent, b: DirtyDependent): number {
	if (a.isTest !== b.isTest) return a.isTest ? -1 : 1;
	if (a.hopCount !== b.hopCount) return a.hopCount - b.hopCount;
	const ka = `${a.staged}\t${a.dirtyFile}\t${a.direction}`;
	const kb = `${b.staged}\t${b.dirtyFile}\t${b.direction}`;
	return ka.localeCompare(kb);
}

// ===========================================
// Precision: coordinated-change detection
// ===========================================
//
// A dirty importer is only a real risk when the dirty file's change and the
// staged change are COORDINATED — two halves of one logical edit. An
// unrelated edit to a file that happens to sit on the import graph is noise.
// `looksCoordinated` distinguishes the two by cross-referencing the diffs.

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/;

/**
 * Extract the trailing context from every hunk header in a unified diff —
 * the enclosing-definition line git appends after the second `@@`.
 */
function parseHunkContexts(diff: string): string[] {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		const m = line.match(HUNK_HEADER);
		if (m) {
			const ctx = m[1].trim();
			if (ctx.length > 0) out.push(ctx);
		}
	}
	return out;
}

/**
 * Pull the most likely changed-definition name out of a git hunk-context
 * string (the signature line of the enclosing function/class/etc.).
 * Returns null when no name is recognizable.
 */
function defNameFromContext(context: string): string | null {
	const byKeyword = context.match(
		/\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
	);
	if (byKeyword) return byKeyword[1];
	const byBinding = context.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
	if (byBinding) return byBinding[1];
	const byCallable = context.match(/([A-Za-z_$][\w$]*)\s*[(<:]/);
	if (byCallable) return byCallable[1];
	return null;
}

/** Set of changed-definition names extracted from a file's unified diff. */
function changedSymbols(diff: string): Set<string> {
	const names = new Set<string>();
	for (const ctx of parseHunkContexts(diff)) {
		const name = defNameFromContext(ctx);
		if (name) names.add(name);
	}
	return names;
}

/** Identifier tokens appearing on the added/removed lines of a diff
 *  (context and header lines are ignored). */
function changedLineIdentifiers(diff: string): Set<string> {
	const tokens = new Set<string>();
	for (const line of diff.split("\n")) {
		const isAdd = line.startsWith("+") && !line.startsWith("+++");
		const isDel = line.startsWith("-") && !line.startsWith("---");
		if (!isAdd && !isDel) continue;
		for (const tok of line.slice(1).split(/[^A-Za-z0-9_$]+/)) {
			if (tok.length > 0) tokens.add(tok);
		}
	}
	return tokens;
}

/** Stop-words excluded from {@link fallbackTopicSymbols} so the fallback
 *  doesn't latch onto JS/TS keywords or universal-constant identifiers. */
const COORD_STOP_WORDS: ReadonlySet<string> = new Set([
	// JS/TS keywords + universal globals
	"const", "let", "var", "function", "class", "interface", "type",
	"enum", "import", "export", "from", "default", "return", "true",
	"false", "null", "undefined", "void", "this", "new", "throw",
	"async", "await", "yield", "static", "public", "private", "protected",
	"readonly", "extends", "implements", "namespace", "module", "abstract",
	// Universal type names (would falsely cross-reference across unrelated files)
	"string", "number", "boolean", "object", "Record", "Array",
	"Promise", "Map", "Set", "Date", "Error", "RegExp", "Buffer",
	"console", "process",
]);

/**
 * Fallback topic set used by {@link looksCoordinated} when {@link changedSymbols}
 * extracted nothing — typical for top-level additions whose hunk context
 * is empty. Pulls identifier-shaped tokens from added/removed lines so
 * pure-registration diffs (e.g., `const newCmd = program.command(...)` at
 * file scope) still surface a "topic" the other side can cross-reference.
 *
 * Filters: identifier shape, length ≥ 4 chars, not a JS keyword or
 * universal global. The length floor is what keeps `a` / `is` / `if`
 * out of the topic set; the stop-word set kills `const` / `Promise`.
 */
function fallbackTopicSymbols(diff: string): Set<string> {
	const out = new Set<string>();
	for (const tok of changedLineIdentifiers(diff)) {
		if (tok.length < 4) continue;
		if (COORD_STOP_WORDS.has(tok)) continue;
		if (!/^[A-Za-z_$]/.test(tok)) continue;
		out.add(tok);
	}
	return out;
}

/**
 * Public, pure — heuristic: do the two changes look COORDINATED (two halves
 * of one logical edit) rather than unrelated? The two diffs are a symmetric
 * pair — order within the tuple does not affect the result.
 *
 * Signal: a definition whose body changed in one file's diff is named, by
 * token, on a changed line of the other file's diff. A coordinated edit
 * (changed `foo`, updated `foo`'s test) leaves that cross-reference; an
 * unrelated edit does not.
 *
 * Two-pass topic extraction: per-side, prefer {@link changedSymbols} (hunk-
 * context-derived); fall back to {@link fallbackTopicSymbols} when the hunk
 * context is empty — catches top-level diffs (new top-level `const`, new
 * commander registrations, new exports) whose hunk header has no enclosing
 * function/class context.
 *
 * Fails OPEN — returns `true` (treat as coordinated → keep the warning)
 * whenever evidence is insufficient (both sides yield no identifier even
 * via the fallback). Returns `false` (drop) only with positive evidence
 * of non-coordination: both sides have identifiers and no cross-match.
 */
export function looksCoordinated(diffs: readonly [string, string]): boolean {
	const [diffA, diffB] = diffs;
	let symsA = changedSymbols(diffA);
	let symsB = changedSymbols(diffB);
	if (symsA.size === 0) symsA = fallbackTopicSymbols(diffA);
	if (symsB.size === 0) symsB = fallbackTopicSymbols(diffB);
	if (symsA.size === 0 || symsB.size === 0) return true;
	const tokensA = changedLineIdentifiers(diffA);
	const tokensB = changedLineIdentifiers(diffB);
	for (const s of symsA) {
		if (tokensB.has(s)) return true;
	}
	for (const s of symsB) {
		if (tokensA.has(s)) return true;
	}
	return false;
}

export interface FormatDirtyDependentWarningOpts {
	matches: readonly DirtyDependent[];
	maxShown?: number;
}

/** Per-direction renderer for one match line. `hop` is the transitive-hop
 *  suffix (empty for a direct edge); `tag` is the ` [TEST]` marker. */
const MATCH_LINE: Record<
	DirtyDependentDirection,
	(m: DirtyDependent, hop: string, tag: string) => string
> = {
	importer: (m, hop, tag) =>
		`  - ${m.dirtyFile}${tag} imports${hop} ${m.staged}, but is dirty in the working tree`,
	dependency: (m, hop, tag) =>
		`  - ${m.staged} imports${hop} ${m.dirtyFile}${tag}, which is dirty in the working tree`,
};

/**
 * Public — render the PreToolUse warning string for the matches. Returns
 * null when there are no matches (caller doesn't push anything).
 *
 * Phrasing intentionally non-imperative: this is a warning, not a block.
 * The agent may legitimately be committing one half of a coordinated change
 * with the intent to commit the other half separately. The warning exists
 * to make sure that's a CONSCIOUS choice, not a mistake.
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
		const hop = m.hopCount === 1 ? "" : ` (transitively, ${m.hopCount} hops)`;
		const tag = m.isTest ? " [TEST]" : "";
		return MATCH_LINE[m.direction](m, hop, tag);
	});
	const testHit = opts.matches.some((m) => m.isTest);
	const headline = testHit
		? `[interlinked:dirty-dependent] About to commit code whose dirty companion is a TEST. Local tests may be passing only because of those uncommitted changes — CI will run against the committed snapshot WITHOUT them.`
		: `[interlinked:dirty-dependent] About to commit a file with a dirty, unstaged companion on the import graph. The commit may not be self-contained.`;
	return (
		`${headline}\n${lines.join("\n")}${more}\n` +
		"Stage the companion too (`git add <file>`), stash it (`git stash --keep-index`), " +
		"or split the commit deliberately — but don't ship code whose tests passed only locally."
	);
}
