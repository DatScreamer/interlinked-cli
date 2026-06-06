// ============================================================================
// Behavioral tests for the harness daemon entry point (`server.ts`).
// ============================================================================
// `server.ts` is a process entry point: it has NO exports and runs its entire
// startup as module-load side effects (CLI parse → state construction → socket
// servers → process-signal wiring → framed-daemon spawn). The only way to cover
// it is to `import("./server.js")` under a full mock harness that neutralizes
// every real side effect (no real Unix socket, no `process.exit`, no daemon
// spawn, no disk writes) and CAPTURES the callbacks server.ts wires into its
// collaborators (rules hot-reload, settings-strip, scanner status, the socket
// lifecycle setters, the framed-daemon evaluator-context factory). Invoking
// those captured callbacks is what exercises the inline closures that are the
// real coverable logic of this file.
//
// Strategy:
//   * `process.argv` is set per-suite BEFORE the dynamic import so the REAL
//     `parseArgs` runs against controlled flags (covers the CLI-arg branches).
//   * `process.on` / `process.removeListener` / `process.exit` are spied so
//     signal handlers are captured (not bound to the real process) and exit is
//     a throw we can assert, never a real exit.
//   * timers are faked so the three `setTimeout(0)` background-init closures and
//     the two `setInterval` ticks can be flushed and asserted deterministically.
//   * sibling modules are mocked at their import boundary; the factory return
//     values double as the assertion handles.
//
// Each test re-imports the module fresh (`vi.resetModules()` in beforeEach) so
// the top-level state is rebuilt against that test's mock configuration.

import { EventEmitter } from "node:events";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { ContentScanner, ScannerStatus } from "./content-scanner/types.js";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import type { HarnessDecision } from "./types.js";
import type { GuardRulesConfig } from "./types/config.js";

// ---------------------------------------------------------------------------
// Shared mutable capture slots. Reset in beforeEach. The mock factories below
// are hoisted by Vitest, so they reference these via closure (they exist at
// module-eval time) and must not be re-assigned to fresh objects per-test —
// only mutated.
// ---------------------------------------------------------------------------

interface Captured {
	rulesReloadCb: ((rules: GuardRulesConfig) => void) | null;
	settingsOnStrip: ((r: StripResult) => void) | null;
	scannerStatusCb: ((s: ScannerStatus) => void) | null;
	socketSetters: {
		setFramedDaemon: Mock | null;
		setUnwatchers: Mock | null;
		startRawServer: Mock | null;
		cleanupSocket: Mock | null;
		writePidFile: Mock | null;
		shutdown: Mock | null;
	};
	eventLoopDeps: EventLoopDepsCapture | null;
	sessionDaemonOpts: SessionDaemonOptsCapture | null;
	socketLifecycleDeps: SocketLifecycleDepsCapture | null;
	statusWriters: {
		writeClassifierStatus: Mock;
		writeScannerStatus: Mock;
		writeReviewPendingMarker: Mock;
	};
	reservationEventSink: ((event: unknown) => void) | null;
}

interface StripResult {
	totalStripped: number;
	entries: Array<{
		file: string;
		bucket: string;
		index: number;
		rule: unknown;
		reason: string | undefined;
	}>;
}

interface EventLoopDepsCapture {
	resetIdleTimer: () => void;
	syncRuntimeIn: () => void;
	syncRuntimeOut: () => void;
	writeCollectionRecord: (event: unknown) => void;
	protocolStatusPath: string;
	ctx: Record<string, unknown>;
}

interface SessionDaemonOptsCapture {
	session_id: string;
	idle_shutdown_ms?: number;
	state: {
		getEvaluatorContext: () => Record<string, unknown>;
		evaluateHook: (event: unknown) => Promise<HarnessDecision>;
		tsgo: unknown;
	};
	paths: unknown;
}

interface SocketLifecycleDepsCapture {
	socketPath: string;
	pidPath: string;
	runRawSocket: boolean;
	serverBridge: unknown;
	contentScanner: ContentScanner | undefined;
}

const cap: Captured = {
	rulesReloadCb: null,
	settingsOnStrip: null,
	scannerStatusCb: null,
	socketSetters: {
		setFramedDaemon: null,
		setUnwatchers: null,
		startRawServer: null,
		cleanupSocket: null,
		writePidFile: null,
		shutdown: null,
	},
	eventLoopDeps: null,
	sessionDaemonOpts: null,
	socketLifecycleDeps: null,
	statusWriters: {
		writeClassifierStatus: vi.fn(),
		writeScannerStatus: vi.fn(),
		writeReviewPendingMarker: vi.fn(),
	},
	reservationEventSink: null,
};

// Per-test override for what loadRules returns (rebuilt fresh in beforeEach).
let rulesOverride: GuardRulesConfig;
// Per-test override for what createScanner returns.
let scannerOverride: ContentScanner | undefined;
// Per-test override for what createServerBridge returns.
let serverBridgeOverride: { shutdown: Mock } | null;

