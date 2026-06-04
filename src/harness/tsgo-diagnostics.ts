// ===========================================
// tsgo diagnostics + helpers — pure(-ish) tail extracted from tsgo-runner.ts
// ===========================================
// Behavior-preserving split: this module holds the diagnostic-parsing state
// machine plus the small filesystem / path / cache-key helpers that
// `createTsgoRunner` + `WatchProcess` (in `tsgo-runner.ts`) depend on. Nothing
// here changed in logic during the split — `tsgo-runner.ts` imports these back
// and re-exports the public `parseTsgoOutput`. Keep imports `.js`-specified
// (ESM/NodeNext) and avoid importing from `tsgo-runner.ts` to stay acyclic.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TsgoDiagnostic } from "./daemon-protocol.js";

// -----------------------------------------------------------------------------
// Pass-marker regexes + ANSI / timestamp stripping
// -----------------------------------------------------------------------------

/**
 * Opens a compilation pass — matches BOTH tsgo watch output formats:
 *   "build" format:   `build starting at <time>`
 *   "classic" format: `Starting compilation in watch mode...` and
 *                      `File change detected. Starting incremental compilation...`
 * (the leading `HH:MM:SS AM/PM - ` timestamp is stripped before matching).
 */
export const PASS_START_RE =
	/^(?:build starting at\b|Starting compilation in watch mode|File change detected)/i;
/**
 * Closes a compilation pass — matches BOTH formats:
 *   "build" format:   `build finished in <n>s`
 *   "classic" format: `Found <n> error(s). Watching for file changes.`
 */
export const PASS_COMPLETE_RE = /^(?:build finished in\b|Found \d+ errors?\b)/i;
/**
 * ANSI escape sequences (incl. tsgo's screen-clear, which arrives as the bytes
 * `<ESC>[2J<ESC>[3J<ESC>[H`). The leading `\x1b` (ESC) MUST be in the pattern —
 * matching only `[…]` strips the CSI body but leaves bare ESC bytes that then
 * defeat the `build starting` / `Starting compilation` pass-start match.
 */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
/** Leading `HH:MM:SS AM/PM - ` timestamp prefix on classic-format lines. */
const WATCH_TIMESTAMP_RE = /^\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s*-\s*/i;

/** Strip all ANSI escape sequences from a chunk of watch output. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "");
}

/** Strip a leading classic-format `HH:MM:SS AM/PM - ` timestamp, if present. */
export function stripWatchTimestamp(line: string): string {
	return line.replace(WATCH_TIMESTAMP_RE, "");
}

/**
 * Wall clock in ms. Wrapped so the dependency on the global is named in one
 * place; elapsed_ms / pass-timestamp logic is timing telemetry, not behavior
 * the tests assert on, so a single indirection point is enough.
 */
export function nowMs(): number {
	return Date.now();
}

/** True for files the warm `tsgo --watch` child can serve (.ts / .tsx). */
export function isTsFile(path: string): boolean {
	return /\.tsx?$/.test(path);
}

export function locateTsgo(): string | null {
	const envPath = process.env.INTERLINKED_TSGO;
	if (envPath && existsSync(envPath)) return envPath;
	// We avoid child process discovery here (which would need spawn) and
	// rely on the caller having `tsgo` on PATH. Spawns shell out with the
	// shell disabled — Node resolves via $PATH directly.
	return "tsgo";
}

/**
 * Walk up from `path`'s directory looking for a `tsconfig.json` (max 8
 * levels). Returns the containing directory, or null for a standalone file
 * with no project — those go straight to the cold one-shot path.
 */
