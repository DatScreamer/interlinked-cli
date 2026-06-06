#!/usr/bin/env node
// ===========================================
// Interlinked Harness Server
// ===========================================
// Local Unix socket server for agent guard evaluation, lifecycle management,
// and auto file reservation. Runs as a background process per developer.
//
// Usage:
//   node cli/dist/harness/server.js [--socket <path>] [--idle-timeout <ms>]
//
// Idle timeout disabled by default (event-driven, no CPU cost when idle). Configurable via --idle-timeout.
//
// The event-processing pipeline (lifecycle / PreToolUse / PostToolUse) lives
// in `server/`; this file owns CLI parsing, daemon-scoped state, the socket
// servers, and process lifecycle. `processEvent` builds a `ServerRuntime`
// context once and delegates each event branch to the extracted pipelines.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	autoStripAllScopes,
	defaultStripAuditLogPath,
	describeReason as describeMalformedReason,
} from "../lib/settings-validator.js";
import { createAsyncAnalysisManager } from "./async-analysis.js";
import { AsyncFindingQueue } from "./async-finding-queue.js";
import {
	type AutoCoordinationState,
	DEFAULT_AUTO_COORDINATION_CONFIG,
} from "./auto-coordinate.js";
import { runningBuildStaleness, stalenessWarning } from "./build-staleness.js";
import { registerAllBuiltinVerifyPasses } from "./check-pipeline/builtin-verify-passes.js";
import { CohortManager } from "./cohort.js";
import { compileAllowlist } from "./content-scanner/allowlist.js";
import { createScanner } from "./content-scanner/registry.js";
import type { ContentScanner } from "./content-scanner/types.js";
import { ErrorHistory } from "./error-history.js";
import { resetProjectSetupWarningsCache } from "./evaluator/pre-tool.js";
import { type FilePriority } from "./file-priority.js";
import { FileContentCache } from "./grep-accelerator.js";
import { createLearnedRulesStore } from "./learned-rules.js";
import { sweepStaleLiveSnapshots } from "./live-snapshot.js";
import {
	type ClassifierSessionState,
	resolveApiKey,
} from "./policy-classifier.js";
import { ProjectGraph } from "./project-graph.js";
import { ProjectWideSweepState } from "./quality-checks.js";
import { astComplexityAvailable } from "./checks/cyclomatic-ast.js";
import { ReservationManager } from "./reservations.js";
import { RouteMap } from "./route-map.js";
import { loadRules, watchRulesFiles } from "./rules-loader.js";
import {
	parseProtocolMode,
	resolveIdleTimeoutMs,
	stringArg,
} from "./server/cli-args.js";
import { writeCollectionRecord as appendCollectionRecord } from "./server/collection-writer.js";
import {
	buildStartupMessage,
	computeClassifierStatusLine,
	createProtocolStatus,
	formatScannerStatusLine,
	type HarnessProtocolMode,
	type ProtocolStatusFile,
} from "./server/protocol-status.js";
import {
	getGraphForFile as resolveGraphForFile,
	type ServerRuntime,
} from "./server/runtime-context.js";
import { ensureDirectory, removeFileIfExists } from "./server/socket-lifecycle.js";
import { createStatusWriters } from "./server/status-writers.js";
import { createServerBridge, type ServerBridge } from "./server-bridge.js";
import { createEventLoop } from "./server-event-loop.js";
import { createSocketLifecycle } from "./server-socket-lifecycle.js";
import { startSessionDaemon } from "./session-daemon.js";
import { daemonPathsFor } from "./session-paths.js";
import { SessionTracker } from "./session-state.js";
import { watchSettingsFiles } from "./settings-watcher.js";
import { writeStatuslineArtifacts } from "./statusline-snapshot.js";
import { TrigramIndex } from "./trigram-index.js";
import { createTsgoRunner } from "./tsgo-runner.js";
import type { GuardRulesConfig, HarnessEvent, PreEditBaseline } from "./types.js";

// ===========================================
// CLI Arguments
// ===========================================

const { values: args } = parseArgs({
	options: {
		socket: { type: "string", short: "s" },
		"pid-file": { type: "string" },
		"idle-timeout": { type: "string" },
		cwd: { type: "string" },
		protocol: { type: "string" },
		"session-id": { type: "string" },
		verbose: { type: "boolean", short: "v", default: false },
	},
	strict: false,
});