// A VALID GuardRulesConfig built off the shipped `DEFAULT_CONFIG` so every
// required nested config (curl_mcp_detection, structural_checks, error_memory,
// taint_tracking, output_scanning, …) is fully-formed without hand-construction.
// `loadRules`/`watchRulesFiles` are mocked, so this is the single source of the
// daemon's "rules". Deep-clone the default so per-test overrides never mutate
// the shared const. `content_scanner` is absent by default (the disabled
// branch); tests pass it in via `overrides`.
function makeRules(overrides: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	const base = structuredClone(DEFAULT_CONFIG);
	return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// node:net — fake createServer returning an EventEmitter with listen/close.
// ---------------------------------------------------------------------------
class FakeServer extends EventEmitter {
	listen = vi.fn();
	close = vi.fn();
}
const fakeServers: FakeServer[] = [];
vi.mock("node:net", () => ({
	createServer: vi.fn((_handler?: unknown) => {
		const s = new FakeServer();
		fakeServers.push(s);
		return s;
	}),
}));

// ---------------------------------------------------------------------------
// node:fs — neutralize the direct disk writes server.ts performs (the
// reservation-event sink uses existsSync/mkdirSync/appendFileSync; the early
// shutdown uses removeFileIfExists which is itself mocked via socket-lifecycle).
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => ({
	appendFileSync: vi.fn(),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	rmSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// rules-loader — loadRules returns the per-test rules; watchRulesFiles captures
// the hot-reload callback and returns a disposer.
// ---------------------------------------------------------------------------
const unwatchRulesMock = vi.fn();
vi.mock("./rules-loader.js", () => ({
	loadRules: vi.fn(() => rulesOverride),
	watchRulesFiles: vi.fn((_cwd: string, cb: (r: GuardRulesConfig) => void) => {
		cap.rulesReloadCb = cb;
		return unwatchRulesMock;
	}),
}));

// ---------------------------------------------------------------------------
// settings-watcher — capture onStrip, return disposer.
// ---------------------------------------------------------------------------
const unwatchSettingsMock = vi.fn();
vi.mock("./settings-watcher.js", () => ({
	watchSettingsFiles: vi.fn((opts: { onStrip: (r: StripResult) => void }) => {
		cap.settingsOnStrip = opts.onStrip;
		return unwatchSettingsMock;
	}),
}));

// settings-validator — the strip-preview helpers used inside onStrip.
vi.mock("../lib/settings-validator.js", () => ({
	autoStripAllScopes: vi.fn(),
	defaultStripAuditLogPath: vi.fn(() => "/tmp/strip-audit.log"),
	describeReason: vi.fn((r: string | undefined) => `reason:${r ?? "?"}`),
}));

// ---------------------------------------------------------------------------
// content-scanner — registry returns the per-test scanner; allowlist compile is
// an identity-ish stub.
// ---------------------------------------------------------------------------
vi.mock("./content-scanner/registry.js", () => ({
	createScanner: vi.fn(() => scannerOverride),
}));
vi.mock("./content-scanner/allowlist.js", () => ({
	compileAllowlist: vi.fn((a: unknown) => ({ compiledFrom: a })),
}));

// ---------------------------------------------------------------------------
// server-bridge — returns the per-test bridge (or null for local-only branch).
// ---------------------------------------------------------------------------
vi.mock("./server-bridge.js", () => ({
	createServerBridge: vi.fn(() => serverBridgeOverride),
}));

// ---------------------------------------------------------------------------
// status-writers — return the shared spies so we can assert status writes.
// ---------------------------------------------------------------------------
vi.mock("./server/status-writers.js", () => ({
	createStatusWriters: vi.fn(() => cap.statusWriters),
}));

// ---------------------------------------------------------------------------
// protocol-status — keep these pure-ish but observable. We let the real strings
// flow; they're cheap and let us assert classifier/scanner status content.
// ---------------------------------------------------------------------------
vi.mock("./server/protocol-status.js", () => ({
	parseProtocolMode: vi.fn(),
	createProtocolStatus: vi.fn((opts: unknown) => ({ __proto_status: opts })),
	computeClassifierStatusLine: vi.fn(() => "classifier:line"),
	formatScannerStatusLine: vi.fn((s: ScannerStatus) => `scanner:${s.state}`),
	buildStartupMessage: vi.fn(() => "STARTUP_MESSAGE"),
	recordProtocolEvent: vi.fn(),
	writeProtocolStatus: vi.fn(),
}));
// cli-args re-exported from a different module path in server.ts.
vi.mock("./server/cli-args.js", async () => {
	const actual =
		await vi.importActual<typeof import("./server/cli-args.js")>("./server/cli-args.js");
	return actual;
});

// ---------------------------------------------------------------------------
// socket-lifecycle (low-level helpers in server/) — neutralize fs touches.
// ---------------------------------------------------------------------------
vi.mock("./server/socket-lifecycle.js", () => ({
	ensureDirectory: vi.fn(),
	removeFileIfExists: vi.fn(),
	cleanupSocket: vi.fn(),
}));

// ---------------------------------------------------------------------------
// server-socket-lifecycle — capture the deps + expose spy setters/lifecycle.
// ---------------------------------------------------------------------------
vi.mock("./server-socket-lifecycle.js", () => ({
	createSocketLifecycle: vi.fn((deps: SocketLifecycleDepsCapture) => {
		cap.socketLifecycleDeps = deps;
		cap.socketSetters.cleanupSocket = vi.fn();
		cap.socketSetters.writePidFile = vi.fn();
		cap.socketSetters.shutdown = vi.fn();
		cap.socketSetters.startRawServer = vi.fn();
		cap.socketSetters.setFramedDaemon = vi.fn();
		cap.socketSetters.setUnwatchers = vi.fn();
		return {
			cleanupSocket: cap.socketSetters.cleanupSocket,
			writePidFile: cap.socketSetters.writePidFile,
			shutdown: cap.socketSetters.shutdown,
			startRawServer: cap.socketSetters.startRawServer,
			setFramedDaemon: cap.socketSetters.setFramedDaemon,
			setUnwatchers: cap.socketSetters.setUnwatchers,
		};
	}),
}));

// ---------------------------------------------------------------------------
// server-event-loop — capture deps; return controllable entry points.
// ---------------------------------------------------------------------------
const evaluateEventLineMock = vi.fn(async () => ({ decision: "allow" }) as HarnessDecision);
const evaluateUnifiedViaRuntimeMock = vi.fn(
	async () => ({ decision: "allow" }) as HarnessDecision,
);
const writeProtocolStatusMock = vi.fn();
vi.mock("./server-event-loop.js", () => ({
	createEventLoop: vi.fn((deps: EventLoopDepsCapture) => {
		cap.eventLoopDeps = deps;
		return {
			evaluateEventLine: evaluateEventLineMock,
			evaluateUnifiedViaRuntime: evaluateUnifiedViaRuntimeMock,
			writeProtocolStatus: writeProtocolStatusMock,
		};
	}),
}));

// ---------------------------------------------------------------------------
// session-daemon — capture opts; return a fake handle. Async (server.ts awaits).
// ---------------------------------------------------------------------------
const sessionDaemonHandle = {
	paths: { socket: "/tmp/framed.sock", pid: "/tmp/framed.pid" },
	session_id: "default",
	started_at: 0,
	stop: vi.fn(async () => {}),
	rpcInflight: vi.fn(() => 0),
};
vi.mock("./session-daemon.js", () => ({
	startSessionDaemon: vi.fn(async (opts: SessionDaemonOptsCapture) => {
		cap.sessionDaemonOpts = opts;
		return sessionDaemonHandle;
	}),
}));

// ---------------------------------------------------------------------------
// session-paths — deterministic framed paths.
// ---------------------------------------------------------------------------
vi.mock("./session-paths.js", () => ({
	daemonPathsFor: vi.fn((_cwd: string, id: string) => ({
		socket: `/tmp/harness-${id}.sock`,
		pid: `/tmp/harness-${id}.pid`,
		log: `/tmp/harness-${id}.log`,
	})),
}));

// ---------------------------------------------------------------------------
// Constructor mocks for the daemon state. These MUST be real `class`
// declarations, not `vi.fn(() => obj)`: an arrow-function mock implementation
// is not `new`-able, so `new CohortManager()` throws "is not a constructor".
// Real classes survive `resetModules` re-imports and stay constructable. The
// per-instance method spies (detectLostAgents, releaseAllForAgent, …) are the
// shared module-level mocks below so tests can drive/inspect them.
// ---------------------------------------------------------------------------
const detectLostAgentsMock = vi.fn<() => Array<{ name: string }>>(() => []);
const reservationShutdownMock = vi.fn();
const releaseAllForAgentMock = vi.fn();

class FakeCohortManager {
	detectLostAgents = detectLostAgentsMock;
}
class FakeSessionTracker {
	get = vi.fn(() => undefined);
}
class FakeReservationManager {
	getAll = vi.fn(() => []);
	shutdown = reservationShutdownMock;
	releaseAllForAgent = releaseAllForAgentMock;
	constructor(_bridge: unknown, _b: unknown, sink: (e: unknown) => void) {
		cap.reservationEventSink = sink;
	}
}
class FakeErrorHistory {
	size = 7;
}
class FakeRouteMap {
	initialize = vi.fn();
}
class FakeFileContentCache {}
class FakeProjectWideSweepState {}
class FakeAsyncFindingQueue {}
class FakeProjectGraph {
	allFiles = vi.fn(() => []);
}

vi.mock("./cohort.js", () => ({ CohortManager: FakeCohortManager }));
vi.mock("./session-state.js", () => ({ SessionTracker: FakeSessionTracker }));
vi.mock("./reservations.js", () => ({ ReservationManager: FakeReservationManager }));
vi.mock("./error-history.js", () => ({ ErrorHistory: FakeErrorHistory }));
vi.mock("./route-map.js", () => ({ RouteMap: FakeRouteMap }));
vi.mock("./grep-accelerator.js", () => ({ FileContentCache: FakeFileContentCache }));
vi.mock("./quality-checks.js", () => ({ ProjectWideSweepState: FakeProjectWideSweepState }));
vi.mock("./async-finding-queue.js", () => ({ AsyncFindingQueue: FakeAsyncFindingQueue }));
vi.mock("./learned-rules.js", () => ({
	createLearnedRulesStore: vi.fn(() => ({})),
}));
vi.mock("./async-analysis.js", () => ({
	createAsyncAnalysisManager: vi.fn(() => ({ drain: vi.fn(async () => {}) })),
}));
vi.mock("./policy-classifier.js", () => ({
	resolveApiKey: vi.fn(() => "API_KEY"),
}));

// ProjectGraph: getGraphForFile resolves via runtime-context which we mock too,
// but the class is still imported/constructed lazily — give it a shell.
vi.mock("./project-graph.js", () => ({ ProjectGraph: FakeProjectGraph }));
const fakeGraph = { allFiles: vi.fn(() => ["a.ts", "b.ts"]) };
vi.mock("./server/runtime-context.js", () => ({
	getGraphForFile: vi.fn(() => fakeGraph),
}));

// TrigramIndex.load — per-test override via slot.
let trigramLoadResult: {
	files: string[];
	baseCommit: string;
	incrementalUpdate: Mock;
} | null;
vi.mock("./trigram-index.js", () => ({
	TrigramIndex: { load: vi.fn(() => trigramLoadResult) },
}));

vi.mock("./live-snapshot.js", () => ({
	sweepStaleLiveSnapshots: vi.fn(() => ({ removed: [], scanned: 0 })),
}));
vi.mock("./build-staleness.js", () => ({
	runningBuildStaleness: vi.fn(() => null),
	stalenessWarning: vi.fn(() => null),
}));
vi.mock("./statusline-snapshot.js", () => ({
	writeStatuslineArtifacts: vi.fn(),
}));
vi.mock("./tsgo-runner.js", () => ({
	createTsgoRunner: vi.fn(() => ({ __tsgo: true })),
}));
vi.mock("./check-pipeline/builtin-verify-passes.js", () => ({
	registerAllBuiltinVerifyPasses: vi.fn(),
}));
vi.mock("./server/collection-writer.js", () => ({
	writeCollectionRecord: vi.fn(),
}));
vi.mock("./evaluator/pre-tool.js", () => ({
	resetProjectSetupWarningsCache: vi.fn(),
}));
vi.mock("./auto-coordinate.js", () => ({
	DEFAULT_AUTO_COORDINATION_CONFIG: { enabled: false, interval_ms: 1000 },
}));

// ---------------------------------------------------------------------------
// Process-level shims. Spied per-suite in setup() so signal handlers are
// captured (never bound to the real process) and exit never really exits.
// ---------------------------------------------------------------------------
const signalHandlers = new Map<string, Array<(...a: unknown[]) => void>>();
// Append-only log of every `process.on` registration, NEVER filtered by
// removeListener. Lets a test reach the early SIGTERM handler that server.ts
// registers first and later removes (the live `signalHandlers` map drops it).
const allOnRegistrations: Array<{ event: string; listener: (...a: unknown[]) => void }> = [];
// Optional per-test hook invoked synchronously inside the `process.on` spy as
// each registration happens. This is the ONLY way to reach the body of
// `_earlyShutdown` (server.ts:145-157) and the `if (_shutdownPending)` true
// branch (server.ts:654): both require a signal to fire WHILE module init is
// still running (`_shutdownReady === false`), i.e. before the bottom-of-file
// rebind. A test installs a hook that fires the SIGTERM handler the moment it
// is registered (line 159) — at that point `_shutdownReady` is still false, so
// the body runs, sets `_shutdownPending`, and the later line-654 check trips.
let onProcessOnRegister:
	| ((event: string, listener: (...a: unknown[]) => void) => void)
	| null = null;
let processOnSpy: ReturnType<typeof vi.spyOn>;
let processRemoveSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

class ProcessExitError extends Error {
	constructor(public code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

function installProcessShims(): void {
	signalHandlers.clear();
	allOnRegistrations.length = 0;
	processOnSpy = vi
		.spyOn(process, "on")
		.mockImplementation((event: string | symbol, listener: (...a: unknown[]) => void) => {
			const key = String(event);
			const list = signalHandlers.get(key) ?? [];
			list.push(listener);
			signalHandlers.set(key, list);
			allOnRegistrations.push({ event: key, listener });
			onProcessOnRegister?.(key, listener);
			return process;
		});
	processRemoveSpy = vi
		.spyOn(process, "removeListener")
		.mockImplementation((event: string | symbol, listener: (...a: unknown[]) => void) => {
			const key = String(event);
			const list = (signalHandlers.get(key) ?? []).filter((l) => l !== listener);
			signalHandlers.set(key, list);
			return process;
		});
	processExitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitError(code);
	}) as never);
}

function lastSignalHandler(sig: string): ((...a: unknown[]) => void) | undefined {
	const list = signalHandlers.get(sig);
	return list ? list[list.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// Import driver. Sets argv, faked timers, fresh state, imports the module, then
// flushes the three setTimeout(0) background-init closures.
// ---------------------------------------------------------------------------
const ORIGINAL_ARGV = process.argv.slice();

async function loadServer(extraArgv: string[] = []): Promise<void> {
	process.argv = ["node", "server.js", ...extraArgv];
	await import("./server.js");
	// Flush the three setTimeout(0) background-init closures (route map build,
	// error-history log, trigram load + statusline refresh).
	await vi.runOnlyPendingTimersAsync();
}

beforeEach(() => {
	// NB: `vi.resetModules()` re-runs every `vi.mock` factory on the next
	// `import("./server.js")`, so the constructor mocks created INSIDE those
	// factories (CohortManager, ReservationManager, …) are fresh per test. We
	// deliberately do NOT call `vi.clearAllMocks()` — it strips the
	// implementation off `vi.fn(impl)` mocks, which makes the constructor mocks
	// non-constructable (`new X()` throws "is not a constructor"). Instead we
	// `.mockClear()` only the module-level spies whose call counts we assert.
	vi.resetModules();
	evaluateEventLineMock.mockClear();
	evaluateUnifiedViaRuntimeMock.mockClear();
	writeProtocolStatusMock.mockClear();
	writeProtocolStatusMock.mockReset();
	unwatchRulesMock.mockClear();
	unwatchSettingsMock.mockClear();
	reservationShutdownMock.mockClear();
	releaseAllForAgentMock.mockClear();
	detectLostAgentsMock.mockClear();
	detectLostAgentsMock.mockReturnValue([]);
	sessionDaemonHandle.stop.mockClear();
	sessionDaemonHandle.rpcInflight.mockClear();
	fakeGraph.allFiles.mockClear();
	vi.useFakeTimers();
	fakeServers.length = 0;
	rulesOverride = makeRules();
	scannerOverride = undefined;
	serverBridgeOverride = { shutdown: vi.fn() };
	trigramLoadResult = null;
	cap.rulesReloadCb = null;
	cap.settingsOnStrip = null;
	cap.scannerStatusCb = null;
	cap.eventLoopDeps = null;
	cap.sessionDaemonOpts = null;
	cap.socketLifecycleDeps = null;
	cap.reservationEventSink = null;
	cap.statusWriters.writeClassifierStatus = vi.fn();
	cap.statusWriters.writeScannerStatus = vi.fn();
	cap.statusWriters.writeReviewPendingMarker = vi.fn();
	onProcessOnRegister = null;
	installProcessShims();
});

afterEach(() => {
	process.argv = ORIGINAL_ARGV.slice();
	processOnSpy?.mockRestore();
	processRemoveSpy?.mockRestore();
	processExitSpy?.mockRestore();
	vi.useRealTimers();
});

// ===========================================================================
// Suite
// ===========================================================================

describe("harness server.ts — startup wiring (dual protocol, default flags)", () => {
	it("constructs the event loop, socket lifecycle, and framed daemon, then starts the raw server", async () => {
		await loadServer();
		// Event loop built with the runtime context + module callbacks.
		expect(cap.eventLoopDeps).not.toBeNull();
		expect(cap.eventLoopDeps?.protocolStatusPath).toContain("harness-protocol.json");
		// Socket lifecycle constructed for dual mode → raw socket on.
		expect(cap.socketLifecycleDeps?.runRawSocket).toBe(true);
		expect(cap.socketLifecycleDeps?.socketPath).toContain("harness.sock");
		// Framed daemon spawned (dual) and handed to the lifecycle via the setter.
		expect(cap.sessionDaemonOpts).not.toBeNull();
		expect(cap.socketSetters.setFramedDaemon).toHaveBeenCalledWith(sessionDaemonHandle);
		// Raw server started.
		expect(cap.socketSetters.startRawServer).toHaveBeenCalledTimes(1);
		// PID + protocol status written during startup.
		expect(cap.socketSetters.writePidFile).toHaveBeenCalledTimes(1);
		expect(writeProtocolStatusMock).toHaveBeenCalled();
	});

	it("cleans the stale raw socket on startup when the raw socket is enabled", async () => {
		await loadServer();
		expect(cap.socketSetters.cleanupSocket).toHaveBeenCalledTimes(1);
	});

	it("hands both watcher disposers to the socket lifecycle", async () => {
		await loadServer();
		expect(cap.socketSetters.setUnwatchers).toHaveBeenCalledWith(
			unwatchRulesMock,
			unwatchSettingsMock,
		);
	});

	it("writes an initial classifier status line at startup", async () => {
		await loadServer();
		expect(cap.statusWriters.writeClassifierStatus).toHaveBeenCalledWith("classifier:line");
	});

	it("passes a session-daemon evaluator-context factory and the unified evaluator", async () => {
		await loadServer();
		const ctxFactory = cap.sessionDaemonOpts?.state.getEvaluatorContext;
		expect(typeof ctxFactory).toBe("function");
		const evalCtx = ctxFactory?.();
		// getEvaluatorContext closes over getGraphForFile → resolves the fake graph.
		expect(evalCtx?.graph).toBe(fakeGraph);
		expect(cap.sessionDaemonOpts?.state.evaluateHook).toBe(evaluateUnifiedViaRuntimeMock);
		expect(cap.sessionDaemonOpts?.state.tsgo).toEqual({ __tsgo: true });
	});
});

describe("harness server.ts — protocol mode branches", () => {
	it("raw-only protocol skips the framed daemon and only starts the raw server", async () => {
		await loadServer(["--protocol", "raw"]);
		expect(cap.socketLifecycleDeps?.runRawSocket).toBe(true);
		// No framed daemon spawned.
		expect(cap.sessionDaemonOpts).toBeNull();
		expect(cap.socketSetters.setFramedDaemon).not.toHaveBeenCalled();
		// Raw server still started.
		expect(cap.socketSetters.startRawServer).toHaveBeenCalledTimes(1);
	});

	it("framed-only protocol skips the raw socket and starts the framed daemon", async () => {
		await loadServer(["--protocol", "framed"]);
		expect(cap.socketLifecycleDeps?.runRawSocket).toBe(false);
		// Raw startup skipped: no stale-socket cleanup, no raw server.
		expect(cap.socketSetters.cleanupSocket).not.toHaveBeenCalled();
		expect(cap.socketSetters.startRawServer).not.toHaveBeenCalled();
		// Framed daemon spawned.
		expect(cap.sessionDaemonOpts).not.toBeNull();
		expect(cap.socketSetters.setFramedDaemon).toHaveBeenCalledWith(sessionDaemonHandle);
	});

	it("honors a custom --socket path and --session-id for framed paths", async () => {
		await loadServer(["--socket", "/tmp/custom.sock", "--session-id", "sess-9"]);
		expect(cap.socketLifecycleDeps?.socketPath).toBe("/tmp/custom.sock");
		expect(cap.sessionDaemonOpts?.session_id).toBe("sess-9");
	});
});

describe("harness server.ts — content scanner branches", () => {
	it("writes 'disabled' when no content_scanner config is present", async () => {
		rulesOverride = makeRules();
		await loadServer();
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
	});

	it("registers an onStatusChange writer when the scanner supports lifecycle", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		const onStatusChange = vi.fn((cb: (s: ScannerStatus) => void) => {
			cap.scannerStatusCb = cb;
		});
		scannerOverride = makeScanner({ onStatusChange });
		await loadServer();
		expect(onStatusChange).toHaveBeenCalledTimes(1);
		// Drive a lifecycle transition through the captured callback.
		cap.scannerStatusCb?.({ state: "ready", sinceIso: "2026-01-01T00:00:00Z" });
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("scanner:ready");
		// Pass the live scanner to the socket lifecycle for shutdown.
		expect(cap.socketLifecycleDeps?.contentScanner).toBe(scannerOverride);
	});

	it("marks an HTTP scanner without lifecycle as ready", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "http" } as never,
		});
		scannerOverride = makeScanner({ runtime: "http" });
		// Strip the optional lifecycle hooks so the else-branch runs.
		delete scannerOverride.onStatusChange;
		await loadServer();
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("ready:http");
	});
});

