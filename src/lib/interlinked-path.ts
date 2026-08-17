// ===========================================
// Interlinked data-directory path helper
// ===========================================
// One canonical place that knows the ".interlinked" directory name and how to
// build a path inside it. Modules used to each declare a private
// `const INTERLINKED_DIR = ".interlinked"` and hand-roll `join(root, DIR, f)`;
// that duplication is what this module replaces.

import { join } from "node:path";

/** Name of the per-repository Interlinked data directory. */
export const INTERLINKED_DIR = ".interlinked";

/**
 * Build a path inside a project's `.interlinked/` data directory.
 *
 * With no segments it returns the data directory itself.
 *
 * @param projectRoot Repository root (absolute or relative).
 * @param segments Path segments below `.interlinked/`.
 */
export function interlinkedPath(projectRoot: string, ...segments: string[]): string {
	return join(projectRoot, INTERLINKED_DIR, ...segments);
}
