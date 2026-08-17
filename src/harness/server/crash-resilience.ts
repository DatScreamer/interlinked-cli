// ===========================================
// Daemon crash-resilience — keep the guard ALIVE on an uncaught error
// ===========================================
// A guard daemon's first duty is CONTINUITY. The per-request handlers in
// `server.ts` already try/catch every evaluation, so a check that throws
// SYNCHRONOUSLY returns a clean decision; what slips past them is an ASYNC throw
// with no local catcher — an unawaited promise inside some check, a
// timer/interval callback, a library edge case on one unusual file. With no
// handler, Node prints the stack and EXITS the process. The hook then hits the
// cold path, finds a stale `harness.pid`, and the fail-closed gate blocks every
// edit; self-heal respawns a daemon that re-triggers the SAME throw, so it
// crash-loops and the agent is bricked (observed on large monorepos, 2026-06 —
// the daemon reported healthy, then died between the status check and the next
// tool event).
//
// We instead LOG the full error (it lands in `.interlinked/logs/daemon.log` via
// the daemon's piped stderr, so the underlying bug stays findable and fixable)
// and STAY UP — the way a web server does not die on one bad request. This is a
// deliberate resume-don't-exit choice (the opposite of Node's default guidance)
// because for THIS process a momentary inconsistent state is strictly better
// than walling the agent off from its own tools. See the
// `feedback_safety_continuity` memory.

/** Log an otherwise-fatal error with the same `[interlinked-harness]` prefix
 *  `logAlways` uses (so it lands in daemon.log) and RETURN — never re-throw, or
 *  it would exit the daemon this handler exists to keep alive. Exported for the
 *  unit test; the registered handlers below are the real entry points. */
export function logFatalButSurvive(kind: string, err: unknown): void {
	try {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(
			`[interlinked-harness] ${kind} — kept the daemon alive (guard continuity): ${detail}`,
		);
	} catch {
		// intentional: if even logging throws (stderr is gone) there is nothing
		// safe left to do — re-throwing here would defeat the whole purpose.
		void 0;
	}
}

/** Survival is the right contract only for a daemon that is actually SERVING.
 *  Before the sockets are bound there is nothing to keep alive: surviving a
 *  startup failure produces a process that holds the pid file and answers
 *  nothing — the zombie class `isDaemonSocketServing` exists to detect from the
 *  outside, and the one a fresh-eyes audit reproduced three times (2026-08-14,
 *  F1). Both fields must be supplied for the fail-fast path to arm; with
 *  neither, every error is survived exactly as before. */
export interface CrashResilienceOptions {
	/** True once every socket this daemon intends to serve is bound. */
	isStartupComplete?: () => boolean;
	/** Terminal handler for an error that arrives BEFORE startup completes.
	 *  Expected to log, record the exit, and terminate — never to return and
	 *  leave the process resident. */
	onStartupFailure?: (kind: string, err: unknown) => void;
}

/** Register the process-level survival handlers. Call ONCE, as early in startup
 *  as possible, so throws during init are caught too. Node permits multiple
 *  listeners; this adds exactly one of each. */
export function installCrashResilience(opts: CrashResilienceOptions = {}): void {
	const handle = (kind: string, err: unknown): void => {
		// `=== false` (not `!...()`) so an ABSENT predicate keeps the historic
		// survive-always behavior rather than reading undefined as "incomplete".
		if (opts.onStartupFailure && opts.isStartupComplete?.() === false) {
			opts.onStartupFailure(kind, err);
			return;
		}
		logFatalButSurvive(kind, err);
	};
	process.on("uncaughtException", (err) => handle("uncaughtException", err));
	process.on("unhandledRejection", (reason) => handle("unhandledRejection", reason));
}