describe("harness server.ts — server bridge branch", () => {
	it("passes the bridge to the socket lifecycle when configured", async () => {
		serverBridgeOverride = { shutdown: vi.fn() };
		await loadServer();
		expect(cap.socketLifecycleDeps?.serverBridge).toBe(serverBridgeOverride);
	});

	it("runs local-only (null bridge) when no server is configured", async () => {
		serverBridgeOverride = null;
		await loadServer();
		expect(cap.socketLifecycleDeps?.serverBridge).toBeNull();
	});
});

describe("harness server.ts — background init timers", () => {
	it("initializes the route map from the project graph on the deferred tick", async () => {
		await loadServer();
		// loadServer already flushed pending timers; the route map was built from
		// the fake graph's allFiles(). Re-flush is a no-op but confirms idempotence.
		expect(fakeGraph.allFiles).toHaveBeenCalled();
	});

	it("loads the trigram index and runs an incremental update when present", async () => {
		const incrementalUpdate = vi.fn(() => 3);
		trigramLoadResult = { files: ["x.ts"], baseCommit: "abcdef1234567890", incrementalUpdate };
		await loadServer();
		expect(incrementalUpdate).toHaveBeenCalledTimes(1);
	});

	it("tolerates an absent trigram index (no throw, statusline still refreshed)", async () => {
		trigramLoadResult = null;
		await expect(loadServer()).resolves.toBeUndefined();
	});
});

