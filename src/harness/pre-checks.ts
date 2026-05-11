// ===========================================
// Pre-Checks — Additional PreToolUse safety checks
// ===========================================
// Pure functions called from evaluatePreToolUse(). Each returns
// { block, warning } or null if not applicable.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { SessionTrajectory } from "./types.js";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** Recency threshold: only warn about concurrent writes within the last 10 minutes. */
const CONCURRENT_EDIT_WINDOW_MS = 10 * SECONDS_PER_MINUTE * MS_PER_SECOND;

// ===========================================
// Protected PIDs — never allow killing these
// ===========================================

/** Collect PIDs that must never be killed: self, parent, harness, and ancestor chain. */
function getProtectedPids(): Set<number> {
	const pids = new Set<number>();

	// Current process (harness server)
	pids.add(process.pid);

	// Parent process (likely the shell or Claude Code node process)
	if (process.ppid) pids.add(process.ppid);

	// Walk up the parent chain to protect the entire Claude Code process tree.
	// Use a single ps call to get the full ancestor chain efficiently.
	try {
		const output = execSync("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		const pidToParent = new Map<number, number>();
		for (const line of output.split("\n")) {
			const match = line.trim().match(/^(\d+)\s+(\d+)$/);
			if (match) {
				pidToParent.set(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
			}
		}
		// Walk ancestors from our ppid
		let current = process.ppid;
		for (let i = 0; i < 10 && current > 1; i++) {
			pids.add(current);
			const parent = pidToParent.get(current);
			if (!parent || parent <= 1) break;
			current = parent;
		}
	} catch (e) {
		void e;
	}

	// Read harness PID file if it exists
	try {
		const pidFile = join(process.cwd(), ".interlinked", "harness.pid");
		if (existsSync(pidFile)) {
			const harnessPid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (!Number.isNaN(harnessPid)) pids.add(harnessPid);
		}
	} catch (e) {
		void e;
	}

	return pids;
}

// Cache protected PIDs (refreshed once per process lifetime — PIDs don't change)
let _protectedPids: Set<number> | null = null;
function protectedPids(): Set<number> {
	if (!_protectedPids) _protectedPids = getProtectedPids();
	return _protectedPids;
}

interface PreCheckResult {
	block?: string;
	warning?: string;
}

// ===========================================
// Check 0: Self-kill protection
// ===========================================
// Blocks `kill <PID>` when the PID is the harness, Claude Code, or any
// ancestor process in the session's process tree.

export function checkSelfKill(command: string): PreCheckResult | null {
	// Match "kill <PID>" (plain kill with a single numeric PID)
	const killMatch = command.match(/^\s*kill\s+(\d+)\s*$/);
	if (!killMatch) return null;

	const targetPid = Number.parseInt(killMatch[1], 10);
	if (Number.isNaN(targetPid)) return null;

	// Check 1: Is it in our known protected set (harness + ancestors)?
	const protected_ = protectedPids();
	if (protected_.has(targetPid)) {
		return {
			block: `PID ${targetPid} is the harness or an ancestor of the current session — killing it would terminate this session. Use a different approach to manage this process.`,
		};
	}

	// Check 2: Resolve the target PID's command. If it looks like a Claude
	// Code session OR a *non-orphan* interlinked harness, warn — these kills
	// might disrupt an active session in another shell. Orphan harness daemons
	// (no living parent except init=1) are explicitly allowed because Check 1
	// already protects the ones that matter (this session's harness + the
	// process tree's ancestors), and orphan reaping is a legitimate
	// maintenance operation we WANT to support without friction. The over-
	// broad earlier rule (`block` on any node+interlinked process) made
	// orphan cleanup impossible — see `commands/harness.ts:reapOrphanHarnesses`
	// which depends on this check NOT firing on stale daemons.
	try {
		const info = execSync(`ps -o ppid=,comm=,args= -p ${targetPid} 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 1000,
		}).trim();
		const ppidMatch = info.match(/^\s*(\d+)\s/);
		const targetPpid = ppidMatch ? Number.parseInt(ppidMatch[1] as string, 10) : 0;
		const lower = info.toLowerCase();
		const isClaudeOrInterlinked =
			(lower.includes("node") || lower.includes("bun") || lower.includes("deno")) &&
			(lower.includes("claude") ||
				lower.includes("interlinked") ||
				lower.includes("harness/server"));
		// Treat ppid==1 (or 0) as orphan — its parent shell exited; this is
		// a stale daemon, not a live session. Allow the kill silently.
		const isOrphan = targetPpid <= 1;
		if (isClaudeOrInterlinked && !isOrphan) {
			return {
				warning: `PID ${targetPid} appears to be a live Claude Code or Interlinked process in another session (${info.slice(0, 80).trim()}). Killing it will terminate that session — proceed only if intended.`,
			};
		}
	} catch (e) {
		void e;
	}

	return null;
}

// ===========================================
// Check 1: .env leak to git
// ===========================================
// Fires on Write/Edit to .env* files. Blocks if file is not gitignored
// and content contains secret-like patterns.

export function checkEnvLeakToGit(
	filePath: string,
	content: string | undefined,
	cwd: string,
): PreCheckResult | null {
	const base = basename(filePath);

	// Only check .env-like files
	if (!base.startsWith(".env") && !base.endsWith(".env")) return null;
	// Allow .env.example and .env.sample
	if (base.includes("example") || base.includes("sample") || base.includes("template")) {
		return null;
	}

	// Check if file is gitignored
	const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	try {
		execSync(`git check-ignore --quiet "${absPath}"`, {
			cwd,
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Exit 0 = file IS gitignored, safe
		return null;
	} catch (e) {
		void e;
	}

	// Check if content looks like it has secrets
	const text = content || "";
	const hasSecrets =
		/(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|AWS_|DATABASE_URL)\s*=\s*\S+/i.test(text);

	if (hasSecrets) {
		return {
			block: `Writing secrets to ${base} which is NOT in .gitignore — add it to .gitignore first, or use ${base}.example with placeholder values`,
		};
	}

	return {
		warning: `[interlinked:env-leak] ${base} is not in .gitignore — secrets in this file could be committed to version control`,
	};
}

// ===========================================
// Check 2: Stale branch detection
// ===========================================
// Warns if agent's branch is significantly behind main.
// Cached: only runs once per 5 minutes per session.

const staleBranchCache = new Map<string, { ts: number; result: PreCheckResult | null }>();
const STALE_BRANCH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_BRANCH_THRESHOLD = 50;

export function checkStaleBranch(cwd: string, sessionId: string): PreCheckResult | null {
	const cacheKey = `${sessionId}:${cwd}`;
	const cached = staleBranchCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < STALE_BRANCH_INTERVAL_MS) {
		return cached.result;
	}

	// Quick check: skip if not in a git repo (avoids slow subprocess for non-git dirs)
	if (!existsSync(join(cwd, ".git"))) {
		staleBranchCache.set(cacheKey, { ts: Date.now(), result: null });
		return null;
	}

	let result: PreCheckResult | null = null;
	try {
		// Determine main branch name
		const mainBranch = execSync(
			"git rev-parse --verify main 2>/dev/null && echo main || echo master",
			{
				cwd,
				timeout: 2000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		).trim();

		// Count commits behind
		const behindStr = execSync(`git rev-list --count HEAD..${mainBranch} 2>/dev/null`, {
			cwd,
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		const behind = Number.parseInt(behindStr, 10);
		if (!Number.isNaN(behind) && behind > STALE_BRANCH_THRESHOLD) {
			result = {
				warning: `[interlinked:stale-branch] Current branch is ${behind} commits behind ${mainBranch} — consider rebasing or merging`,
			};
		}
	} catch (e) {
		void e;
	}

	staleBranchCache.set(cacheKey, { ts: Date.now(), result });
	return result;
}

// ===========================================
// Check 3: Dirty working tree guard
// ===========================================
// Warns when about to run git checkout/switch/rebase with uncommitted changes.

export function checkDirtyWorkingTree(command: string, cwd: string): PreCheckResult | null {
	// Only check git commands that could discard changes
	if (!/\bgit\s+(checkout|switch|rebase|reset)\b/.test(command)) return null;

	try {
		const status = execSync("git status --porcelain 2>/dev/null", {
			cwd,
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		if (status.length > 0) {
			const changedCount = status.split("\n").length;
			return {
				warning: `[interlinked:dirty-worktree] ${changedCount} uncommitted change(s) — running this git command may discard work. Consider stashing first.`,
			};
		}
	} catch (e) {
		void e;
	}

	return null;
}

// ===========================================
// Check 4: Large file write prevention
// ===========================================
// Warns when about to write a file >50KB (likely generated/minified).

const LARGE_FILE_THRESHOLD = 50 * 1024; // 50KB

export function checkLargeFileWrite(content: string | undefined): PreCheckResult | null {
	if (!content) return null;

	const size = Buffer.byteLength(content, "utf-8");
	if (size > LARGE_FILE_THRESHOLD) {
		const sizeKB = Math.round(size / 1024);
		return {
			warning: `[interlinked:large-file] About to write ${sizeKB}KB — files this large are often generated or minified. Consider splitting into smaller modules.`,
		};
	}

	return null;
}

// ===========================================
// Check 5: Concurrent edit detection
// ===========================================
// Warns when another session has recently written to the same file.

export function checkConcurrentEdit(
	filePath: string,
	currentSessionId: string,
	allSessions: SessionTrajectory[],
): PreCheckResult | null {
	const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

	for (const session of allSessions) {
		if (session.session_id === currentSessionId) continue;
		if (!session.files_written.has(absPath)) continue;

		const writeTimeStr = session.file_write_times.get(absPath);
		if (!writeTimeStr) continue;

		// Only warn about recent writes (last 10 minutes)
		const writeTimeMs = new Date(writeTimeStr).getTime();
		if (Number.isNaN(writeTimeMs)) continue;
		const ageMs = Date.now() - writeTimeMs;
		if (ageMs > CONCURRENT_EDIT_WINDOW_MS) continue;

		const ageSec = Math.round(ageMs / MS_PER_SECOND);
		const otherAgent = session.agent_name || session.session_id.slice(0, 8);
		return {
			warning: `[interlinked:concurrent-edit] "${otherAgent}" wrote to this file ${ageSec}s ago — coordinate to avoid conflicts`,
		};
	}

	return null;
}

// ===========================================
// Check: Bash-routed code-file writes
// ===========================================
// Detects shell commands that write to a tracked source-file extension via
// redirection or inline interpreter calls. These bypass the content-quality
// gates that run on Write/Edit/MultiEdit (pre_block registry, biome and tsc
// diff-overlay). Returning a non-null result tells the caller to block with
// a message asking the agent to use the Write tool instead.

/** File extensions the harness's content-gate checks care about. */
const CODE_FILE_EXT_RE =
	/\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|swift|c|cc|cpp|cxx|h|hpp|hxx|rb|php|cs|scala|clj|sh|bash|zsh)$/i;

/** Supermodel `.graph.*` shards are owned by Supermodel's daemon —
 *  always treat them as protected regardless of the inner extension. */
const SHARD_FILE_RE = /\.graph(\.[a-zA-Z0-9]+)?$/i;

/** Returns true when the path is something the content-gates protect:
 *  either a tracked-source extension OR a Supermodel shard. */
function isProtectedTarget(target: string): boolean {
	return SHARD_FILE_RE.test(target) || CODE_FILE_EXT_RE.test(target);
}

/**
 * Offset-preserving blank of quoted string contents so we don't match redirect
 * operators INSIDE argument strings (`echo "x > y"` is not a redirect). Pads
 * interiors with spaces of the same length so downstream match indices remain
 * valid on the original `cmd`.
 */
function stripQuotedStrings(cmd: string): string {
	return cmd
		.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => `"${" ".repeat(inner.length)}"`)
		.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => `'${" ".repeat(inner.length)}'`);
}

/**
 * Parse a redirect target from a command fragment starting at the `>` or
 * `>>` operator. Returns the target path and the operator mechanism name,
 * or null if it can't be resolved. Handles single-quoted, double-quoted,
 * and unquoted filenames.
 */
function parseRedirectTarget(
	cmd: string,
	operatorIdx: number,
	operator: string,
): { target: string; mechanism: string } | null {
	const afterOp = cmd.slice(operatorIdx + operator.length).trim();
	// Match: "path", 'path', or bare path until whitespace/operator
	const quoted = afterOp.match(/^(["'])([^"']+)\1/);
	if (quoted) return { target: quoted[2], mechanism: `shell redirect (${operator})` };
	const bare = afterOp.match(/^(\S+)/);
	if (bare) return { target: bare[1], mechanism: `shell redirect (${operator})` };
	return null;
}

/**
 * Commands that route THROUGH the content gate (rather than around it).
 * `interlinked write` runs the same `gateProposedContent` pipeline used by
 * the Edit/Write hooks, so we allow it unconditionally here — the command
 * does its own gating and blocking it would double-gate (and prevent the
 * legitimate multi-site-atomic use case described in the design doc).
 */
const CONTENT_GATE_ROUTED_RE = /\binterlinked\s+write\b/;

export function detectBashCodeFileWrite(cmd: string): { target: string; mechanism: string } | null {
	if (!cmd) return null;

	// Normalize: strip CR/LF, collapse whitespace (but keep order)
	const normalized = cmd.replace(/[\r\n]+/g, " ");

	// Fast path: `interlinked write` self-gates. Let it through.
	if (CONTENT_GATE_ROUTED_RE.test(normalized)) return null;

	// 1. Shell redirection operators: `> file` and `>> file`.
	//    Scan for `>` not inside a quoted string. Ignore `2>`, `&>`, `>&` forms
	//    (those are fd redirection, not file writes).
	const redirRe = /(?<![0-9&])(>>?)(?![&])/g;
	const stripped = stripQuotedStrings(normalized);
	for (const m of stripped.matchAll(redirRe)) {
		const op = m[1];
		const idx = m.index ?? 0;
		const hit = parseRedirectTarget(normalized, idx, op);
		if (!hit) continue;
		if (!CODE_FILE_EXT_RE.test(hit.target)) continue;
		return hit;
	}

	// 2. tee: `... | tee <file>` (also `tee -a`, `tee --append`).
	const teeMatch = normalized.match(
		/\btee\s+(?:-a\s+|--append\s+)?(?:--\s+)?(['"]?)([^\s'"|&]+)\1/,
	);
	if (teeMatch) {
		const target = teeMatch[2];
		if (CODE_FILE_EXT_RE.test(target)) {
			return { target, mechanism: "tee" };
		}
	}

	// 3. sed -i (in-place edit).
	const sedInPlace = detectSedInPlaceEdit(normalized);
	if (sedInPlace) {
		return sedInPlace;
	}

	// 4. Inline interpreter calls that call writeFileSync / open+write.
	//    node -e "..." / python -c "..." / python3 -c "..." / ruby -e "..."
	const inlineInterp = normalized.match(
		/\b(node|python3?|ruby|perl|deno|bun)\s+(?:--[a-zA-Z0-9=_-]+\s+)*-[ec]\s+(["'])([\s\S]*?)\2/,
	);
	if (inlineInterp) {
		const script = inlineInterp[3];
		// Look for `writeFileSync('foo.ts', ...)` / `open('foo.ts','w')`
		const writeArg =
			script.match(/writeFile(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/) ??
			script.match(/open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][aw]/) ??
			script.match(/fs\.writeFile\s*\(\s*['"]([^'"]+)['"]/);
		if (writeArg && CODE_FILE_EXT_RE.test(writeArg[1])) {
			return {
				target: writeArg[1],
				mechanism: `inline ${inlineInterp[1]} -${inlineInterp[0].includes("-c ") ? "c" : "e"} script`,
			};
		}
	}

	// 5. File-moving verbs that land bytes in a target path:
	//    cp / mv / ln (hard or symlink) / install / rsync / scp.
	//    All follow the shape `<verb> [flags...] <src> <dst>` — destination
	//    is the LAST positional argument. Detect via segment-walk so the
	//    flag count doesn't tilt the regex.
	const fileMoveHit = detectFileMoveToProtected(normalized);
	if (fileMoveHit) return fileMoveHit;

	// 6. dd if=<src> of=<dst> — block-level copy. Destination is in the
	//    `of=` arg, not the last positional.
	const ddHit = detectDdWriteToProtected(normalized);
	if (ddHit) return ddHit;

	return null;
}

/** Verbs whose effect is "place bytes at <last positional arg>". Every
 *  one of these bypasses Write/Edit if the destination is a code file or
 *  a Supermodel shard. */
const FILE_MOVE_VERBS = new Set(["cp", "mv", "ln", "install", "rsync", "scp"]);

function detectFileMoveToProtected(
	cmd: string,
): { target: string; mechanism: string } | null {
	for (const segment of splitCommandSegments(cmd)) {
		const args = splitShellWordsLoose(segment).map(stripOuterQuotes);
		if (args.length < 2) continue;
		const verb = args[0].split("/").pop() ?? args[0];
		if (!FILE_MOVE_VERBS.has(verb)) continue;
		// Skip any subsequent flag-token (starts with `-`), find the last
		// positional argument. `cp` and friends always put the destination
		// last when called with N positionals.
		const positionals: string[] = [];
		for (let i = 1; i < args.length; i++) {
			const arg = args[i];
			if (arg.startsWith("-")) {
				// Some flags take a value in two-token form (`-m 644`,
				// `--mode 644`, `-t DIR`). Skip the next token only for those.
				// `-T` is `--no-target-directory` — a boolean; do NOT skip,
				// or the destination gets parsed away and `cp -T /tmp/x src/foo.ts`
				// slips past the guard. Long forms with `=` (e.g. `--mode=644`)
				// are one token and handled by the no-skip path.
				const flagTakesArg =
					arg === "-m" ||
					arg === "--mode" ||
					arg === "-t" ||
					arg === "--target-directory" ||
					arg === "-S" ||
					arg === "--suffix";
				if (flagTakesArg && i + 1 < args.length && !args[i + 1].startsWith("-")) {
					i++;
				}
				continue;
			}
			positionals.push(arg);
		}
		if (positionals.length < 2) continue;
		const target = positionals[positionals.length - 1];
		if (isProtectedTarget(target)) {
			return { target, mechanism: `${verb} (write to tracked file)` };
		}
	}
	return null;
}

function detectDdWriteToProtected(
	cmd: string,
): { target: string; mechanism: string } | null {
	for (const segment of splitCommandSegments(cmd)) {
		if (!/\bdd\b/.test(segment)) continue;
		const ofMatch = segment.match(/\bof=(\S+)/);
		if (!ofMatch) continue;
		const target = stripOuterQuotes(ofMatch[1]);
		if (isProtectedTarget(target)) {
			return { target, mechanism: "dd (block-level write)" };
		}
	}
	return null;
}

function detectSedInPlaceEdit(cmd: string): { target: string; mechanism: string } | null {
	for (const segment of splitCommandSegments(cmd)) {
		const args = splitShellWordsLoose(segment);
		const sedIdx = args.findIndex((arg) => /(?:^|\/)sed$/.test(stripOuterQuotes(arg)));
		if (sedIdx < 0) continue;

		const sedArgs = args.slice(sedIdx + 1).map(stripOuterQuotes);
		if (!sedArgs.some(isSedInPlaceOption)) continue;

		for (let i = sedArgs.length - 1; i >= 0; i--) {
			const arg = sedArgs[i];
			if (arg.startsWith("-")) continue;
			if (CODE_FILE_EXT_RE.test(arg)) {
				return { target: arg, mechanism: "sed -i (in-place)" };
			}
		}
	}
	return null;
}

function isSedInPlaceOption(arg: string): boolean {
	return arg === "-i" || /^-[A-Za-z]*i(?:$|[^A-Za-z].*)/.test(arg);
}

function splitCommandSegments(cmd: string): string[] {
	return cmd.split(/\s+(?:&&|\|\||;|\|)\s+/).filter(Boolean);
}

function splitShellWordsLoose(segment: string): string[] {
	// Flatten nested-quantifier alternation: `(?:[^"\\]|\\[\s\S])*` advances
	// one character per iteration with no backtracking, avoiding the
	// catastrophic-backtracking shape of `[^"\\]*(?:\\.[^"\\]*)*`.
	const words: string[] = [];
	const re = /"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|(\S+)/g;
	for (const match of segment.matchAll(re)) {
		words.push(match[0]);
	}
	return words;
}

function stripOuterQuotes(value: string): string {
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("\"") && value.endsWith("\""))
	) {
		return value.slice(1, -1);
	}
	return value;
}
