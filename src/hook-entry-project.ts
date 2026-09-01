import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from `cwd` to the nearest ancestor holding a `.interlinked/` dir
 * (the project root the daemon serves), or null within 20 hops. */
export function findRepoRoot(cwd: string): string | null {
	let dir = cwd;
	let depth = 0;
	while (depth < 20) {
		if (existsSync(join(dir, ".interlinked"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
		depth++;
	}
	return null;
}