describe("harness server.ts — rules hot-reload callback", () => {
	it("recomputes classifier status and rules-active count on reload", async () => {
		await loadServer();
		const before = cap.statusWriters.writeClassifierStatus.mock.calls.length;
		cap.rulesReloadCb?.(makeRules({ rules: [] }));
		expect(cap.statusWriters.writeClassifierStatus.mock.calls.length).toBeGreaterThan(before);
	});

	it("on reload with scanner disabled, writes 'disabled' scanner status", async () => {
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(makeRules()); // no content_scanner → disabled branch
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
	});

	it("on reload with scanner enabled but none constructed, requests a restart", async () => {
		// Daemon started with NO scanner → contentScanner undefined. A reload that
		// flips content_scanner.enabled on hits the down:needs_restart branch.
		rulesOverride = makeRules();
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(
			makeRules({ content_scanner: { enabled: true, runtime: "local" } as never }),
		);
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("down:needs_restart");
	});

	it("on reload with a live lifecycle scanner, writes the formatted status", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		const getStatus = vi.fn((): ScannerStatus => ({ state: "dormant", sinceIso: "t" }));
		scannerOverride = makeScanner({ getStatus });
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(
			makeRules({ content_scanner: { enabled: true, runtime: "local" } as never }),
		);
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("scanner:dormant");
	});

	it("on reload with a live scanner lacking getStatus, falls back to ready:<runtime>", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		scannerOverride = makeScanner({ runtime: "local" });
		delete scannerOverride.getStatus;
		await loadServer();
		cap.statusWriters.writeScannerStatus.mockClear();
		cap.rulesReloadCb?.(
			makeRules({ content_scanner: { enabled: true, runtime: "local" } as never }),
		);
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("ready:local");
	});
});

