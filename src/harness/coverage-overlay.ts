// ===========================================
// Per-edit coverage — apply-before-disk file-tree overlay (rooted under projectRoot)
// ===========================================
// The coverage block runs the project's FULL suite under coverage against the
// PROPOSED file content before that content ever hits disk. Unlike the tsc/biome
// single-file overlays (which overlay one file in an in-memory LanguageService),
// a coverage run needs a real on-disk tree the test runner can spawn against:
// the runner must see the edited file's new content AND every test file.
//
// This module mirrors the project into a unique temp tree and overwrites the one
// edited file with the proposed content. Two non-negotiables:
//
//   1. ROOTED UNDER projectRoot, never os.tmpdir. The coverage/biome/vitest
//      tooling resolves its config and computes report paths relative to the
//      project root; an out-of-tree overlay yields `../`-prefixed relative paths
//      and zero/garbage findings — the exact gotcha the parallel-safety fix and
//      the biome overlay documented (`relative(projectRoot, file)`). The overlay
//      lives at `.interlinked/<COV_OVERLAY_PREFIX><rand>/`.
//   2. CHEAP. `node_modules` is symlinked (not copied) so dependency resolution
//      works without an O(repo) copy; `.git` and the `.interlinked` dir itself
//      are skipped (the latter prevents copying a sibling overlay into the new
//      one — quadratic blowup).
//
// `createCoverageOverlay` is the injectable seam the write-guard depends on, so
// the guard's unit tests stub it out entirely (no real mirror) while the
// real-overlay integration test exercises it end-to-end on a tiny fixture.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { removeInTree, writeFileInTree } from "./overlay-safe-write.js";

/** Directory under projectRoot that holds overlay trees. */
const INTERLINKED_DIR = ".interlinked";
/** mkdtemp prefix for one overlay tree. */
const COV_OVERLAY_PREFIX = ".cov-overlay-";
/** Top-level entries never mirrored (linked or skipped instead). */
const SKIP_ENTRIES = new Set([".git", "node_modules", INTERLINKED_DIR]);

/** A live overlay tree the caller runs a suite against, then cleans up. */
export interface CoverageOverlay {
	/** Absolute path to the overlay project root (mirrors the real root). */
	overlayRoot: string;
	/** Absolute path within the overlay where the edited file's content was written. */
	editedFileInOverlay: string;
	/** Remove the overlay tree. Idempotent / best-effort (never throws). */
	cleanup(): void;
}

/** One sibling file materialized into the overlay alongside the primary edited file.
 *  `delete:true` REMOVES it instead of writing (an apply_patch Delete File, or the
 *  source side of a Move) so the suite runs against an ABSENT file, not an empty one
 *  (findings 2026-06). */
export interface OverlayFile {
	relPath: string;
	content: string;
	delete?: boolean;
}

/** The injectable overlay factory signature the write-guard depends on. `extraFiles`
 *  are SIBLING sections of the same apply_patch (its test + other touched files),
 *  written into the SAME overlay so the suite sees the whole ATOMIC patch — not just
 *  the one production file — and a code+test patch is not falsely reported uncovered. */
export type CreateCoverageOverlayFn = (
	projectRoot: string,
	editedRelPath: string,
	proposedContent: string,
	extraFiles?: ReadonlyArray<OverlayFile>,
) => CoverageOverlay;

/**
 * Mirror the top-level project entries into `overlayRoot`. `node_modules` is
 * symlinked back to the real one (dependency resolution without a deep copy);
 * `.git` and `.interlinked` are skipped. Best-effort per entry — a single
 * unreadable entry must not abort the mirror (the suite can still run).
 */
