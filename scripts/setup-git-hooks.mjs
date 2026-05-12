#!/usr/bin/env node
// ============================================================================
// setup-git-hooks.mjs — point this repo's git hooks at scripts/git-hooks/
// ============================================================================
//
// Run by the npm `prepare` script (and `npm run setup-hooks` manually) so
// every contributor gets the local pre-push gate without needing husky /
// lefthook installed. Idempotent — running it twice is a no-op.
//
// Safe to run outside a git repo (e.g. inside a published-package install,
// where no .git exists): we detect the missing .git directory and exit 0.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const gitDir = resolve(projectRoot, ".git");
const hooksDir = "scripts/git-hooks";

// Not a working tree (e.g. npm install of the published tarball) — nothing to do.
if (!existsSync(gitDir)) {
	process.exit(0);
}

const result = spawnSync("git", ["config", "--local", "core.hooksPath", hooksDir], {
	cwd: projectRoot,
	stdio: "inherit",
});

if (result.status !== 0) {
	console.error("setup-git-hooks: failed to set core.hooksPath");
	process.exit(result.status ?? 1);
}

console.log(`[setup-git-hooks] core.hooksPath -> ${hooksDir}`);