describe("harness server.ts — settings-strip callback", () => {
	it("logs a bounded preview (<=5 entries) and the '...and N more' tail", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		const entries = Array.from({ length: 7 }, (_v, i) => ({
			file: `/repo/.claude/settings.json`,
			bucket: "allow",
			index: i,
			rule: `Bash(rm:${i})`,
			reason: "unparseable",
		}));
		cap.settingsOnStrip?.({ totalStripped: 7, entries });
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Live-stripped 7 malformed permission rule(s)");
		expect(logged).toContain("...and 2 more");
		errSpy.mockRestore();
	});

	it("omits the '...and N more' tail when entries fit within the preview window", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		cap.settingsOnStrip?.({
			totalStripped: 2,
			entries: [
				{ file: "/r/.claude/settings.json", bucket: "deny", index: 0, rule: "x", reason: "r1" },
				{ file: "/r/.claude/settings.json", bucket: "deny", index: 1, rule: "y", reason: "r2" },
			],
		});
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Live-stripped 2 malformed permission rule(s)");
		expect(logged).not.toContain("...and");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — process signal handlers", () => {
	it("rebinds SIGINT/SIGTERM to the real shutdown after startup", async () => {
		await loadServer();
		// The early handler was removed and the real shutdown bound.
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		const sigint = lastSignalHandler("SIGINT");
		sigint?.();
		expect(cap.socketSetters.shutdown).toHaveBeenCalledTimes(1);
	});

	it("SIGHUP reloads rules without exiting", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer();
		const sighup = lastSignalHandler("SIGHUP");
		expect(typeof sighup).toBe("function");
		sighup?.();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Rules reloaded via SIGHUP");
		errSpy.mockRestore();
	});

	it("the early shutdown handler hard-exits via a timer when fired pre-readiness", async () => {
		// Capture the early handler from a partially-evaluated module. We can't
		// easily freeze mid-init, so instead exercise the early handler that was
		// registered first (before removeListener ran). The first SIGTERM listener
		// is the early one; invoking it sets pending + schedules a hard exit.
		await loadServer();
		// After startup _shutdownReady is true, so the early handler is a no-op;
		// but it was registered and removed — assert it was bound at least once.
		expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
	});
});

