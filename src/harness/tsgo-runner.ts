// ===========================================
// tsgo runner — warm `tsgo --watch` daemon + cold one-shot fallback
// ===========================================
// Target architecture: docs/design/free-cli-architecture.md §5 and
// docs/design/three-product-architecture.md — a persistent `tsgo --watch`
// child holds the project's type graph in memory so single-file checks drop
// toward ~5–50ms warm instead of ~200–800ms cold.
//
// ---------------------------------------------------------------------------
// STEP 1 findings — empirically observed `tsgo --watch` behavior
// (tsgo == @typescript/native-preview 7.0.0-dev; verified May 2026):
//
//  * `tsgo --watch --noEmit --pretty false` writes BOTH the first compile and
//    every subsequent recompile to STDOUT (stderr stays empty), plain text,
//    no ANSI. tsgo has NO LSP / server mode — `--watch` is the only warm path.
//  * Each compilation pass is bracketed by two marker lines:
//        build starting at <H:MM:SS AM/PM>
//        <zero or more diagnostic lines>
//        build finished in <N>s
//  * Diagnostic lines use Form 1: `file(line,col): error TSxxxx: message` —
//    exactly what `parseTsgoOutput` already parses. A clean pass is a
//    `build starting` line immediately followed by `build finished`.
//  * tsgo watches the filesystem itself: when a watched file's mtime changes,
//    it auto-starts a new full pass. The harness Edit/Write tool writes the
//    file to disk BEFORE checkFile() is ever called, so a recompile fires on
//    its own — the runner does not have to drive it.
//  * The compile itself is sub-millisecond once warm (`build finished in
//    0.000s`), BUT tsgo's change-detection has a fixed ~1s debounce before it
//    begins a pass. `--watchFile usefsevents` and `--watchInterval` do NOT
//    shrink that ~1s floor.
//
// Consequence for the drive model: "edit file then wait for tsgo to notice"
// would be ~1s — slower than the cold path. So checkFile() instead reads the
// LATEST COMPLETED PASS buffer the watch child already holds. By the time a
// checkFile() RPC arrives (the agent has done other work since the Edit), the
// ~1s-debounced recompile has normally already finished, so the read is
// ~1–5ms. The only slow case is racing tsgo's watcher immediately after an
// edit; that is covered by a bounded wait for the next `build finished` and,
// failing that, a cold one-shot fallback.
//
// Current consumption: `tsgo-runner.ts` is consumed ONLY by
// `daemon-dispatcher.ts` via the `tsgo.check_file` / `tsgo.simulate_edit`
// RPCs. The PostToolUse `typescript` quality check does NOT route through
// this module — it flows through `quality-checks.ts` →
// `check-engine/tool-runners/tsc.ts` (a separate `spawnSync` path). Routing
// the PostToolUse check through the warm runner would require editing
// `quality-checks.ts` / `check-engine/`, so it is left as a follow-up.
// ---------------------------------------------------------------------------
//
// The runner never throws and never hangs: every failure path (tsgo missing,
// child crash, spawn error, parse failure, warm-wait timeout) degrades to the
// cold one-shot or to an empty diagnostics list. The daemon must never crash
// because of tsgo.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TsgoDiagnostic } from "./daemon-protocol.js";
import {
	buildInfoPath,
	computeCacheKey,
	filterDiagnosticsForFile,
	findTsconfigDir,
	isTsFile,
	locateTsgo,
	nowMs,
	PASS_COMPLETE_RE,
	PASS_START_RE,
	parseDiagnosticLine,
	readFileSyncSafe,
	runTsgoOneShot,
	stripAnsi,
	stripWatchTimestamp,
} from "./tsgo-diagnostics.js";

// Public re-export: `parseTsgoOutput` (and the helper cluster it lives among)
// moved to `tsgo-diagnostics.ts` in a behavior-preserving split. Consumers that
// import `parseTsgoOutput` from `tsgo-runner.js` keep working unchanged.
export { parseTsgoOutput } from "./tsgo-diagnostics.js";

/** Default per-call timeout for the cold one-shot `tsgo` invocation (ms). */
const DEFAULT_COLD_TIMEOUT_MS = 5000;
/** Default cap on (path, mtime, size)-keyed result-cache entries. */
const DEFAULT_MAX_CACHE_ENTRIES = 512;

