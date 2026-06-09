// ===========================================
// Symlink-safe writes for overlays + commit snapshots
// ===========================================
// An apply-before-disk coverage overlay (`coverage-overlay.ts`) and a commit
// snapshot (`evaluator/staged-snapshot.ts`) build a temp tree by MIRRORING the
// repo, which preserves symlinks (`cpSync … dereference:false`, `git checkout-index`).
// A naive `writeFileSync` / `copyFileSync` into that tree then FOLLOWS a symlinked
// file or a symlinked parent directory and modifies the real target OUTSIDE the temp
// tree — silent data corruption during a read-only PreToolUse gate (findings 2026-06).
//
// Every overlay/snapshot write goes through here. Before writing, the parent chain
// (root → parent of the target) is de-symlinked — any symlinked segment is replaced
// with a real directory — and any symlink AT the target is removed, so a write can
// never escape `root`.

import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Replace any symlink in the parent chain (root → parent of `relPath`) with a real
 * directory, then remove any symlink/file AT the target, so the eventual write stays
 * inside `root`. Returns the absolute target path. `throwIfNoEntry:false` makes a
 * not-yet-present segment return `undefined` (the dir is materialized below) without
 * an exception.
 */
function desymlinkParents(root: string, relPath: string): string {
	const target = join(root, relPath);
	const parts = relative(root, target).split(sep);
	let cur = root;
	// Parent segments only (exclude the final filename).
	for (let i = 0; i < parts.length - 1; i++) {
		cur = join(cur, parts[i]);
		const st = lstatSync(cur, { throwIfNoEntry: false });
		if (st?.isSymbolicLink()) {
			rmSync(cur, { force: true }); // unlink the symlink itself (never its target)
			mkdirSync(cur, { recursive: true }); // re-create as a real dir inside the tree
		}
	}
	return target;
}

function desymlinkPath(root: string, relPath: string): string {
	const target = desymlinkParents(root, relPath);
	mkdirSync(dirname(target), { recursive: true });
	// Drop a symlink (or file) AT the target so the write does not follow it.
	rmSync(target, { force: true });
	return target;
}

/** Write `content` (text or raw bytes) to `relPath` inside `root`, symlink-safe
 *  (never escapes `root`). Bytes matter for the snapshot path — tracked files can
 *  be binary, so a utf-8 round-trip would corrupt them. */
export function writeFileInTree(root: string, relPath: string, content: string | Uint8Array): string {
	const target = desymlinkPath(root, relPath);
	writeFileSync(target, content);
	return target;
}

/** Create a symlink at `relPath` inside `root` pointing at `linkTarget`, symlink-safe —
 *  an existing symlink at the target is removed first, never followed. */
export function symlinkInTree(root: string, relPath: string, linkTarget: string): string {
	const target = desymlinkPath(root, relPath);
	symlinkSync(linkTarget, target);
	return target;
}

/** Remove `relPath` inside `root`, symlink-safe (de-symlinks the parent chain so the
 *  removal cannot escape `root`, then unlinks the target). Idempotent — used to model
 *  an apply_patch Delete / the source side of a Move in an overlay (findings 2026-06). */
export function removeInTree(root: string, relPath: string): void {
	const target = desymlinkParents(root, relPath);
	rmSync(target, { force: true, recursive: true });
}