function mirrorProjectInto(projectRoot: string, overlayRoot: string): void {
	let entries: string[];
	try {
		entries = readdirSync(projectRoot);
	} catch {
		return; // unreadable root → empty overlay; caller's runner will degrade.
	}
	for (const entry of entries) {
		if (SKIP_ENTRIES.has(entry)) continue;
		const src = join(projectRoot, entry);
		const dst = join(overlayRoot, entry);
		try {
			cpSync(src, dst, { recursive: true, dereference: false });
		} catch {
			// intentional: skip an entry that can't be copied (e.g. a transient
			// file removed mid-walk); the rest of the mirror still proceeds.
		}
	}
	linkNodeModules(projectRoot, overlayRoot);
}

/** Symlink the real `node_modules` into the overlay (best-effort). */
function linkNodeModules(projectRoot: string, overlayRoot: string): void {
	const realNodeModules = join(projectRoot, "node_modules");
	try {
		symlinkSync(realNodeModules, join(overlayRoot, "node_modules"), "dir");
	} catch {
		// intentional: no node_modules, or the platform refused the symlink —
		// the runner may still work (e.g. a pure-stdlib fixture) or degrade.
	}
}

/**
 * Write `proposedContent` to `editedRelPath` inside the overlay, creating parent
 * dirs as needed. Covers both an edit to an existing file and a Write of a new
 * file not yet on disk. Returns the absolute path it wrote to.
 */
function writeEditedFile(
	overlayRoot: string,
	editedRelPath: string,
	proposedContent: string,
): string {
	// Symlink-safe (finding 2026-06): the mirror preserves symlinks, so a naive write
	// would follow a symlinked file/parent and modify the real target OUTSIDE the
	// overlay during a read-only gate. `writeFileInTree` de-symlinks the path first.
	return writeFileInTree(overlayRoot, editedRelPath, proposedContent);
}

/**
 * Build an apply-before-disk coverage overlay rooted under `projectRoot`, with
 * the single edited file replaced by `proposedContent`. The caller runs a
 * coverage runner with `overlayRoot` as the project root, then calls
 * `cleanup()`. Never throws on mirror errors — a partial mirror still lets the
 * runner attempt the suite, and the runner itself fails open.
 */
export function createCoverageOverlay(
	projectRoot: string,
	editedRelPath: string,
	proposedContent: string,
	extraFiles?: ReadonlyArray<OverlayFile>,
): CoverageOverlay {
	const overlayParent = join(projectRoot, INTERLINKED_DIR);
	mkdirSync(overlayParent, { recursive: true });
	// Resolve symlinks in the overlay root: a coverage engine records each source
	// file by its REAL (symlink-resolved) path, and the per-file reader keys by
	// `relative(projectRoot, realAbsPath)`. On macOS `os.tmpdir()` →
	// `/var/folders/...` but the real path is `/private/var/folders/...`; an
	// unresolved overlayRoot would make `relative()` emit a `../`-prefixed path
	// that the reader drops as out-of-tree — zero findings, a silent false-allow.
	// Realpath-ing here keeps projectRoot and the recorded paths on the same
	// footing wherever the tree (or its node_modules) crosses a symlink.
	const overlayRoot = realpathSync(mkdtempSync(join(overlayParent, COV_OVERLAY_PREFIX)));

	mirrorProjectInto(projectRoot, overlayRoot);
	const editedFileInOverlay = writeEditedFile(overlayRoot, editedRelPath, proposedContent);
	// Materialize sibling apply_patch sections (its test + other touched files) into
	// the SAME overlay so the suite runs against the whole atomic patch (finding 2026-06).
	// A `delete` section is REMOVED, not written empty, so the suite sees an absent file.
	for (const f of extraFiles ?? []) {
		if (f.relPath === editedRelPath) continue;
		if (f.delete) removeInTree(overlayRoot, f.relPath);
		else writeFileInTree(overlayRoot, f.relPath, f.content);
	}

	return {
		overlayRoot,
		editedFileInOverlay,
		cleanup(): void {
			try {
				rmSync(overlayRoot, { recursive: true, force: true });
			} catch {
				// intentional: best-effort cleanup; a leaked temp dir is harmless.
			}
		},
	};
}