export interface TsgoRunnerOptions {
	/** Override the executable lookup. Defaults to the first tsgo binary on $PATH. */
	executable?: string;
	/** Extra args passed to every invocation. */
	extraArgs?: readonly string[];
	/** Per-call timeout. Defaults to DEFAULT_COLD_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Cap cache entries. Defaults to DEFAULT_MAX_CACHE_ENTRIES. */
	maxCacheEntries?: number;
	/**
	 * Idle window after which the warm `tsgo --watch` child is killed. The next
	 * TS check lazily respawns it. Default: 10 minutes (the daemon's own
	 * idle_shutdown_ms is 15 minutes — the watch child evicts sooner so a long
	 * non-TS stretch inside a live session reclaims the process).
	 */
	watchIdleMs?: number;
	/**
	 * Disable the warm `tsgo --watch` child entirely; every check uses the cold
	 * one-shot path. Used by tests that want to exercise the fallback.
	 */
	disableWatch?: boolean;
}

/** Warm-process lifecycle state, surfaced via `stats()`. */
export type WatchProcessState =
	| "not-started" // lazy: no TS check has happened yet
	| "running" // a `tsgo --watch` child is alive
	| "idle-evicted" // killed after the idle window; respawns on next use
	| "crashed" // exited unexpectedly; respawns on next use
	| "disabled" // warm path turned off (option / tsgo unavailable)
	| "unavailable"; // tsgo binary not resolvable

/** WatchProcessState literals, named so conditionals read as intent. */
const WATCH_RUNNING: WatchProcessState = "running";
const WATCH_CRASHED: WatchProcessState = "crashed";
const WATCH_IDLE_EVICTED: WatchProcessState = "idle-evicted";

export interface TsgoRunner {
	available(): boolean;
	checkFile(
		path: string,
	): Promise<{ diagnostics: TsgoDiagnostic[]; cached: boolean; elapsed_ms: number }>;
	simulateEdit(
		path: string,
		oldString: string,
		newString: string,
	): Promise<{ new_diagnostics: TsgoDiagnostic[]; elapsed_ms: number }>;
	invalidate(path: string): void;
	/**
	 * `cache_size` / `available` are unchanged for back-compat. `watch_process`
	 * is an additive optional field reporting the warm child's lifecycle state.
	 */
	stats(): { cache_size: number; available: boolean; watch_process?: WatchProcessState };
	/**
	 * Release the warm `tsgo --watch` child (test/shutdown hook). Idempotent.
	 * The daemon never has to call this — the runner registers process-exit
	 * handlers that kill the child — but tests use it for determinism.
	 *
	 * Optional so existing `TsgoRunner` stubs (daemon-dispatcher / session-
	 * daemon / hook-entry tests) stay assignable without change — the real
	 * `createTsgoRunner()` always provides it.
	 */
	dispose?(): void;
}

interface CacheEntry {
	key: string;
	diagnostics: TsgoDiagnostic[];
}

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

/** Default idle window before the warm `tsgo --watch` child is evicted. */
const DEFAULT_WATCH_IDLE_MS = 10 * 60 * 1000;
/**
 * Upper bound on how long checkFile() waits for the watch child to finish a
 * recompile of a file that is newer on disk than the last completed pass
 * (i.e. we beat tsgo's ~1s FS-watch debounce). On timeout we fall back to the
 * cold one-shot. 2s comfortably clears the observed ~1s debounce + compile.
 */
const WATCH_FRESH_WAIT_MS = 2000;
/** How often the fresh-wait loop re-checks for a completed pass. */
const WATCH_POLL_INTERVAL_MS = 15;
/** Time budget for the watch child's FIRST pass before we give up on it. */
const WATCH_INITIAL_PASS_MS = 8000;

