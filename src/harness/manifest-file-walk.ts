// Bounded recursive file finder shared by the supply-chain surfaces that must
// enumerate variably-named, NESTED manifests (*.csproj, libs.versions.toml):
// the package-install snapshot gate (PreToolUse), `allowlist verify` (CI scan),
// and `allowlist snapshot`. .NET/Gradle nest these in subdirectories
// (src/App/App.csproj), so a root-only scan misses the projects `dotnet
// restore` actually resolves — which let an unapproved nested dependency slip
// past the snapshot gate (finding 2026-06).
//
// Returns paths RELATIVE to `root` (POSIX `/`-separated) so a caller can use the
// relative path as a stable snapshot KEY — bare basenames would alias two
// App.csproj in different dirs onto one snapshot entry — and `join(root, rel)`
// to read. Symlinked directories are NOT traversed: `Dirent.isDirectory()` is
// false for a symlink (it reflects lstat), so the walk can't escape the tree.

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

// Dirs never worth walking for source manifests; a node_modules descent alone
// would make the walk ruinous, and build outputs (bin/obj/target) only hold
// copies of the real project files.
const WALK_IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".interlinked",
	"dist",
	"build",
	"bin",
	"obj",
	"target",
	"vendor",
	"coverage",
	".next",
	"out",
	".venv",
	"venv",
	"__pycache__",
]);
const MAX_WALK_DEPTH = 8;

export function findManifestFiles(root: string, match: (name: string) => boolean): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
				a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
			);
		} catch {
			return;
		}
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (depth >= MAX_WALK_DEPTH || WALK_IGNORE_DIRS.has(e.name)) continue;
				walk(join(dir, e.name), childRel, depth + 1);
			} else if (e.isFile() && match(e.name)) {
				out.push(childRel);
			}
		}
	};
	walk(root, "", 0);
	return out;
}