const CWD = stringArg(args.cwd) || process.cwd();
const INTERLINKED_DIR = join(CWD, ".interlinked");

// Register the bundled verify-pass filters (Mythos Phase 3). Module-load
// side effect: every PostToolUse detector now runs through the second-
// pass FP filter chain. Adding new built-ins is a one-line append in
// `check-pipeline/builtin-verify-passes.ts`; nothing else needs to change.
registerAllBuiltinVerifyPasses();

// Recency-weighted check-depth state (Mythos Phase 4). Populated lazily
// on first SessionStart (or first PostToolUse use, whichever fires) so
// the cold-start cost is paid once per daemon. Per-file priorities map
// is consulted by `shouldRunAdvisoryChecks(filePath, filePriorityMap)`
// before each advisory inline detector pass; cold files (>180 days
// unchanged) skip the heavier checks entirely.
let filePriorityMap = new Map<string, FilePriority>();
const SOCKET_PATH = stringArg(args.socket) || join(INTERLINKED_DIR, "harness.sock");
const PID_PATH = stringArg(args["pid-file"]) || join(INTERLINKED_DIR, "harness.pid");

// ============================================================================
// Early SIGTERM/SIGINT handler — installed BEFORE heavy startup work.
// ============================================================================
// Why: Node delivers signals on JS turn boundaries. The full graceful
// `shutdown()` registered at the bottom of this file can't fire until module
// initialization finishes — and trigram-index load, project-graph build,
// rule compilation, etc. are mostly synchronous, so a SIGTERM during
// startup gets queued for *seconds*. The user-visible symptom is
// `harness restart` hitting its grace window every time and falling back to
// SIGKILL.
//
// The fix: register a minimal handler immediately. If a signal arrives
// before the full shutdown machinery is wired, set a "pending" flag and
// schedule a hard exit. Once startup completes, the bottom-of-file code
// upgrades the handler to the real `shutdown()`. If the pending flag is
// set, it triggers shutdown right away.
let _shutdownReady = false;
let _shutdownPending = false;
function _earlyShutdown(): void {
	if (_shutdownReady) {
		// Real handler is in place; this branch is unreachable in practice
		// (process.on rebinds), but defensive against double-binding.
		return;
	}
	_shutdownPending = true;
	// Best-effort artifact cleanup so the next startup doesn't see a stale
	// pid file from a daemon that was killed mid-init.
	removeFileIfExists(PID_PATH);
	// Hard exit after a short window if the real shutdown never wires up.
	// 1500 ms covers cold-cache module init (~1s on this repo) but stays
	// tight enough that the user perceives the shutdown as snappy. Forced
	// exit isn't graceful, but the daemon hasn't accepted external
	// connections yet — there's nothing to drain.
	const t = setTimeout(() => {
		process.exit(0);
	}, 1500);
	t.unref();
}
process.on("SIGTERM", _earlyShutdown);
process.on("SIGINT", _earlyShutdown);

const PROTOCOL_MODE: HarnessProtocolMode = parseProtocolMode(stringArg(args.protocol));
const RUN_RAW_SOCKET = PROTOCOL_MODE !== "framed";
const RUN_FRAMED_SOCKET = PROTOCOL_MODE !== "raw";
const FRAMED_SESSION_ID = stringArg(args["session-id"]) || process.env.INTERLINKED_SESSION_ID || "default";
const FRAMED_PATHS = daemonPathsFor(CWD, FRAMED_SESSION_ID);
// Always-on by default. Per-session Maps (classifierSessions, autoCoordStates,
// preEditBaselines) drop on SessionEnd, so resident memory stabilizes around
// ~30 MB per daemon — it doesn't grow with uptime. The original orphan-
// accumulation concern (many daemons × many CWDs) is handled by the explicit
// `interlinked harness clean` command, not by an idle timer.
// Set `--idle-timeout <ms>` to opt back into auto-shutdown if you want it.
const IDLE_TIMEOUT_DEFAULT_MS = 0;
const IDLE_TIMEOUT_MS = resolveIdleTimeoutMs(
	stringArg(args["idle-timeout"]),
	IDLE_TIMEOUT_DEFAULT_MS,
);
const VERBOSE = args.verbose;

/** Milliseconds in one minute — for converting IDLE_TIMEOUT_MS into a human-readable log line. */
const MS_PER_MINUTE = 60_000;

// ===========================================
// State
// ===========================================