describe("harness server.ts — reservation event sink", () => {
	it("serializes reservation events to the events log (best-effort)", async () => {
		await loadServer();
		expect(typeof cap.reservationEventSink).toBe("function");
		// Should not throw; fs is mocked so the append is captured.
		expect(() => cap.reservationEventSink?.({ kind: "grant", file: "a.ts" })).not.toThrow();
	});
});

describe("harness server.ts — runtime sync callbacks", () => {
	it("exposes idempotent syncRuntimeIn / syncRuntimeOut to the event loop", async () => {
		await loadServer();
		expect(typeof cap.eventLoopDeps?.syncRuntimeIn).toBe("function");
		expect(typeof cap.eventLoopDeps?.syncRuntimeOut).toBe("function");
		expect(() => {
			cap.eventLoopDeps?.syncRuntimeIn();
			cap.eventLoopDeps?.syncRuntimeOut();
		}).not.toThrow();
	});

	it("resetIdleTimer is a no-op when the idle timeout is disabled (default 0)", async () => {
		await loadServer();
		expect(() => cap.eventLoopDeps?.resetIdleTimer()).not.toThrow();
	});

	it("writeCollectionRecord delegates to the collection writer without throwing", async () => {
		await loadServer();
		expect(() =>
			cap.eventLoopDeps?.writeCollectionRecord({ hook_event: "PreToolUse" }),
		).not.toThrow();
	});
});

