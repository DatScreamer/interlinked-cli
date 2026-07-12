// ===========================================
// `interlinked scratch` — provision the sanctioned session-script home
// ===========================================
// scratch/ is the in-repo, gitignored-but-governed landing zone for session
// and agent scripts (probes, migration drivers, analysis one-offs): quality
// gates apply, rg/trigram search sees it, and it survives the session —
// everything the host's ephemeral scratchpad is not. The scratchpad write
// guard (evaluator/scratchpad-write-guard.ts) redirects authored code here;
// `interlinked scratch init` makes that redirect real in any repo.
//
// Idempotent by construction: each piece (dir, README, .gitignore carve-out,
// .ignore search negation) is checked before it is written.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const README_PATH = ["scratch", "README.md"] as const;

const README_CONTENT = `# scratch/ — the sanctioned home for session & agent scripts

One-off scripts written during a session — analysis probes, migration
drivers, data munging — belong HERE, not in /tmp or the host session
scratchpad. A script that shapes real decisions deserves the same scrutiny
as the code it touches, and future sessions should be able to find it.

What this location gives you:

- **Gated**: content-quality, security, and lint/type diff-overlays apply —
  scratch code is first-class, not a workaround lane. Companion-test and
  coverage ratchets are exempt here (like scripts/): demanding tests for
  one-offs would push work back to ungoverned temp dirs.
- **Greppable**: gitignored (except this README) but re-included for search
  via the root .ignore negation, so rg/grep and the harness trigram index
  see it.
- **Durable**: survives the session; future agents can \`rg scratch/\` for
  prior art instead of re-deriving it.

Conventions:

- One subdirectory per effort, date-prefixed: \`scratch/2026-07-09-<slug>/\`.
- Keep artifacts small and text-based; large/binary outputs still belong in
  the host scratchpad (they are archived from there at session end).
- Anything that graduates to durable tooling moves to \`scripts/\` (committed)
  with the normal review bar.

Provisioned by \`interlinked scratch init\`.
`;

const GITIGNORE_MARKER = "scratch/*";
const GITIGNORE_BLOCK = `
# Sanctioned session/agent-script home (see scratch/README.md): local-only
# like the host scratchpad it replaces, but — unlike it — gated by the
# harness quality checks, rg-searchable, and durable across sessions.
scratch/*
!scratch/README.md
`;

const IGNORE_MARKER = "!scratch/";
const IGNORE_BLOCK = `
# scratch/ is gitignored (session/agent scripts) but must stay SEARCHABLE —
# rg/grep honor .ignore; this negation restores visibility.
!scratch/
!scratch/**
`;

export interface ScratchInitResult {
	created: string[];
	skipped: string[];
}

export interface ScratchStatusResult {
	dir: boolean;
	readme: boolean;
	gitignoreEntry: boolean;
	ignoreEntry: boolean;
}

/** True when `file` already contains `marker` as a whole line. */
function hasLine(file: string, marker: string): boolean {
	if (!existsSync(file)) return false;
	return readFileSync(file, "utf8")
		.split("\n")
		.some((line) => line.trim() === marker);
}

/** Append `block` to `file` (creating it if missing), normalizing the join
 *  so an existing file without a trailing newline stays well-formed. */
function appendBlock(file: string, block: string): void {
	if (!existsSync(file)) {
		writeFileSync(file, `${block.trimStart()}`);
		return;
	}
	const existing = readFileSync(file, "utf8");
	const joiner = existing.endsWith("\n") || existing === "" ? "" : "\n";
	appendFileSync(file, `${joiner}${block}`);
}

/** Provision scratch/ in `cwd`: dir + README + .gitignore carve-out +
 *  .ignore search negation. Idempotent; reports what was created vs skipped. */
export function initScratchDir(cwd: string): ScratchInitResult {
	const created: string[] = [];
	const skipped: string[] = [];

	const readmePath = join(cwd, ...README_PATH);
	if (existsSync(readmePath)) {
		skipped.push("scratch/README.md");
	} else {
		mkdirSync(join(cwd, "scratch"), { recursive: true });
		writeFileSync(readmePath, README_CONTENT);
		created.push("scratch/README.md");
	}

	const gitignorePath = join(cwd, ".gitignore");
	if (hasLine(gitignorePath, GITIGNORE_MARKER)) {
		skipped.push(".gitignore entries");
	} else {
		appendBlock(gitignorePath, GITIGNORE_BLOCK);
		created.push(".gitignore entries");
	}

	const ignorePath = join(cwd, ".ignore");
	if (hasLine(ignorePath, IGNORE_MARKER)) {
		skipped.push(".ignore entries");
	} else {
		appendBlock(ignorePath, IGNORE_BLOCK);
		created.push(".ignore entries");
	}

	return { created, skipped };
}

/** Presence report for the three provisioned pieces (plus the dir itself). */
export function scratchStatus(cwd: string): ScratchStatusResult {
	return {
		dir: existsSync(join(cwd, "scratch")),
		readme: existsSync(join(cwd, ...README_PATH)),
		gitignoreEntry: hasLine(join(cwd, ".gitignore"), GITIGNORE_MARKER),
		ignoreEntry: hasLine(join(cwd, ".ignore"), IGNORE_MARKER),
	};
}

/** CLI action for `interlinked scratch init`. */
export function scratchInitCommand(opts: { cwd?: string; json?: boolean }): void {
	const cwd = opts.cwd || process.cwd();
	const result = initScratchDir(cwd);
	if (opts.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	for (const piece of result.created) console.log(`created  ${piece}`);
	for (const piece of result.skipped) console.log(`exists   ${piece}`);
	if (result.created.length === 0) {
		console.log("scratch/ already fully provisioned.");
	} else {
		console.log("scratch/ ready — session/agent scripts belong there (see scratch/README.md).");
	}
}

/** CLI action for `interlinked scratch status`. */
export function scratchStatusCommand(opts: { cwd?: string; json?: boolean }): void {
	const cwd = opts.cwd || process.cwd();
	const status = scratchStatus(cwd);
	if (opts.json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	const mark = (present: boolean): string => (present ? "✓" : "✗");
	console.log(`${mark(status.dir)} scratch/`);
	console.log(`${mark(status.readme)} scratch/README.md`);
	console.log(`${mark(status.gitignoreEntry)} .gitignore carve-out`);
	console.log(`${mark(status.ignoreEntry)} .ignore search negation`);
	if (!(status.readme && status.gitignoreEntry && status.ignoreEntry)) {
		console.log("Run `interlinked scratch init` to provision the missing pieces.");
	}
}