let rules: GuardRulesConfig = loadRules(CWD);
const cohort = new CohortManager();
const sessions = new SessionTracker();

// --- Statusline status-file writers ---
// One-line marker files the bash statusline polls (classifier readiness,
// content-scanner lifecycle, pending-review count). Constructed early so the
// content-scanner block below can write its initial status. See
// `server/status-writers.ts`.
const {
	writeClassifierStatus,
	writeScannerStatus,
	writeReviewPendingMarker,
} = createStatusWriters(INTERLINKED_DIR);

// --- Async-deferred finding queue ---
// Holds findings computed off the hook critical path (slow checks);
// drained into PreToolUse output and cleared on SessionEnd. No enqueuers
// are wired yet — drain is a no-op until the first async check lands
// (see docs/plans/08 and async-finding-queue.ts).
const asyncFindings = new AsyncFindingQueue();

// --- Learned rules (cross-session permission learning) ---
const learnedRules = createLearnedRulesStore(INTERLINKED_DIR);

// --- Async analysis (background check coalescing) ---
const asyncAnalysis = createAsyncAnalysisManager(INTERLINKED_DIR);

// --- LLM policy classifier session state ---
// Per-session classifier state (call count, consecutive failures).
const classifierSessions = new Map<string, ClassifierSessionState>();

// ML content scanner (OpenAI privacy-filter / gpt-oss-safeguard). Off by default;
// opt in via `.interlinked/guard-rules.local.json` → `"content_scanner": {"enabled": true}`.
// Undefined when disabled or misconfigured — both read paths below null-check.
const contentScanner: ContentScanner | undefined = rules.content_scanner
	? createScanner(rules.content_scanner)
	: undefined;
// Compile the allowlist once at startup so we don't pay regex/string-building
// cost on every scan. Recompiled on hot-reload (see watchRulesFiles below).
let compiledAllowlist = compileAllowlist(rules.content_scanner?.allowlist);
if (contentScanner) {
	// Visible at startup so agents know the scanner is in-line.
	logAlways(`Content scanner: enabled (${contentScanner.name} / ${contentScanner.runtime})`);
	if (contentScanner.onStatusChange) {
		// Statusline writer — every lifecycle transition (spawn, ready, dormant,
		// disabled) lands a single-line marker at .interlinked/content-scanner.status.
		contentScanner.onStatusChange((s) => {
			writeScannerStatus(formatScannerStatusLine(s));
		});
	} else {
		// HTTP backends don't currently surface state — treat them as running.
		writeScannerStatus(`ready:${contentScanner.runtime}`);
	}
} else {
	writeScannerStatus("disabled");
}

// --- Auto-coordination state ---
const autoCoordStates = new Map<string, AutoCoordinationState>();
const indexWarningSent = new Set<string>();
const autoCoordConfig = {
	...DEFAULT_AUTO_COORDINATION_CONFIG,
	...(rules.auto_coordination || {}),
};

// --- Pre-edit baseline cache (diff-aware quality checks) ---
// Captured on PreToolUse for Edit/Write tools, consumed on PostToolUse.
const preEditBaselines = new Map<string, PreEditBaseline>();
const routeMap = new RouteMap(CWD);
const errorHistory = new ErrorHistory(INTERLINKED_DIR, rules.error_memory);

// --- Project-wide check sweep state ---
// Tracks edit count and reported findings for debounced cross-file sweeps.
const projectWideSweepState = new ProjectWideSweepState();

// --- Multi-project graph cache ---
// Lazily creates a ProjectGraph per project root so structural checks work
// for files in any repo, not just the harness's CWD.
const _graphCache = new Map<string, ProjectGraph>();

/** Resolve (and lazily build + cache) the project graph for a file. Thin
 *  wrapper over `server/runtime-context.getGraphForFile` so the local
 *  call sites (background init, framed-daemon context) stay terse. */
function getGraphForFile(filePath: string): ProjectGraph {
	return resolveGraphForFile(serverRuntime, filePath);
}

// Defer CWD graph initialization — socket starts accepting connections immediately.
// First request that needs the graph triggers lazy init via getGraphForFile().
setTimeout(() => {
	try {
		const g = getGraphForFile(CWD);
		routeMap.initialize(g.allFiles());
		log("Route map initialized");
	} catch (err) {
		log(`Background init failed (non-fatal): ${err}`);
	}
	log(`Error history loaded: ${errorHistory.size} records`);
}, 0);