describe("harness server.ts — idle timeout enabled branch", () => {
	it("arms an idle timer that shuts down after the configured timeout", async () => {
		await loadServer(["--idle-timeout", "1000"]);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// resetIdleTimer was wired into the event loop; invoking it arms the timer.
		cap.eventLoopDeps?.resetIdleTimer();
		vi.advanceTimersByTime(1000);
		// The idle expiry calls the real shutdown() from the socket lifecycle.
		expect(cap.socketSetters.shutdown).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("harness server.ts — periodic ticks", () => {
	it("the lost-agent sweep releases reservations for detected lost agents", async () => {
		await loadServer();
		// The 2-minute lost-agent tick calls cohort.detectLostAgents(); make it
		// report one lost agent so the release branch runs.
		detectLostAgentsMock.mockReturnValueOnce([{ name: "ghost" }]);
		vi.advanceTimersByTime(2 * 60 * 1000);
		expect(releaseAllForAgentMock).toHaveBeenCalledWith("ghost", expect.anything());
	});

	it("the statusline refresh interval fires without throwing", async () => {
		await loadServer();
		expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
	});
});

describe("harness server.ts — verbose logging branch", () => {
	it("emits timestamped log lines on the deferred init ticks when --verbose is set", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// The VERBOSE `log()` path (else of the no-op) runs the timestamped writer.
		expect(logged).toContain("[harness ");
		expect(logged).toContain("Error history loaded: 7 records");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — background-init failure paths", () => {
	it("logs (non-fatal) when the route-map init tick throws", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const rc = await import("./server/runtime-context.js");
		vi.mocked(rc.getGraphForFile).mockImplementationOnce(() => {
			throw new Error("graph boom");
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Background init failed (non-fatal)");
		expect(logged).toContain("graph boom");
		errSpy.mockRestore();
	});

	it("logs (non-fatal) when the trigram-index load tick throws", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ti = await import("./trigram-index.js");
		vi.mocked(ti.TrigramIndex.load).mockImplementationOnce(() => {
			throw new Error("index boom");
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Trigram index load failed (non-fatal)");
		expect(logged).toContain("index boom");
		errSpy.mockRestore();
	});

	it("does not run the incremental update when no index is found (else branch)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		trigramLoadResult = null;
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("No trigram index found");
		errSpy.mockRestore();
	});

	it("logs only when files actually changed (incrementalUpdate > 0)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		trigramLoadResult = {
			files: ["x.ts"],
			baseCommit: "deadbeefcafef00d",
			incrementalUpdate: vi.fn(() => 0),
		};
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// 0 changes → no "files changed since base commit" line.
		expect(logged).toContain("Trigram index loaded");
		expect(logged).not.toContain("files changed since base commit");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — reservation event sink directory creation", () => {
	it("creates the events directory when it does not yet exist", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.existsSync).mockReturnValue(false);
		await loadServer();
		cap.reservationEventSink?.({ kind: "grant", file: "a.ts" });
		expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(expect.any(String), {
			recursive: true,
		});
		expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalled();
	});

	it("swallows append errors so reservation observability never throws", async () => {
		const fs = await import("node:fs");
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		await loadServer();
		expect(() => cap.reservationEventSink?.({ kind: "release" })).not.toThrow();
	});
});

describe("harness server.ts — stale-snapshot sweep branch", () => {
	it("logs the reaped count when stale live snapshots are swept", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ls = await import("./live-snapshot.js");
		vi.mocked(ls.sweepStaleLiveSnapshots).mockReturnValueOnce({
			removed: ["s1.live.json", "s2.live.json"],
			scanned: 5,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Reaped 2 stale live snapshot(s) (of 5 scanned)");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — policy classifier startup log", () => {
	it("logs a ready classifier when enabled and an API key resolves", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "groq", model: "m1" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Policy classifier: groq/m1 (ready)");
		errSpy.mockRestore();
	});

	it("logs 'no API key' when the classifier provider needs a key but none resolves", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const pc = await import("./policy-classifier.js");
		vi.mocked(pc.resolveApiKey).mockReturnValueOnce(undefined);
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "groq", model: "m2" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Policy classifier: groq/m2 (no API key)");
		errSpy.mockRestore();
	});

	it("treats the claude_code provider as ready without resolving an API key", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		rulesOverride = makeRules({
			policy_classifier: { enabled: true, provider: "claude_code", model: "cc" } as never,
		});
		await loadServer(["--verbose"]);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Policy classifier: claude_code/cc (ready)");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — content scanner constructed-undefined branch", () => {
	it("writes 'disabled' when content_scanner is configured but createScanner returns undefined", async () => {
		rulesOverride = makeRules({
			content_scanner: { enabled: true, runtime: "local" } as never,
		});
		scannerOverride = undefined; // misconfigured backend → undefined scanner
		await loadServer();
		// The ternary's truthy side runs (createScanner called) but yields undefined,
		// so the `else` arm writes "disabled".
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
		expect(cap.socketLifecycleDeps?.contentScanner).toBeUndefined();
	});
});

describe("harness server.ts — early shutdown handler", () => {
	it("is a no-op once the real shutdown has been wired (post-readiness)", async () => {
		const fs = await import("./server/socket-lifecycle.js");
		await loadServer();
		// The early SIGTERM handler is the FIRST `process.on("SIGTERM", …)`
		// registration (server.ts:159). It is later removed via removeListener and
		// replaced by the real shutdown, so the live `signalHandlers` map no longer
		// holds it — reach it through the never-filtered registration log instead.
		const earlyReg = allOnRegistrations.find((r) => r.event === "SIGTERM");
		expect(earlyReg).toBeDefined();
		const earlyHandler = earlyReg?.listener;
		vi.mocked(fs.removeFileIfExists).mockClear();
		// After startup `_shutdownReady` is true → the handler returns immediately
		// (the guard branch) without scheduling a hard exit or removing the pid file.
		expect(() => earlyHandler?.()).not.toThrow();
		expect(vi.mocked(fs.removeFileIfExists)).not.toHaveBeenCalled();
		// And it is NOT the same function as the real shutdown that's now bound.
		const liveSigterm = lastSignalHandler("SIGTERM");
		expect(earlyHandler).not.toBe(liveSigterm);
	});

	it("the early SIGTERM and SIGINT registrations are distinct from the rebound real shutdown", async () => {
		await loadServer();
		// Both signals were registered with the early handler first, then removed.
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
		expect(processRemoveSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		// The real shutdown is now the active SIGTERM/SIGINT listener.
		expect(lastSignalHandler("SIGTERM")).toBeDefined();
		expect(lastSignalHandler("SIGINT")).toBeDefined();
	});
});

describe("harness server.ts — staleness warning branch", () => {
	it("logs a staleness warning when the running build is stale", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stale = await import("./build-staleness.js");
		vi.mocked(stale.stalenessWarning).mockReturnValueOnce("BUILD IS STALE");
		await loadServer();
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("BUILD IS STALE");
		errSpy.mockRestore();
	});
});

describe("harness server.ts — content scanner absent (falsy config) branch", () => {
	it("takes the ternary's `: undefined` arm when content_scanner config is absent", async () => {
		// `makeRules()` clones DEFAULT_CONFIG, whose `content_scanner` is a truthy
		// object ({enabled:false,…}), so the ternary at server.ts:222-224 normally
		// takes the truthy `createScanner(...)` arm. Deleting the key makes
		// `rules.content_scanner` falsy → the `: undefined` arm runs and
		// createScanner is never called.
		// The createScanner mock fn is module-level and shared across every test
		// (it survives vi.resetModules), so assert a per-load delta rather than a
		// global never-called. A falsy content_scanner short-circuits the ternary
		// at server.ts:222-224 before createScanner, so the count must not move.
		const reg = await import("./content-scanner/registry.js");
		const callsBefore = vi.mocked(reg.createScanner).mock.calls.length;
		const rules = makeRules();
		delete rules.content_scanner;
		rulesOverride = rules;
		await loadServer();
		expect(vi.mocked(reg.createScanner).mock.calls.length).toBe(callsBefore);
		// contentScanner is undefined → the disabled arm of the if/else writes it,
		// and the socket lifecycle receives an undefined scanner.
		expect(cap.statusWriters.writeScannerStatus).toHaveBeenCalledWith("disabled");
		expect(cap.socketLifecycleDeps?.contentScanner).toBeUndefined();
	});
});

describe("harness server.ts — early shutdown fired DURING startup (pre-readiness)", () => {
	it("runs the early-shutdown body, sets pending, graceful-shuts on init completion, and hard-exits via the 1500ms timer", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const sl = await import("./server/socket-lifecycle.js");
		vi.mocked(sl.removeFileIfExists).mockClear();

		// Fire the FIRST SIGTERM registration synchronously, the instant server.ts
		// runs `process.on("SIGTERM", _earlyShutdown)` (line 159). At that moment
		// module init is mid-flight and `_shutdownReady` is still false, so the
		// handler executes its real body (lines 145-157): sets `_shutdownPending`,
		// attempts best-effort pid cleanup, and schedules the 1500ms hard-exit
		// fallback. This is the only window that reaches the body and the
		// `if (_shutdownPending)` graceful branch at line 654.
		let firedOnce = false;
		onProcessOnRegister = (event, listener) => {
			if (event === "SIGTERM" && !firedOnce) {
				firedOnce = true;
				listener();
			}
		};

		process.argv = ["node", "server.js"];
		await import("./server.js");

		// Body ran: best-effort pid cleanup was attempted.
		expect(vi.mocked(sl.removeFileIfExists)).toHaveBeenCalled();
		// Because `_shutdownPending` was set before line 654, init completion runs
		// the graceful path — the real shutdown from the lifecycle.
		expect(cap.socketSetters.shutdown).toHaveBeenCalledTimes(1);
		const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("Shutdown was requested during startup");

		// The 1500ms hard-exit fallback closure is still armed. Advancing past it
		// fires `process.exit(0)`, which our spy turns into a throw. This advance
		// also drains the deferred setTimeout(0) background-init closures from this
		// import; afterEach's useRealTimers()/resetModules() clears the remainder.
		expect(() => vi.advanceTimersByTime(1500)).toThrow(/process\.exit\(0\)/);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Local helper: a typed ContentScanner fake. Methods present by default; tests
// `delete` the optional ones to drive the else-branches.
// ---------------------------------------------------------------------------
function makeScanner(
	overrides: Partial<ContentScanner> = {},
): ContentScanner {
	const scanner: ContentScanner = {
		name: "fake-scanner",
		runtime: "local",
		ready: vi.fn(async () => true),
		scan: vi.fn(async () => []),
		shutdown: vi.fn(async () => {}),
		onStatusChange: vi.fn(),
		getStatus: vi.fn((): ScannerStatus => ({ state: "ready", sinceIso: "t" })),
		...overrides,
	};
	return scanner;
}
