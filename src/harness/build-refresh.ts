// ===========================================
// Build-refresh watcher — daemons hand over to newer builds
// ===========================================
// Every guarded repo runs a long-lived daemon from the SHARED dist/ of the
// linked CLI checkout. `interlinked reload` rebuilds + restarts the CURRENT
// repo's daemon, but sibling repos kept serving the old build until someone
// manually restarted them (operator-reported 2026-07-13: mcp-client-bio ran
// a pre-pull daemon spawned from a stale hook generation). This watcher
// closes that loop: each daemon stats its own dist artifact once a minute
// and, when a newer *settled* build appears during a *quiet* window, hands
// over by spawning `interlinked harness restart` — the same battle-tested
// stop→start sequence a human would run, so socket/pidfile ownership rules
// stay in exactly one place. The restart SIGTERMs this process; the normal
// graceful-shutdown path retires it.
//
// Src-run daemons (tsx/bun dev) no-op — there is no build artifact to watch;
// dev iterates via `interlinked reload`. Escape hatch (parallel to
// INTERLINKED_NO_SELF_HEAL): INTERLINKED_NO_AUTO_RESTART=1.

import { spawn as nodeSpawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runningBuildStaleness, stalenessWarning } from "./build-staleness.js";

const DEFAULT_INTERVAL_MS = 60_000;
/** A fresher artifact must be at least this old — tsup may still be writing. */
const SETTLE_MS = 5_000;
/** No hook event this recent — don't yank the daemon mid-burst. */
const QUIET_MS = 10_000;

export interface OwnArtifact {
	/** Absolute path of the running daemon's own build artifact. */
	artifactPath: string;
	/** Absolute path of the sibling CLI entry (`dist/index.js`). */
	cliEntryPath: string;
}

/** Resolve the running module's build artifact + CLI entry from its URL.
 *  Null when running from source (no `/dist/` segment) or unparseable —
 *  callers treat null as "nothing to watch". */
export function resolveOwnArtifact(moduleUrl: string): OwnArtifact | null {
	let here: string;
	try {
		here = fileURLToPath(moduleUrl);
	} catch {
		return null;
	}
	const marker = `${sep}dist${sep}`;
	const idx = here.indexOf(marker);
	if (idx === -1) return null;
	return { artifactPath: here, cliEntryPath: join(here.slice(0, idx), "dist", "index.js") };
}

export interface HandOverInput {
	nowMs: number;
	currentMtimeMs: number;
	startedMtimeMs: number;
	/** Last hook-event timestamp (0 = never — trivially quiet). */
	lastActivityAtMs: number;
	settleMs: number;
	quietMs: number;
}

/** Pure hand-over predicate: the artifact is newer than the one this daemon
 *  started from, the rebuild has settled, and the repo is between bursts. */
export function shouldHandOver(input: HandOverInput): boolean {
	if (input.currentMtimeMs <= input.startedMtimeMs) return false;
	if (input.nowMs - input.currentMtimeMs < input.settleMs) return false;
	if (input.nowMs - input.lastActivityAtMs < input.quietMs) return false;
	return true;
}

/** Injectable I/O so the watcher is unit-testable without spawning daemons. */
export interface BuildRefreshDeps {
	statMtimeMs: (path: string) => number | null;
	spawn: typeof nodeSpawn;
}

export interface BuildRefreshOptions {
	moduleUrl: string;
	/** Repo root the daemon guards — the restart runs with this cwd. */
	cwd: string;
	/** Live view of the daemon's last hook-event timestamp. */
	lastActivityMs: () => number;
	log: (line: string) => void;
	intervalMs?: number;
	env?: NodeJS.ProcessEnv;
	deps?: Partial<BuildRefreshDeps>;
}

function defaultStatMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/** Fire the detached restart. Failures are swallowed — the throttle expires
 *  and the next tick retries, since the artifact will still read as newer. */
function spawnHandOver(deps: BuildRefreshDeps, own: OwnArtifact, cwd: string): void {
	try {
		const child = deps.spawn(process.execPath, [own.cliEntryPath, "harness", "restart"], {
			cwd,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		/* intentional: retried on a later tick */
	}
}

/**
 * Start the build-refresh watcher. Also emits the startup staleness warning
 * (src newer than dist) that previously lived inline in server.ts — the two
 * signals share one home so freshness logic isn't split across files.
 * Returns a disposer; the timer is unref'd so it never pins the process.
 */
export function startBuildRefreshWatcher(opts: BuildRefreshOptions): () => void {
	const warn = stalenessWarning(runningBuildStaleness(opts.moduleUrl));
	if (warn) opts.log(warn);

	const env = opts.env ?? process.env;
	if (env.INTERLINKED_NO_AUTO_RESTART === "1") return () => {};
	const own = resolveOwnArtifact(opts.moduleUrl);
	if (own === null) return () => {};

	const deps: BuildRefreshDeps = {
		statMtimeMs: defaultStatMtimeMs,
		spawn: nodeSpawn,
		...opts.deps,
	};
	const startedMtimeMs = deps.statMtimeMs(own.artifactPath);
	if (startedMtimeMs === null) return () => {};

	const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	let lastAttemptMs = 0;
	const timer = setInterval(() => {
		const nowMs = Date.now();
		// A hand-over is pending — give the restart two intervals to land
		// before concluding it failed and retrying.
		if (lastAttemptMs !== 0 && nowMs - lastAttemptMs < intervalMs * 2) return;
		const currentMtimeMs = deps.statMtimeMs(own.artifactPath);
		if (currentMtimeMs === null) return;
		const decide: HandOverInput = {
			nowMs,
			currentMtimeMs,
			startedMtimeMs,
			lastActivityAtMs: opts.lastActivityMs(),
			settleMs: SETTLE_MS,
			quietMs: QUIET_MS,
		};
		if (!shouldHandOver(decide)) return;
		lastAttemptMs = nowMs;
		opts.log(
			`[build-refresh] newer build detected (artifact ${new Date(currentMtimeMs).toISOString()} > running ${new Date(startedMtimeMs).toISOString()}) — handing over via \`interlinked harness restart\``,
		);
		spawnHandOver(deps, own, opts.cwd);
	}, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}