// --- Trigram search index (grep acceleration) ---
// Load existing index if available; build is done via CLI command.
// Content cache avoids redundant disk reads for files the agent just edited.
const fileContentCache = new FileContentCache();
let trigramIndex: TrigramIndex | null = null;
setTimeout(() => {
	try {
		trigramIndex = TrigramIndex.load(CWD);
		if (trigramIndex) {
			serverRuntime.trigramIndex = trigramIndex;
			log(
				`Trigram index loaded: ${trigramIndex.files.length} files, base ${trigramIndex.baseCommit.slice(0, 8)}`,
			);
			// Incremental update from git changes since index was built
			const updated = trigramIndex.incrementalUpdate();
			if (updated > 0) {
				log(`Trigram index updated: ${updated} files changed since base commit`);
			}
		} else {
			log("No trigram index found (run `interlinked index build` to create one)");
		}
	} catch (err) {
		log(`Trigram index load failed (non-fatal): ${err}`);
	}
	refreshStatuslineSnapshot();
}, 0);

// --- Strict cyclomatic gate capability ---
// The PreToolUse cyclomatic block + CRAP scoring need the AST pass (the optional
// `typescript` dep, now in optionalDependencies so a normal install has it).
// `--omit=optional` or a stripped install drops it, degrading the gate to the
// less-accurate regex walker. The fail-open in complexity-write-guard would hide
// that, so surface it loudly here (stderr, not verbose-gated) — never silent.
if (astComplexityAvailable()) {
	log("Cyclomatic gate: AST-accurate (typescript resolved)");
} else {
	console.error(
		"[interlinked] WARNING: `typescript` is not resolvable — the strict cyclomatic " +
			"PreToolUse gate and CRAP scoring fell back to the less-accurate regex walker. " +
			"Reinstall without `--omit=optional` to restore AST-accurate enforcement.",
	);
}

// --- Structure graph cache (persists across PostToolUse calls) ---
// Avoids rebuilding the full artifact graph on every file edit.
let structureGraph: import("./structure/artifact-graph.js").ArtifactGraph | null = null;
let structureConfigCache: import("./structure/types.js").StructureConfig | null = null;

// Create server bridge for reservation sync and guard event reporting
const serverBridge: ServerBridge | null = createServerBridge(CWD);
if (serverBridge) {
	log("Server bridge connected");
} else {
	log("No server configured — running in local-only mode");
}

const reservationEventsPath = join(CWD, ".interlinked", "reservation-events.jsonl");
const reservations = new ReservationManager(
	serverBridge || undefined,
	undefined,
	(event) => {
		try {
			const dir = dirname(reservationEventsPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(reservationEventsPath, `${JSON.stringify(event)}\n`);
		} catch (_err) {
			/* intentional: reservation-events is best-effort observability */
		}
	},
);
let idleTimer: ReturnType<typeof setTimeout>;

const PROTOCOL_STATUS_PATH = join(INTERLINKED_DIR, "harness-protocol.json");
const protocolStatus: ProtocolStatusFile = createProtocolStatus({
	protocol: PROTOCOL_MODE,
	rawSocketPath: RUN_RAW_SOCKET ? SOCKET_PATH : null,
	framedSocketPath: RUN_FRAMED_SOCKET ? FRAMED_PATHS.socket : null,
	framedSessionId: RUN_FRAMED_SOCKET ? FRAMED_SESSION_ID : null,
});

// ===========================================
// Logging
// ===========================================

function log(msg: string): void {
	if (VERBOSE) {
		console.error(`[harness ${new Date().toISOString().slice(11, 19)}] ${msg}`);
	}
}

function logAlways(msg: string): void {
	console.error(`[interlinked-harness] ${msg}`);
}

// Statusline status-file writers (writeClassifierStatus / writeScannerStatus /
// writeReviewPendingMarker) are constructed in the State section above via
// `createStatusWriters(INTERLINKED_DIR)` — see `server/status-writers.ts`.

/**
 * Refresh `.interlinked/statusline.snapshot` and `.interlinked/loaded-rules.md`.
 * Called from the rules hot-reload callback, the trigram-index load timer,
 * and a low-frequency tick that keeps reservation/index counters fresh.
 * Cheap (a few in-memory reads + ~500-byte file write) — safe to call often.
 */
function refreshStatuslineSnapshot(): void {
	const indexStatus = trigramIndex ? "ready" : "missing";
	const indexFiles = trigramIndex?.files.length ?? 0;
	writeStatuslineArtifacts({
		cwd: CWD,
		interlinkedDir: INTERLINKED_DIR,
		rules,
		reservationsCount: reservations.getAll().length,
		indexStatus,
		indexFiles,
		serverBridgeConnected: serverBridge !== null,
		daemonPid: process.pid,
	});
}

// ===========================================
// Idle Timer
// ===========================================

function resetIdleTimer(): void {
	if (!IDLE_TIMEOUT_MS) return; // 0 = disabled
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		logAlways(`Shutting down after ${IDLE_TIMEOUT_MS / MS_PER_MINUTE}min idle`);
		shutdown();
	}, IDLE_TIMEOUT_MS);
}

