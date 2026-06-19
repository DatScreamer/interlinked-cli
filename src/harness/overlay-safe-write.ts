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

import { cpSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Replace a symlinked DIRECTORY segment with a real directory carrying a COPY of
 * the link target's contents. Cutting the link is what keeps the write inside
 * `root` — but replacing it with an EMPTY dir made every sibling under that
 * directory vanish from the overlay, so module resolution / sibling tests failed
 * and the red-bar gate falsely blocked valid edits in symlink-based workspaces
 * (finding 2026-06). Nested symlinks are preserved VERBATIM (`dereference:false`)
 * — exactly the project mirror's own contract — because every overlay/snapshot
 * WRITE goes back through this module's de-symlinking, so a preserved link can
 * never be written through; reads were always allowed to follow links. Fail-safe:
 * when the target is unresolvable, not a directory, an ANCESTOR of `root`
 * (copying it into itself would recurse), or the copy throws (cycle,
 * permissions), fall back to the empty real dir — the pre-fix behavior — and
 * warn on stderr.
 */
function materializeSymlinkedDir(root: string, linkPath: string): void {
	let resolved: string | null = null;
	try {
		resolved = realpathSync(linkPath);
	} catch {
		resolved = null; // broken link — nothing to materialize
	}
	removeEntryNoFollow(linkPath, { recursive: false }); // unlink the symlink itself (never its target)
	mkdirSync(linkPath, { recursive: true }); // re-create as a real dir inside the tree
	if (resolved === null) return;
	try {
		if (!statSync(resolved).isDirectory()) return; // a file can hold no siblings
		const rootReal = realpathSync(root);
		// Target is root itself or an ancestor of root → copying would pull the
		// whole tree (including this overlay) into a subdirectory of itself.
		if (rootReal === resolved || rootReal.startsWith(resolved + sep)) {
			process.stderr.write(
				`[interlinked:overlay] WARNING: symlinked dir ${linkPath} resolves to an ancestor of the tree — left empty\n`,
			);
			return;
		}
		cpSync(resolved, linkPath, { recursive: true, dereference: false });
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`[interlinked:overlay] WARNING: could not materialize symlinked dir ${linkPath} (${why}) — siblings unavailable in this tree\n`,
		);
	}
}

/**
 * Remove the entry at `path` WITHOUT ever following a symlink. Links are
 * unlinked via `unlinkSync` regardless of target type — `rmSync(link,
 * {force})` throws ERR_FS_EISDIR for a DIRECTORY symlink on newer Node majors
 * (observed on Node 25, inside the declared `node >=22` engine range; finding
 * 2026-06 round 6), which made every overlay/snapshot write through a
 * symlinked directory fail. Real directories are removed recursively only
 * when asked; missing paths are a no-op.
 */
function removeEntryNoFollow(path: string, opts: { recursive: boolean }): void {
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (!st) return;
	if (st.isSymbolicLink()) {
		unlinkSync(path);
		return;
	}
	rmSync(path, { force: true, ...(opts.recursive ? { recursive: true } : {}) });
}

/**
 * Replace any symlink in the parent chain (root → parent of `relPath`) with a real
 * directory POPULATED with the link target's contents (see
 * {@link materializeSymlinkedDir} — an empty replacement lost every sibling), then
 * remove any symlink/file AT the target, so the eventual write stays inside
 * `root`. Returns the absolute target path. `throwIfNoEntry:false` makes a
 * not-yet-present segment return `undefined` (the dir is materialized below)
 * without an exception.
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
			materializeSymlinkedDir(root, cur);
		}
	}
	return target;
}

function desymlinkPath(root: string, relPath: string): string {
	const target = desymlinkParents(root, relPath);
	mkdirSync(dirname(target), { recursive: true });
	// Drop a symlink (or file) AT the target so the write does not follow it.
	removeEntryNoFollow(target, { recursive: false });
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
	removeEntryNoFollow(target, { recursive: true });
}

/** Replace `relPath` inside `root` with a verbatim copy of the directory `srcDir`,
 *  symlink-safe: the parent chain is de-symlinked and any existing entry at the
 *  target is removed first, so the copy can never escape `root`. Nested symlinks
 *  are preserved verbatim (`dereference:false`) — the tree's standing mirror
 *  contract; later writes still de-symlink through this module. Used to overlay a
 *  DIRECTORY pathspec's worktree state onto a commit snapshot (finding 2026-06). */
export function copyDirInTree(root: string, relPath: string, srcDir: string): string {
	const target = desymlinkParents(root, relPath);
	mkdirSync(dirname(target), { recursive: true });
	removeEntryNoFollow(target, { recursive: true });
	cpSync(srcDir, target, { recursive: true, dereference: false });
	return target;
}
