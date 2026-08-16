// ===========================================
// Trigram Index — Git / File Discovery
// ===========================================
// Freestanding git helpers used by TrigramIndex.build() and
// incrementalUpdate() for file discovery and commit pinning. None of these
// reference TrigramIndex instance state — they take a cwd and shell out to git
// (with a filesystem-walk fallback when git is unavailable).

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Extensions worth trigram-indexing from gitignored scratch/ — code and prose
 *  an agent would grep for. Deliberately EXCLUDES data extensions (.json,
 *  .jsonl, .txt, .log): campaign output there reached 290MB and ballooned the
 *  postings 16x, which the daemon then expanded to ~1.6GB of heap at startup
 *  (finding #21, 2026-08-16 restart-storm postmortem). */
const SCRATCH_INDEXABLE_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|py|rs|go|rb|sh|zsh|md)$/i;

/** Hard cap on scratch/ files admitted to the index. The count, not the bytes,
 *  is what explodes the posting lists: the 2026-08 mutation campaign left
 *  17,157 near-identical generated probe files in scratch/ (the tracked repo
 *  itself has ~2,700) and the builder OOM'd at 4GB on them even after the
 *  extension filter. A human/agent greps recent drafts, not campaign bulk, so
 *  when over cap we keep the most recently modified files and say so. */
const SCRATCH_INDEX_MAX_FILES = 2000;

/** Bound scratch candidates to {@link SCRATCH_INDEX_MAX_FILES}, newest first.
 *  Loud by design: truncation prints one stderr line naming the dropped count —
 *  a silent cap would read as "scratch is indexed" while most of it is not. */
function boundScratchCandidates(cwd: string, files: string[]): string[] {
	if (files.length <= SCRATCH_INDEX_MAX_FILES) return files;
	const byMtime = files
		.map((f) => {
			let mtime = 0;
			try {
				mtime = statSync(join(cwd, f)).mtimeMs;
			} catch (err) {
				void err; // unstattable → mtime stays 0 → sorts oldest, dropped first
			}
			return { f, mtime };
		})
		.sort((a, b) => b.mtime - a.mtime);
	const kept = byMtime.slice(0, SCRATCH_INDEX_MAX_FILES).map((e) => e.f);
	process.stderr.write(
		`[interlinked:index] scratch/ over cap: indexing newest ${SCRATCH_INDEX_MAX_FILES} of ${files.length} code files (${files.length - SCRATCH_INDEX_MAX_FILES} older ones skipped)\n`,
	);
	return kept;
}

/** Get list of tracked files via `git ls-files`. Falls back to filesystem walk. */
export function getTrackedFiles(cwd: string): string[] {
	try {
		const output = execSync("git ls-files -z", {
			cwd,
			encoding: "buffer",
			timeout: 30_000,
			maxBuffer: 50 * 1024 * 1024, // 50MB for large repos
		});
		// Split on null bytes, filter empty
		const tracked = output
			.toString("utf-8")
			.split("\0")
			.filter((f) => f.length > 0);

		// Also include gitignored .interlinked/hooks/ files — these are generated
		// by `interlinked enable` and should be searchable (e.g. the hook script).
		try {
			const extra = execSync("git ls-files -z --others -- .interlinked/hooks/", {
				cwd,
				encoding: "buffer",
				timeout: 5_000,
				maxBuffer: 1 * 1024 * 1024,
			});
			const untracked = extra
				.toString("utf-8")
				.split("\0")
				.filter((f) => f.length > 0);
			if (untracked.length > 0) {
				tracked.push(...untracked);
			}
		} catch (err) {
			void err; /* intentional: non-fatal — hooks dir may not exist */
		}

		// Also include gitignored scratch/ files — the sanctioned home for
		// session/agent scripts (operator decision 2026-07-07: scratch work is
		// first-class — gated, greppable via the root .ignore negation, and
		// indexed here so the grep ACCELERATOR sees what plain rg now sees).
		// CODE/PROSE EXTENSIONS ONLY (2026-08-16, finding #21): `--others` lists
		// gitignored files too, so campaign DATA in scratch/ (receipts .jsonl,
		// probe output .json/.txt) went into the index — 290MB of it ballooned
		// the postings 9.7MB → 153MB, the daemon expanded that to ~1.6GB at
		// startup (at its own 1536MB heap cap), and every later allocation
		// became the OOM/restart storm. Data files are queryable via
		// `interlinked query`; the trigram index is for code search.
		try {
			const extra = execSync("git ls-files -z --others -- scratch/", {
				cwd,
				encoding: "buffer",
				timeout: 5_000,
				maxBuffer: 5 * 1024 * 1024,
			});
			const untracked = boundScratchCandidates(
				cwd,
				extra
					.toString("utf-8")
					.split("\0")
					.filter((f) => f.length > 0 && SCRATCH_INDEXABLE_EXT_RE.test(f)),
			);
			if (untracked.length > 0) {
				tracked.push(...untracked);
			}
		} catch (err) {
			void err; /* intentional: non-fatal — scratch dir may not exist */
		}

		return tracked;
	} catch {
		// Fallback: walk filesystem (limited to 2 levels for safety)
		return walkDir(cwd, cwd, 0, 5);
	}
}

/** Simple recursive directory walk (fallback when git is unavailable) */
function walkDir(dir: string, root: string, depth: number, maxDepth: number): string[] {
	if (depth > maxDepth) return [];
	const results: string[] = [];
	try {
		// G4: byte-order sort — raw readdir order is filesystem-dependent, and
		// trigram file-ids are assigned in walk order (locale-free comparator).
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...walkDir(full, root, depth + 1, maxDepth));
			} else if (entry.isFile()) {
				results.push(relative(root, full));
			}
		}
	} catch (err) {
		void err; /* intentional: permission errors etc. just return what we've found */
	}
	return results;
}

/** Get the current HEAD commit hash */
export function getHeadCommit(cwd: string): string {
	try {
		return execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf-8",
			timeout: 5_000,
		}).trim();
	} catch {
		return "unknown";
	}
}

/**
 * List files changed between `baseCommit` and HEAD (via `git diff --name-only`).
 * Returns null when the diff fails (e.g., base commit no longer exists) so the
 * caller can decide a full rebuild is needed — distinct from an empty result.
 */
export function getChangedFilesSince(cwd: string, baseCommit: string): string[] | null {
	try {
		const diff = execSync(`git diff --name-only ${baseCommit}..HEAD`, {
			cwd,
			encoding: "utf-8",
			timeout: 10_000,
		}).trim();
		return diff ? diff.split("\n").filter(Boolean) : [];
	} catch {
		// If diff fails (e.g., base commit no longer exists), signal "unknown".
		return null;
	}
}