// ===========================================
// Runtime context
// ===========================================
// One mutable object bundling all daemon-scoped state, passed to each
// extracted pipeline. The reassign-on-reload fields (`rules`,
// `trigramIndex`, `compiledAllowlist`, `structure*`, `filePriorityMap`) are
// kept in sync with the module-level `let`s by `syncRuntime()` — called
// before every pipeline dispatch and after every state-mutating handler.

const serverRuntime: ServerRuntime = {
	cwd: CWD,
	interlinkedDir: INTERLINKED_DIR,
	rules,
	cohort,
	sessions,
	reservations,
	errorHistory,
	routeMap,
	serverBridge,
	asyncFindings,
	learnedRules,
	asyncAnalysis,
	projectWideSweepState,
	contentScanner,
	compiledAllowlist,
	classifierSessions,
	autoCoordStates,
	autoCoordConfig,
	indexWarningSent,
	preEditBaselines,
	trigramIndex,
	fileContentCache,
	structureGraph,
	structureConfigCache,
	filePriorityMap,
	graphCache: _graphCache,
	log,
	logAlways,
	writeClassifierStatus,
	writeReviewPendingMarker,
};

/** Push module-level `let`s that pipelines may reassign into the runtime
 *  context before dispatch, and pull pipeline-mutated fields back out
 *  afterward. Keeps the two views from drifting without a Proxy. */
function syncRuntimeIn(): void {
	serverRuntime.rules = rules;
	serverRuntime.compiledAllowlist = compiledAllowlist;
	serverRuntime.trigramIndex = trigramIndex;
	serverRuntime.structureGraph = structureGraph;
	serverRuntime.structureConfigCache = structureConfigCache;
	serverRuntime.filePriorityMap = filePriorityMap;
}
function syncRuntimeOut(): void {
	trigramIndex = serverRuntime.trigramIndex;
	structureGraph = serverRuntime.structureGraph;
	structureConfigCache = serverRuntime.structureConfigCache;
	filePriorityMap = serverRuntime.filePriorityMap;
}

// ===========================================
// Collection v1 record writer
// ===========================================

/** Build and append a collection.v1 record for a tool event, binding the
 *  daemon CWD as the fallback. Mapping + I/O live in
 *  `server/collection-writer.ts`; this wrapper keeps the call sites terse. */
function writeCollectionRecord(event: HarnessEvent): void {
	appendCollectionRecord(event, CWD);
}

// ===========================================
// Event Processing
// ===========================================
// The per-event pipeline (parse → hydrate/record session → lifecycle/Pre/Post
// dispatch → snapshot + latency log) lives in `server-event-loop.ts`. It
// closes over the `serverRuntime` context plus the module-scoped callbacks
// below (idle-timer reset, runtime in/out sync, collection-record writer) and
// the protocol-status object + path. `writeProtocolStatus` is returned so the
// startup statements at the bottom of this file can serialize the status file.

