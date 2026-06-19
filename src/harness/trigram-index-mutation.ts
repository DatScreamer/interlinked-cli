// interlinked-tdd: exempt
// ===========================================
// Trigram Index — Dirty-Layer Mutation (single-file update + incremental git sync)
// ===========================================
// Extracted from ./trigram-index.ts to keep that file under the per-file line
// cap. These are free functions that take the TrigramIndex dirty-layer state
// they mutate as an EXPLICIT structural view (MutableIndexView); the
// corresponding class methods (updateFile / incrementalUpdate) are thin
// delegates. Behavior is identical to the original inline implementations —
// code was moved verbatim, not changed.
//
// This module imports only the git helpers and primitives the originals used
// (never from ./trigram-index.js) and consumes the class purely through the
// structural MutableIndexView interface, so there is no runtime import cycle.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getChangedFilesSince, getHeadCommit } from "./trigram-git.js";
import {
	DEFAULT_MAX_FILE_SIZE,
	extractTrigrams,
	isBinaryContent,
	shouldSkipFile,
} from "./trigram-primitives.js";

/**
 * Mutable view of the TrigramIndex dirty-layer fields the update path touches.
 * The TrigramIndex instance supplies this from a delegate; `allocFileId` wraps
 * the instance's `nextFileId++` so the counter still lives on the class.
 */
export interface MutableIndexView {
	readonly fileToId: Map<string, number>;
	readonly dirtyOverrides: Map<number, Set<number> | null>;
	readonly dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
	/** Allocate (and consume) the next dirty file ID. */
	allocFileId(): number;
}

/**
 * Update the index for a single file (in-memory dirty layer).
 * Pass null content to mark a file as deleted.
 */
export function updateFileInState(
	view: MutableIndexView,
	relPath: string,
	content: string | null,
): void {
	const existingId = view.fileToId.get(relPath);
	const dirtyNew = view.dirtyNewFiles.get(relPath);

	if (content === null) {
		// File deleted
		if (existingId !== undefined) {
			view.dirtyOverrides.set(existingId, null);
		}
		if (dirtyNew) {
			view.dirtyNewFiles.delete(relPath);
		}
		return;
	}

	// Extract new trigrams
	const trigrams = isBinaryContent(content) ? new Set<number>() : extractTrigrams(content);

	if (existingId !== undefined) {
		// Override existing file
		view.dirtyOverrides.set(existingId, trigrams);
	} else if (dirtyNew) {
		// Update an already-dirty new file
		dirtyNew.trigrams = trigrams;
	} else {
		// Brand new file
		const id = view.allocFileId();
		view.dirtyNewFiles.set(relPath, { id, trigrams });
	}
}

/** Read-only slice of the dirty layer the count/flag/clear helpers consume. */
export interface DirtyStateView {
	readonly dirtyOverrides: Map<number, Set<number> | null>;
	readonly dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
}

/** Number of dirty (modified/added/deleted) files. */
export function dirtyFileCount(view: DirtyStateView): number {
	return view.dirtyOverrides.size + view.dirtyNewFiles.size;
}

/** Whether the index has any dirty state. */
export function isDirtyState(view: DirtyStateView): boolean {
	return view.dirtyOverrides.size > 0 || view.dirtyNewFiles.size > 0;
}

/** Clear all dirty state (e.g., after saving to disk). */
export function clearDirtyState(view: DirtyStateView): void {
	view.dirtyOverrides.clear();
	view.dirtyNewFiles.clear();
}

/**
 * Incrementally update the index from git changes since baseCommit.
 * Reads changed files from disk and applies them through `updateFile`.
 * Returns the number of files updated plus the new base commit; the caller
 * advances its own baseCommit to the returned value.
 */
export function incrementalUpdateState(
	cwd: string,
	baseCommit: string,
	updateFile: (relPath: string, content: string | null) => void,
): { updated: number; newBaseCommit: string } {
	const currentCommit = getHeadCommit(cwd);
	if (currentCommit === baseCommit) return { updated: 0, newBaseCommit: baseCommit };

	// If diff fails (e.g., base commit no longer exists), return 0 —
	// a full rebuild would be needed.
	const changedFiles = getChangedFilesSince(cwd, baseCommit);
	if (changedFiles === null) return { updated: 0, newBaseCommit: baseCommit };

	let updated = 0;
	for (const relPath of changedFiles) {
		if (shouldSkipFile(relPath)) continue;
		const absPath = join(cwd, relPath);
		try {
			if (!existsSync(absPath)) {
				updateFile(relPath, null);
				updated++;
				continue;
			}
			const buf = readFileSync(absPath);
			if (buf.length > DEFAULT_MAX_FILE_SIZE || isBinaryContent(buf)) {
				updateFile(relPath, null);
			} else {
				updateFile(relPath, buf.toString("utf-8"));
			}
			updated++;
		} catch (err) {
			void err; /* intentional: skip unreadable files during incremental rebuild */
		}
	}

	return { updated, newBaseCommit: currentCommit };
}