export function createTsgoRunner(opts: TsgoRunnerOptions = {}): TsgoRunner {
	const executable = opts.executable ?? locateTsgo();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COLD_TIMEOUT_MS;
	const maxEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
	const extraArgs: readonly string[] = opts.extraArgs ?? ["--noEmit"];
	const watchIdleMs = opts.watchIdleMs ?? DEFAULT_WATCH_IDLE_MS;
	const watchEnabled = !opts.disableWatch;
	const cache = new Map<string, CacheEntry>();
	const isAvailable = executable !== null;

	// One warm `tsgo --watch` child per discovered project root. Lazy: nothing
	// is spawned at createTsgoRunner() time — a codebase with no TypeScript
	// never triggers a TS check, so it never pays any tsgo cost.
	const watchers = new Map<string, WatchProcess>();
	const lifecycle = { disposed: false };

	function cachePut(path: string, entry: CacheEntry): void {
		if (cache.size >= maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		// In-memory result cache; bounded by maxEntries with FIFO eviction
		// above, so no unbounded growth (this is not a Redis key).
		cache.set(path, entry);
	}

	/**
	 * Lazily obtain (or respawn) the warm watch child that owns `path`'s
	 * project. Returns null when the warm path is unavailable for any reason —
	 * callers then use the cold one-shot. Never throws.
	 */
	function watcherFor(path: string): WatchProcess | null {
		if (!watchEnabled || !isAvailable || lifecycle.disposed) return null;
		const root = findTsconfigDir(path);
		if (root === null) return null; // standalone file — cold path handles it
		let w = watchers.get(root);
		if (w && w.isUsable()) {
			w.touchIdle();
			return w;
		}
		// No watcher yet, or the previous one crashed / was idle-evicted.
		if (w) w.kill();
		w = new WatchProcess(executable as string, root, watchIdleMs);
		watchers.set(root, w);
		w.start();
		return w;
	}

	async function check(path: string): Promise<{
		diagnostics: TsgoDiagnostic[];
		cached: boolean;
		elapsed_ms: number;
	}> {
		if (!isAvailable) return { diagnostics: [], cached: false, elapsed_ms: 0 };
		if (!existsSync(path)) return { diagnostics: [], cached: false, elapsed_ms: 0 };

		const key = computeCacheKey(path);
		const cached = cache.get(path) ?? null;
		if (cached && cached.key === key) {
			return { diagnostics: cached.diagnostics, cached: true, elapsed_ms: 0 };
		}

		const started = nowMs();
		// Warm path: read the watch child's latest completed pass. Falls back
		// to the cold one-shot when the warm child is unavailable / raced.
		const diagnostics = await checkViaWarmOrCold(path);
		const elapsed_ms = nowMs() - started;
		cachePut(path, { key, diagnostics });
		return { diagnostics, cached: false, elapsed_ms };
	}

	/** Warm-then-cold dispatch for a single file's diagnostics. */
	async function checkViaWarmOrCold(path: string): Promise<TsgoDiagnostic[]> {
		if (isTsFile(path)) {
			const watcher = watcherFor(path);
			if (watcher) {
				const warm = await watcher.diagnosticsForFile(path);
				if (warm !== null) return warm;
			}
		}
		// Cold fallback: warm child unavailable / not yet spawned / timed out.
		return runTsgoOneShot(executable as string, path, extraArgs, timeoutMs);
	}

	async function simulate(
		path: string,
		oldString: string,
		newString: string,
	): Promise<{ new_diagnostics: TsgoDiagnostic[]; elapsed_ms: number }> {
		if (!isAvailable) return { new_diagnostics: [], elapsed_ms: 0 };
		if (!existsSync(path)) return { new_diagnostics: [], elapsed_ms: 0 };

		const started = nowMs();
		const original = readFileSyncSafe(path);
		if (original === null) return { new_diagnostics: [], elapsed_ms: 0 };
		if (oldString && !original.includes(oldString)) {
			// Patch would fail anyway; no simulated diagnostics.
			return { new_diagnostics: [], elapsed_ms: nowMs() - started };
		}
		const patched = oldString
			? original.replace(oldString, newString)
			: original + (newString ?? "");

		// simulate_edit type-checks a transient copy of the patched file. We do
		// NOT route this through the warm `tsgo --watch` child: the watch graph
		// only sees files on disk, and writing the patch into the live tree
		// would corrupt the agent's working copy. A one-shot on the temp file
		// is correct here. It still benefits from --incremental warming (see
		// runTsgoOneShot). Touching the warm watcher keeps its idle timer fresh
		// so an in-flight simulate doesn't let the child get evicted.
		if (isTsFile(path)) {
			const w = watcherFor(path);
			if (w) w.touchIdle();
		}

		const dir = mkdtempSync(join(tmpdir(), "interlinked-simedit-"));
		const suffix = path.match(/\.[A-Za-z0-9]+$/)?.[0] ?? ".ts";
		const tmpFile = join(dir, `sim${suffix}`);
		writeFileSync(tmpFile, patched);
		const diagnostics = await runTsgoOneShot(executable as string, tmpFile, extraArgs, timeoutMs);
		const elapsed_ms = nowMs() - started;
		// We do not diff against baseline here because the baseline check is a
		// separate `tsgo.check_file` call; the callers in the daemon do the
		// diff to surface only the *new* diagnostics. This keeps the runner
		// responsibilities narrow.
		return { new_diagnostics: diagnostics, elapsed_ms };
	}

	function invalidate(path: string): void {
		cache.delete(path);
	}

	function watchProcessState(): WatchProcessState {
		if (!isAvailable) return "unavailable";
		if (!watchEnabled) return "disabled";
		if (watchers.size === 0) return "not-started";
		// Report the most "interesting" state across all project watchers:
		// running wins (something is warm); else crashed; else idle-evicted.
		let sawCrashed = false;
		let sawEvicted = false;
		for (const w of watchers.values()) {
			const s = w.state();
			if (s === WATCH_RUNNING) return WATCH_RUNNING;
			if (s === WATCH_CRASHED) sawCrashed = true;
			if (s === WATCH_IDLE_EVICTED) sawEvicted = true;
		}
		if (sawCrashed) return WATCH_CRASHED;
		if (sawEvicted) return WATCH_IDLE_EVICTED;
		return "not-started";
	}

	function stats(): {
		cache_size: number;
		available: boolean;
		watch_process?: WatchProcessState;
	} {
		return {
			cache_size: cache.size,
			available: isAvailable,
			watch_process: watchProcessState(),
		};
	}

	function dispose(): void {
		lifecycle.disposed = true;
		for (const w of watchers.values()) w.kill();
		watchers.clear();
		process.removeListener("exit", onExit);
		process.removeListener("SIGTERM", onExit);
		process.removeListener("SIGINT", onExit);
	}

	// Kill the warm child(ren) when the daemon process exits. This keeps the
	// runner self-managing — server.ts needs no shutdown wiring. `exit` covers
	// the graceful daemon shutdown path; the signal handlers cover SIGTERM /
	// SIGINT. Handlers are best-effort and never throw.
	const onExit = (): void => {
		try {
			for (const w of watchers.values()) w.kill();
		} catch (_err) {
			void 0; // intentional: best-effort cleanup must never throw at exit
		}
	};
	process.once("exit", onExit);
	process.once("SIGTERM", onExit);
	process.once("SIGINT", onExit);

	return {
		available: () => isAvailable,
		checkFile: check,
		simulateEdit: simulate,
		invalidate,
		stats,
		dispose,
	};
}

// -----------------------------------------------------------------------------
// WatchProcess — one persistent `tsgo --watch` child per project root
// -----------------------------------------------------------------------------

/**
 * Wraps a single `tsgo --watch --noEmit` child. Parses its streamed pass
 * output into a "latest completed pass" diagnostics buffer. Tracks crash and
 * idle state. Every method is failure-tolerant: a dead/crashed child simply
 * makes `isUsable()` false so the caller falls back to the cold path.
 */
class WatchProcess {
	private child: ChildProcess | null = null;
	private _state: WatchProcessState = "not-started";
	/** stdout bytes not yet split into a complete line. */
	private lineBuffer = "";
	/** Diagnostics accumulated during the pass currently in progress. */
	private inFlightDiagnostics: TsgoDiagnostic[] = [];
	/** true between a `build starting` line and its `build finished` line. */
	private passInProgress = false;
	/** Diagnostics from the most recently *completed* pass. */
	private lastPassDiagnostics: TsgoDiagnostic[] = [];
	/** nowMs() of the last completed pass; 0 until the first pass lands. */
	private lastPassCompletedAt = 0;
	/** Resolvers waiting for the next completed pass. */
	private passWaiters: Array<() => void> = [];
	private idleTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly executable: string,
		private readonly projectRoot: string,
		private readonly idleMs: number,
	) {}

	/** Spawn the `tsgo --watch` child. Idempotent-safe; never throws. */
	start(): void {
		if (this.child) return;
		try {
			// --pretty false → stable plain-text Form-1 diagnostics, no ANSI.
			// --incremental + --tsBuildInfoFile → the watch child persists its
			//   build graph so a respawn after idle-eviction warms faster.
			const args = [
				"--watch",
				"--noEmit",
				"--pretty",
				"false",
				"--incremental",
				"--tsBuildInfoFile",
				buildInfoPath(this.projectRoot, "watch"),
			];
			const child = spawn(this.executable, args, {
				cwd: this.projectRoot,
				stdio: ["ignore", "pipe", "pipe"],
			});
			this.child = child;
			this._state = WATCH_RUNNING;
			// Don't let the watch child keep the daemon's event loop alive.
			child.unref();
			child.stdout?.on("data", (b: Buffer) => this.ingest(b.toString("utf-8")));
			// Parse stderr too: tsgo --watch keeps stderr empty today, but a
			// future tsgo that splits streams still gets its diagnostics read.
			child.stderr?.on("data", (b: Buffer) => this.ingest(b.toString("utf-8")));
			child.on("error", () => this.markCrashed());
			child.on("exit", () => {
				// An exit while we still hold the child reference is unexpected
				// (we null `child` ourselves on a deliberate kill).
				if (this.child === child) this.markCrashed();
			});
			this.resetIdleTimer();
		} catch (_err) {
			// Spawn failed outright — behave as crashed so callers cold-fall-back.
			this.markCrashed();
		}
	}

	/** True when the child is alive and serving (running, not crashed/evicted). */
	isUsable(): boolean {
		return this._state === WATCH_RUNNING && this.child !== null;
	}

	state(): WatchProcessState {
		return this._state;
	}

	/** Reset the idle-eviction countdown — called on every use. */
	touchIdle(): void {
		if (this._state === WATCH_RUNNING) this.resetIdleTimer();
	}

	/**
	 * Return diagnostics for `path` from the warm graph. If the file on disk is
	 * newer than the last completed pass (we beat tsgo's ~1s FS-watch debounce)
	 * wait up to WATCH_FRESH_WAIT_MS for the next pass. Returns null on
	 * timeout / crash so the caller uses the cold one-shot.
	 */
	async diagnosticsForFile(path: string): Promise<TsgoDiagnostic[] | null> {
		if (!this.isUsable()) return null;
		this.touchIdle();

		// Wait for the first pass if the child just started.
		if (this.lastPassCompletedAt === 0) {
			const got = await this.waitForNextPass(WATCH_INITIAL_PASS_MS);
			if (!got) return null;
		}

		// If `path` changed on disk after our last pass, tsgo will recompile —
		// wait (bounded) for that pass so we don't return stale diagnostics.
		if (this.fileNewerThanLastPass(path)) {
			const got = await this.waitForNextPass(WATCH_FRESH_WAIT_MS);
			if (!got) return null; // tsgo's watcher hasn't caught up — cold fallback
			// One more recompile may still be pending if the file kept changing;
			// a single extra bounded wait covers the common double-edit case.
			if (this.fileNewerThanLastPass(path)) {
				await this.waitForNextPass(WATCH_FRESH_WAIT_MS);
			}
		}

		if (!this.isUsable()) return null;
		return filterDiagnosticsForFile(this.lastPassDiagnostics, path, this.projectRoot);
	}

	/** Kill the child cleanly. Idempotent; safe to call after a crash. */
	kill(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		const child = this.child;
		this.child = null;
		// Release any pending waiters so callers don't hang on a killed child.
		this.flushWaiters();
		if (child) {
			try {
				child.kill("SIGTERM");
			} catch (_err) {
				void 0; // intentional: child already dead — non-fatal, nothing to do
			}
		}
	}

	// --- internals ----------------------------------------------------------

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.idleMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			// Idle window elapsed with no TS check — evict the child. The next
			// checkFile() will lazily respawn a fresh WatchProcess.
			const child = this.child;
			this.child = null;
			this._state = WATCH_IDLE_EVICTED;
			this.flushWaiters();
			if (child) {
				try {
					child.kill("SIGTERM");
				} catch (_err) {
					void 0; // intentional: child already dead — non-fatal
				}
			}
		}, this.idleMs);
		this.idleTimer.unref();
	}

	private markCrashed(): void {
		this.child = null;
		// An idle eviction also nulls `child`; don't let a late exit event
		// downgrade a clean idle-evict into a "crashed" report.
		if (this._state !== WATCH_IDLE_EVICTED) this._state = WATCH_CRASHED;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.flushWaiters();
	}

	/** Feed streamed bytes through line splitting + pass-marker parsing. */
	private ingest(chunk: string): void {
		// tsgo's classic watch mode prefixes passes with a clear-screen escape
		// (`[2J[3J[H`) that can be glued to the next text in the
		// same chunk — strip all ANSI so line matching is escape-free.
		this.lineBuffer += stripAnsi(chunk);
		let nl = this.lineBuffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.lineBuffer.slice(0, nl);
			this.lineBuffer = this.lineBuffer.slice(nl + 1);
			this.handleLine(line);
			nl = this.lineBuffer.indexOf("\n");
		}
	}

	/**
	 * Pass-marker state machine. tsgo --watch has TWO output formats — the one
	 * you get depends on the runtime environment (empirically verified May
	 * 2026; both observed against @typescript/native-preview 7.0.0-dev):
	 *
	 *   "build" format:    `build starting at <t>` … `build finished in <n>s`
	 *   "classic" format:  `<t> - Starting compilation in watch mode...`
	 *                      (or `<t> - File change detected. Starting
	 *                       incremental compilation...`) …
	 *                      `<t> - Found <n> error(s). Watching for file changes.`
	 *
	 * Diagnostics are identical in both (`file(l,c): error TS...`, Form 1). A
	 * leading `HH:MM:SS AM/PM - ` timestamp is stripped before marker matching.
	 */
	private handleLine(line: string): void {
		const trimmed = stripWatchTimestamp(line.trim());
		if (PASS_START_RE.test(trimmed)) {
			this.passInProgress = true;
			this.inFlightDiagnostics = [];
			return;
		}
		if (PASS_COMPLETE_RE.test(trimmed)) {
			// Publish whatever this pass accumulated (possibly zero diagnostics).
			this.lastPassDiagnostics = this.inFlightDiagnostics;
			this.lastPassCompletedAt = nowMs();
			this.passInProgress = false;
			this.inFlightDiagnostics = [];
			this.flushWaiters();
			return;
		}
		const diag = parseDiagnosticLine(line, "");
		if (diag) {
			if (this.passInProgress) {
				this.inFlightDiagnostics.push(diag);
			} else {
				// Defensive: a diagnostic outside a pass (unexpected tsgo output
				// ordering) still gets recorded against the latest pass.
				this.lastPassDiagnostics = [...this.lastPassDiagnostics, diag];
			}
		}
	}

	/** Resolve every pending pass-waiter (pass landed, or child died). */
	private flushWaiters(): void {
		const waiters = this.passWaiters;
		this.passWaiters = [];
		for (const w of waiters) w();
	}

	/**
	 * Wait until the next pass completes (or the child dies, or the budget
	 * elapses). Returns true iff a completed pass is available and the child
	 * is still usable.
	 */
	private waitForNextPass(budgetMs: number): Promise<boolean> {
		const startPassAt = this.lastPassCompletedAt;
		return new Promise<boolean>((resolveWait) => {
			let settled = false;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearInterval(poll);
				resolveWait(ok);
			};
			const timer = setTimeout(() => finish(false), budgetMs);
			// Poll in addition to the waiter callback: covers the (rare) race
			// where a pass completes between our read of lastPassCompletedAt
			// and registering the waiter. The poll also keeps the idle timer
			// fresh — a check that is awaiting a pass IS activity, so the child
			// must not be idle-evicted out from under an in-flight check (which
			// matters most when the idle window is short).
			const poll = setInterval(() => {
				this.touchIdle();
				if (!this.isUsable() && this.lastPassCompletedAt === startPassAt) {
					finish(false);
				} else if (this.lastPassCompletedAt > startPassAt) {
					finish(true);
				}
			}, WATCH_POLL_INTERVAL_MS);
			poll.unref?.();
			this.passWaiters.push(() => {
				if (this.lastPassCompletedAt > startPassAt && this.isUsable()) {
					finish(true);
				} else if (!this.isUsable()) {
					finish(false);
				}
				// else: a flush from an unrelated cause — keep waiting until the
				// timer or a real pass resolves us.
			});
		});
	}

	/** True when `path`'s on-disk mtime is newer than our last completed pass. */
	private fileNewerThanLastPass(path: string): boolean {
		if (this.lastPassCompletedAt === 0) return true;
		try {
			return statSync(path).mtimeMs > this.lastPassCompletedAt;
		} catch (_err) {
			return false;
		}
	}
}