/** Deadline (in ms) to drain pending async analysis work before shutdown. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

const { evaluateEventLine, evaluateUnifiedViaRuntime, writeProtocolStatus } = createEventLoop({
	ctx: serverRuntime,
	protocolStatus,
	protocolStatusPath: PROTOCOL_STATUS_PATH,
	resetIdleTimer,
	syncRuntimeIn,
	syncRuntimeOut,
	writeCollectionRecord,
});

// ===========================================
// Server Setup
// ===========================================
// The socket binding, legacy pid file, raw-socket connection server, and the
// graceful/forced shutdown path live in `server-socket-lifecycle.ts`. That
// cluster closes over the live socket server, the framed-daemon handle, the
// open-client set, the shutting-down flag, and the connection counter, so it
// is built behind one factory here. The framed-daemon handle and the
// rules/settings watcher disposers are bound after they are created, via
// `setFramedDaemon` / `setUnwatchers`.

const { cleanupSocket, writePidFile, shutdown, startRawServer, setFramedDaemon, setUnwatchers } =
	createSocketLifecycle({
		socketPath: SOCKET_PATH,
		pidPath: PID_PATH,
		runRawSocket: RUN_RAW_SOCKET,
		asyncAnalysisDrainTimeoutMs: ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS,
		serverBridge,
		reservations,
		contentScanner,
		asyncAnalysis,
		evaluateEventLine,
		log,
		logAlways,
	});

// ===========================================
// Start Server
// ===========================================

// Clean up stale raw socket from previous run. Framed startup performs its own
// PID-aware stale-artifact check before removing `harness-*.sock`.
if (RUN_RAW_SOCKET) {
	cleanupSocket();
	ensureDirectory(SOCKET_PATH);
}
writePidFile();
writeProtocolStatus();

// Sweep orphaned `<id>.live.json` snapshots older than 48h. A session that
// hasn't sent an event in two days is stale enough that its snapshot is no
// longer load-bearing — keeping it around just delays GC and clutters
// `interlinked status`. Live snapshots from sessions still active in the
// last 48h survive and will hydrate on their next event.
{
	const sweep = sweepStaleLiveSnapshots(CWD);
	if (sweep.removed.length > 0) {
		log(
			`Reaped ${sweep.removed.length} stale live snapshot(s) (of ${sweep.scanned} scanned)`,
		);
	}
}

// Watch rules files for hot-reload
const unwatchRules = watchRulesFiles(CWD, (newRules) => {
	rules = newRules;
	serverRuntime.rules = rules;
	// Update classifier status on config reload
	writeClassifierStatus(computeClassifierStatusLine(rules));
	// Update scanner status on config reload. If the user toggled off via
	// `interlinked scanner off`, the flag flips here; scan paths already
	// short-circuit on rules.content_scanner?.enabled so no further scans run.
	// The existing sidecar stays alive until its idle timer fires, which is
	// fine — it just sits dormant. On toggle-back-on we reuse the live scanner.
	if (!rules.content_scanner?.enabled) {
		writeScannerStatus("disabled");
	} else if (contentScanner?.getStatus) {
		writeScannerStatus(formatScannerStatusLine(contentScanner.getStatus()));
	} else if (contentScanner) {
		writeScannerStatus(`ready:${contentScanner.runtime}`);
	} else {
		// Config flipped from disabled→enabled at runtime, but the scanner
		// was not constructed at startup. Requires a harness restart to pick up.
		writeScannerStatus("down:needs_restart");
	}
	// Recompile the allowlist whenever rules reload — users adding entries
	// to .interlinked/guard-rules.local.json shouldn't have to restart the
	// harness for them to take effect on the next scan.
	compiledAllowlist = compileAllowlist(rules.content_scanner?.allowlist);
	serverRuntime.compiledAllowlist = compiledAllowlist;
	// Update auto-coordination config
	Object.assign(autoCoordConfig, DEFAULT_AUTO_COORDINATION_CONFIG, rules.auto_coordination || {});
	log(`Rules reloaded: ${rules.rules.length} rules active`);
	refreshStatuslineSnapshot();
});

// Live filesystem watcher on .claude/settings*.json (project + user
// scope). Claude Code's "Always allow" UI writes those files directly
// without firing a tool hook, so PreToolUse content guards in
// `evaluator/write-content-guards.ts` can't intercept it. The
// SessionStart strip above only runs after Claude Code has already
// printed its "Invalid permission rule" warning to the terminal —
// closing that gap is what this watcher is for. On change, the
// debounced strip runs `autoStripAllScopes` so a malformed rule lives
// on disk for at most ~poll + debounce before being removed.
const unwatchSettings = watchSettingsFiles({
	cwd: CWD,
	onStrip: (stripResult) => {
		resetProjectSetupWarningsCache();
		const previews = stripResult.entries.slice(0, 5).map((e) => {
			const file = e.file.replace(/^.+?(\.claude\/.+)$/, "$1");
			return `  - ${file} permissions.${e.bucket}[${e.index}] = ${JSON.stringify(e.rule)} (${describeMalformedReason(e.reason)})`;
		});
		const more =
			stripResult.entries.length > previews.length
				? `\n  ...and ${stripResult.entries.length - previews.length} more`
				: "";
		logAlways(
			`[interlinked] Live-stripped ${stripResult.totalStripped} malformed permission rule(s) from .claude/settings*.json:\n${previews.join("\n")}${more}`,
		);
	},
});

// Hand the watcher disposers to the lifecycle cluster so `shutdownAsync` can
// stop the rules + settings watchers on teardown. Done immediately after both
// watchers exist and before the real `shutdown()` is wired to process signals
// below — matching the prior ordering where `shutdownAsync` closed over these
// as module `const`s declared above the signal handlers.
setUnwatchers(unwatchRules, unwatchSettings);

// Periodically refresh the statusline snapshot so live counters
// (reservations, index status, server-bridge connectivity) reflect
// current state without depending on a triggering event.
const STATUSLINE_REFRESH_INTERVAL_MS = 10_000;
setInterval(() => {
	refreshStatuslineSnapshot();
}, STATUSLINE_REFRESH_INTERVAL_MS);

// Start idle timer
resetIdleTimer();

// Periodically check for lost agents (every 2 minutes)
setInterval(
	() => {
		const lost = cohort.detectLostAgents();
		for (const agent of lost) {
			log(`Agent lost (no events for 5min): ${agent.name}`);
			reservations.releaseAllForAgent(agent.name, cohort);
		}
	},
	2 * 60 * 1000,
);

// Handle process signals
// Upgrade the early SIGTERM/SIGINT handlers (installed at the top of this
// file before heavy startup work) to the full graceful `shutdown()`. The
// early handler covers signals that arrive while module init was still
// blocking the event loop — without it, restarts during the first ~3s of
// daemon life always fall through to SIGKILL. Order matters: re-bind first
// so any signal arriving DURING this turn lands on the real handler, then
// honor a flag set by the early handler if a signal was already received.
process.removeListener("SIGTERM", _earlyShutdown);
process.removeListener("SIGINT", _earlyShutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
_shutdownReady = true;
if (_shutdownPending) {
	logAlways("Shutdown was requested during startup — running graceful path now");
	shutdown();
}
process.on("SIGHUP", () => {
	// Reload rules on SIGHUP
	rules = loadRules(CWD);
	serverRuntime.rules = rules;
	logAlways(`Rules reloaded via SIGHUP: ${rules.rules.length} rules active`);
});

const tsgoRunner = createTsgoRunner();

if (RUN_FRAMED_SOCKET) {
	setFramedDaemon(
		await startSessionDaemon({
			paths: FRAMED_PATHS,
			session_id: FRAMED_SESSION_ID,
			idle_shutdown_ms: IDLE_TIMEOUT_MS,
			state: {
				tsgo: tsgoRunner,
				getEvaluatorContext: () => ({
					rules,
					session: sessions.get(FRAMED_SESSION_ID),
					reservations,
					cohort,
					graph: getGraphForFile(CWD),
					sessions,
					routeMap,
					errorHistory,
				}),
				evaluateHook: evaluateUnifiedViaRuntime,
			},
		}),
	);
}

if (RUN_RAW_SOCKET) {
	startRawServer();
}

writeProtocolStatus();

logAlways(
	buildStartupMessage({
		protocol: PROTOCOL_MODE,
		rawSocketPath: RUN_RAW_SOCKET ? SOCKET_PATH : null,
		framedSocketPath: RUN_FRAMED_SOCKET ? FRAMED_PATHS.socket : null,
		pid: process.pid,
		ruleCount: rules.rules.length,
		idleTimeoutMs: IDLE_TIMEOUT_MS,
		msPerMinute: MS_PER_MINUTE,
	}),
);

const __staleWarn = stalenessWarning(runningBuildStaleness(import.meta.url));
if (__staleWarn) logAlways(__staleWarn);

// Write initial classifier status for statusline
writeClassifierStatus(computeClassifierStatusLine(rules));
if (rules.policy_classifier?.enabled) {
	const { provider, model } = rules.policy_classifier;
	const hasKey =
		provider === "claude_code" || !!resolveApiKey(rules.policy_classifier.api_key_env);
	log(`Policy classifier: ${provider}/${model} (${hasKey ? "ready" : "no API key"})`);
}

// server.ts is a process entry point (shebang above) — it has no public
// API. Every consumer either spawns `dist/harness/server.js` as a daemon
// or imports the extracted pipeline modules from `server/` directly.