export function findTsconfigDir(path: string): string | null {
	let dir = dirname(resolve(path));
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "tsconfig.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Stable, per-project `.tsbuildinfo` path under the OS temp dir. Keyed by a
 * hash of the project root + a tag so the warm watcher and the cold one-shot
 * don't clobber each other's incremental state, and the file survives across
 * daemon restarts (so even a cold respawn is warmer than a clean build).
 */
export function buildInfoPath(projectRoot: string, tag: "watch" | "cold"): string {
	// Non-security cache key: this hash only derives a stable filename slug
	// from the project root path. Nothing in the security model depends on it.
	const h = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
	return join(tmpdir(), `interlinked-tsgo-${tag}-${h}.tsbuildinfo`);
}

export function computeCacheKey(path: string): string {
	let mtime = 0;
	let size = 0;
	try {
		const s = statSync(path);
		mtime = s.mtimeMs;
		size = s.size;
	} catch (_err) {
		mtime = 0;
	}
	// Non-security cache key: hash over (path|mtime|size) is an in-memory
	// result-cache key only. No collision-resistance requirement.
	const h = createHash("sha256");
	h.update(path);
	h.update("|");
	h.update(String(mtime));
	h.update("|");
	h.update(String(size));
	return h.digest("hex");
}

export function readFileSyncSafe(path: string): string | null {
	let out: string | null = null;
	try {
		out = readFileSync(path, "utf-8");
	} catch (_err) {
		out = null;
	}
	return out;
}

/**
 * Keep only the diagnostics that belong to `targetPath`. The watch child
 * reports diagnostics for the whole project; a single-file `checkFile()` must
 * narrow to the requested file. tsgo emits paths relative to its cwd (the
 * project root), so we compare against both the relative and the absolute
 * form. Diagnostics with an empty file field (project-level) are dropped from
 * a single-file result.
 */
export function filterDiagnosticsForFile(
	diagnostics: readonly TsgoDiagnostic[],
	targetPath: string,
	projectRoot: string,
): TsgoDiagnostic[] {
	const abs = resolve(targetPath);
	const out: TsgoDiagnostic[] = [];
	for (const d of diagnostics) {
		if (!d.file) continue;
		const diagAbs = resolve(projectRoot, d.file);
		if (diagAbs === abs || resolve(d.file) === abs) {
			out.push(d);
		}
	}
	return out;
}

/**
 * Standalone compiler options used when the cold path type-checks a single
 * file with no tsconfig. Mirrors `check-engine/tool-runners/tsc.ts` so a
 * project-less file (hook script, config) still gets meaningful checking.
 */
const STANDALONE_TSGO_OPTS: readonly string[] = [
	"--esModuleInterop",
	"--module",
	"nodenext",
	"--moduleResolution",
	"nodenext",
	"--target",
	"es2022",
	"--skipLibCheck",
];

/**
 * Cold one-shot fallback. Used when the warm watch child is unavailable (not
 * yet spawned, crashed, tsgo missing) or when checkFile() raced tsgo's
 * FS-watch debounce. Never throws; resolves [] on any failure or timeout.
 *
 * Two modes, matching `tsc.ts`'s runner:
 *  * tsconfig found → type-check the WHOLE PROJECT (`cwd` = project root, no
 *    file arg) and filter diagnostics to `path`. This keeps cold semantics
 *    identical to the warm watch (same project context) and avoids tsgo's
 *    TS5112 — passing a file on the command line while a tsconfig is present
 *    is an error in tsgo.
 *  * no tsconfig → standalone-check the single file with `--ignoreConfig` +
 *    STANDALONE_TSGO_OPTS.
 * Both modes add `--incremental` + a stable `--tsBuildInfoFile`, so even this
 * fallback is warmer than a clean build across repeated calls.
 */
export async function runTsgoOneShot(
	executable: string,
	path: string,
	extraArgs: readonly string[],
	timeoutMs: number,
): Promise<TsgoDiagnostic[]> {
	const projectRoot = findTsconfigDir(path);
	const args: string[] = [...extraArgs];
	let spawnCwd: string | undefined;
	if (projectRoot) {
		// Whole-project check: cwd at the root, no file arg (TS5112-safe).
		args.push("--incremental", "--tsBuildInfoFile", buildInfoPath(projectRoot, "cold"));
		spawnCwd = projectRoot;
	} else {
		// Standalone single-file check — no project context to load.
		args.push("--ignoreConfig", ...STANDALONE_TSGO_OPTS, path);
	}

	const raw = await spawnCollect(executable, args, spawnCwd, timeoutMs);
	if (raw === null) return []; // spawn failed / timed out — degrade
	const parsed = parseTsgoOutput(raw, path);
	// Whole-project mode reports diagnostics for every file; narrow to `path`.
	return projectRoot ? filterDiagnosticsForFile(parsed, path, projectRoot) : parsed;
}

/**
 * Spawn `executable args` (optionally in `cwd`), collect stdout+stderr, and
 * resolve the combined text. Resolves null on spawn error or timeout so the
 * caller degrades gracefully. Never throws.
 */
export function spawnCollect(
	executable: string,
	args: readonly string[],
	cwd: string | undefined,
	timeoutMs: number,
): Promise<string | null> {
	return new Promise((resolveRun) => {
		let child: ChildProcess;
		try {
			child = spawn(executable, args, {
				stdio: ["ignore", "pipe", "pipe"],
				...(cwd ? { cwd } : {}),
			});
		} catch (_err) {
			resolveRun(null);
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finalize = (out: string | null): void => {
			if (settled) return;
			settled = true;
			resolveRun(out);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finalize(null);
		}, timeoutMs);
		child.stdout?.on("data", (b: Buffer) => {
			stdout += b.toString("utf-8");
		});
		child.stderr?.on("data", (b: Buffer) => {
			stderr += b.toString("utf-8");
		});
		child.on("error", () => {
			clearTimeout(timer);
			finalize(null);
		});
		child.on("close", () => {
			clearTimeout(timer);
			finalize(`${stdout}\n${stderr}`);
		});
	});
}

/** Parse tsgo/tsc diagnostic output. The compiler writes lines like
 *   `src/foo.ts(3,7): error TS2322: ...`
 *  and `src/foo.ts:3:7 - error TS2322: ...` in different modes. */
export function parseTsgoOutput(output: string, defaultFile: string): TsgoDiagnostic[] {
	const lines = output.split(/\r?\n/);
	const out: TsgoDiagnostic[] = [];
	for (const line of lines) {
		const parsed = parseDiagnosticLine(line, defaultFile);
		if (parsed) out.push(parsed);
	}
	return out;
}

export function parseDiagnosticLine(line: string, defaultFile: string): TsgoDiagnostic | null {
	// Form 1: file(line,col): severity TSxxxx: message
	const m1 = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+TS(\d+):\s+(.*)$/.exec(line);
	if (m1) {
		return {
			file: m1[1],
			line: Number.parseInt(m1[2], 10),
			column: Number.parseInt(m1[3], 10),
			severity: m1[4] as "error" | "warning" | "info",
			code: Number.parseInt(m1[5], 10),
			message: m1[6],
		};
	}
	// Form 2: file:line:col - severity TSxxxx: message
	const m2 = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning|info)\s+TS(\d+):\s+(.*)$/.exec(line);
	if (m2) {
		return {
			file: m2[1],
			line: Number.parseInt(m2[2], 10),
			column: Number.parseInt(m2[3], 10),
			severity: m2[4] as "error" | "warning" | "info",
			code: Number.parseInt(m2[5], 10),
			message: m2[6],
		};
	}
	// Fall-through: line has no structured diagnostic — skip. We use the
	// defaultFile argument only for diagnostics with no file portion.
	if (line.trim().startsWith("error TS") || line.trim().startsWith("warning TS")) {
		const m3 = /^(error|warning|info)\s+TS(\d+):\s+(.*)$/.exec(line.trim());
		if (m3) {
			return {
				file: defaultFile,
				line: 0,
				column: 0,
				severity: m3[1] as "error" | "warning" | "info",
				code: Number.parseInt(m3[2], 10),
				message: m3[3],
			};
		}
	}
	return null;
}
