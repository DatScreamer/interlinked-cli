// Build the complete proposed repository state sent to a mutation runner.
import { expectedCompanionTest } from "../coverage-debt.js";
import { type ChangeSet, changedPaths } from "./changeset.js";
import { collectLocalDeps } from "./local-deps.js";
import { applyChangeSet } from "./provisioner.js";

/** One proposed file state shipped to the runner (spec §7 atomic ChangeSet). */
export interface FileOverlay {
	path: string;
	content: string;
}

function fileOpTouches(op: ChangeSet["ops"][number], file: string): boolean {
	if (op.kind === "rename") return op.from === file || op.to === file;
	if (op.kind === "apply_patch") return op.path === file || op.section.fromPath === file;
	return op.path === file;
}

export function overlayContentFor(changeSet: ChangeSet, file: string, diskContent: string): string | null {
	try {
		const ops = changeSet.ops.filter((op) => fileOpTouches(op, file));
		return applyChangeSet(new Map([[file, diskContent]]), { ops }).get(file) ?? null;
	} catch {
		return null;
	}
}

function appendDiskOverlays(
	out: FileOverlay[],
	paths: readonly string[],
	readDisk: (file: string) => string | null,
): void {
	const have = new Set(out.map((overlay) => overlay.path));
	for (const path of paths) {
		if (have.has(path)) continue;
		const content = readDisk(path);
		if (content === null) continue;
		have.add(path);
		out.push({ path, content });
	}
}

/** Add local modules imported by the target or its selected tests. Existing
 * overlay entries win because they contain the proposed, not on-disk, text. */
function addLocalDeps(
	out: FileOverlay[],
	entries: readonly string[],
	readDisk: (file: string) => string | null,
): void {
	const have = new Set(out.map((overlay) => overlay.path));
	for (const entry of new Set(entries)) {
		for (const dep of collectLocalDeps(entry, readDisk)) {
			if (have.has(dep)) continue;
			const content = readDisk(dep);
			if (content === null) continue;
			have.add(dep);
			out.push({ path: dep, content });
		}
	}
}

/** The full proposed state (spec §7): every changed path, selected tests,
 * the primary companion test, and their local dependencies. */
export function buildMutationOverlays(args: {
	changeSet: ChangeSet;
	target: string;
	overlayContent: string;
	readDisk: (file: string) => string | null;
	testFiles?: readonly string[];
}): FileOverlay[] {
	const { changeSet, target, overlayContent, readDisk, testFiles = [] } = args;
	const out: FileOverlay[] = [{ path: target, content: overlayContent }];
	for (const path of changedPaths(changeSet)) {
		if (path === target) continue;
		const content = overlayContentFor(changeSet, path, readDisk(path) ?? "");
		if (content !== null) out.push({ path, content });
	}
	const companion = expectedCompanionTest(target);
	if (companion !== target && !out.some((overlay) => overlay.path === companion)) {
		const disk = readDisk(companion);
		if (disk !== null) out.push({ path: companion, content: disk });
	}
	appendDiskOverlays(out, testFiles, readDisk);
	addLocalDeps(out, [target, companion, ...testFiles], readDisk);
	return out;
}
