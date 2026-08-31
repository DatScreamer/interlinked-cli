#!/usr/bin/env node
// ===========================================
// Hook entry — thin client the installer wires into every runner
// ===========================================
// 1. Parse stdin JSON (the runner's native payload).
// 2. Detect adapter (INTERLINKED_RUNNER env → --runner arg → env heuristic).
// 3. Build a UnifiedHookEvent via the adapter.
// 4. Discover the daemon socket.
// 5. Send RPC to daemon; wait within a hard deadline.
// 6. On socket error or timeout: run the cold fallback (inline checks).
// 7. Encode the decision via the adapter; write stdout/stderr; exit with code.
//
// This module is importable (for tests) and also runnable as a CLI script.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllAdapters, detectAdapter, getAdapter } from "./harness/adapters/index.js";
import type { RunnerAdapter } from "./harness/adapters/types.js";
import { createDaemonClient } from "./harness/daemon-client.js";
import { methodForPhase, type RpcMethod } from "./harness/daemon-protocol.js";
import { callLegacyHarness, isLegacyHarnessSocket } from "./harness/legacy-client.js";
import { recordPayloadKeys } from "./harness/payload-key-census.js";
import type { HarnessDecision } from "./harness/types.js";
import { resetSupervisorBackoff } from "./harness/supervisor-backoff.js";
import type { RunnerId, UnifiedHookEvent } from "./harness/unified-event.js";
import {
	coldDestructiveCommandBlockReason,
	coldGraphShardBlockReason,
	coldLargeFileBlockReason,
	coldMergeConflictBlockReason,
	coldPackageInstallBlockReason,
} from "./hook-entry-cold-gates.js";
import {
	attemptDaemonSelfHeal,
	coldDaemonUnreachableBlockReason,
	findRepoRoot,
} from "./hook-entry-daemon-gate.js";
import { coldDaemonUnreachableBlockReasonFresh } from "./hook-entry-daemon-probe.js";
import { defaultTimeoutForPhase, isCodeEditEvent } from "./hook-entry-deadlines.js";
import { attemptSelfHealOnStop } from "./hook-entry-stop-self-heal.js";
import { writeLastCheckArtifact, writeNoHarnessArtifact } from "./lib/last-check-writer.js";
import { nonNull } from "./lib/non-null.js";

// Re-export for back-compat: tests import these from "./hook-entry.js".
export { coldDaemonUnreachableBlockReason, isCodeEditEvent };

// Hook-socket transport variants. The legacy server uses newline-delimited
// JSON over a raw stream; the new server uses length-prefixed framing.
const HOOK_PROTOCOL_RAW = "raw";
const HOOK_PROTOCOL_FRAMED = "framed";
type HookProtocol = typeof HOOK_PROTOCOL_RAW | typeof HOOK_PROTOCOL_FRAMED;

export interface HookEntryOptions {
	/** The native hook event name the runner emitted. */
	nativeEventName: string;
	/** JSON payload from the runner's stdin. */
	nativeJson: unknown;
	/** Process environment — useful for tests to inject env. */
	env: NodeJS.ProcessEnv;
	/** Repo root to discover the daemon socket under. Defaults to cwd. */
	cwd?: string;
	/** Explicit runner id (overrides env detection). */
	runner?: RunnerId | undefined;
	/** Explicit socket path (overrides discovery). */
	socketPath?: string | undefined;
	/** Hard timeout for the daemon call. Defaults to 2s. */
	timeout_ms?: number;
}

export interface HookEntryResult {
	stdout?: string | undefined;
	stderr?: string | undefined;
	exit_code: number;
	/** True if the hook fell back to cold evaluation. */
	fell_back: boolean;
}

/** Run a single hook invocation end-to-end, returning the encoded output.
 *  Does not read from process.stdin or write to process.stdout — that is the
 *  CLI wrapper's job. Keeps the core logic easily testable. */
export async function runHookEntry(opts: HookEntryOptions): Promise<HookEntryResult> {
	const adapter = resolveAdapter(opts);
	if (!adapter) {
		const detail = opts.runner
			? `unknown runner id: ${opts.runner}`
			: "no runner detected from env; pass --runner=<id> or set INTERLINKED_RUNNER";
		return { stderr: `[interlinked] ${detail}\n`, exit_code: 0, fell_back: true };
	}

	let event: UnifiedHookEvent;
	event = tryBuildEvent(adapter, opts.nativeJson, opts.nativeEventName);

	const resolvedCwd = opts.cwd ?? process.cwd();
	// The daemon-liveness gate keys on the TOOL CALL's project (the event's
	// cwd), not the hook process's cwd — the hook may be spawned from anywhere
	// (a parent shell, a test harness), but `event.context.cwd` is the project
	// whose harness should be guarding this action.
	const gateCwd = event.context?.cwd ?? resolvedCwd;
	// Discover the socket in the SAME project the daemon gate keys on (the event's
	// cwd), not the hook process's cwd: a client that launches the hook binary
	// from outside the repo would otherwise miss the healthy daemon under the
	// event project and fall through to the fail-closed cold path on every call
	// (finding 2026-06).
	const socketPath = opts.socketPath ?? discoverSocket(gateCwd, event.session_id);
	if (!socketPath) {
		// No daemon available at all — cold fallback (which itself fails closed
		// when a daemon was running here and crashed; see encodeColdFallback).
		return await encodeColdFallback(adapter, event, "daemon socket not found", gateCwd, opts.env);
	}

	const method = methodForPhase(event.phase);
	const timeoutMs = opts.timeout_ms ?? defaultTimeoutForPhase(event);
	let decision: HarnessDecision;
	const fellBack = false;
	const protocol = resolveHookProtocol(socketPath, opts.env);
	const callStartMs = Date.now();
	const result =
		protocol === HOOK_PROTOCOL_RAW
			? await safeCallLegacy(socketPath, event, timeoutMs)
			: await safeCallDaemon({ socketPath, method, event, timeoutMs });
	if (result.ok) {
		decision = result.decision;
		// A served RPC proves the daemon is healthy, so every earlier failed
		// self-heal is history: clear the supervisor's backoff ladder. Without
		// this reset the decay would persist across a full recovery and delay
		// the NEXT real outage's first heal by up to a minute.
		resetSupervisorBackoff(dirname(dirname(socketPath)));
	} else {
		writeNoHarnessArtifact(dirname(socketPath), event, Date.now() - callStartMs);
		const cold = await encodeColdFallback(adapter, event, result.reason, gateCwd, opts.env);
		return cold;
	}

	// Feed the statusline's kinetic row (`.interlinked/last-check.txt`) —
	// the same artifact the generated .mjs hook writes. The socket lives at
	// <root>/.interlinked/harness.sock, so its dirname IS the data dir.
	writeLastCheckArtifact(dirname(socketPath), event, decision, Date.now() - callStartMs);

	const output = adapter.encodeDecision(decision, event);
	return {
		stdout: output.stdout,
		stderr: output.stderr,
		exit_code: output.exit_code,
		fell_back: fellBack,
	};
}

/** Entry point for CLI invocation — reads stdin, detects runner + event,
 *  writes stdout/stderr, exits with the adapter-decided code. Invoked by
 *  the IIFE at the bottom of the file when run as a script; not part of
 *  the importable surface (consumers should use `runHookEntry`). */
/**
 * Claude Code's Stop/SubagentStop re-entrancy contract: when the agent is
 * already continuing BECAUSE a stop hook fired, the runner sets
 * `stop_hook_active: true`, and the hook must yield. On a Stop event,
 * `hookSpecificOutput.additionalContext` is not a note — it is a continue
 * instruction — so a hook that keeps emitting it re-prompts the model forever.
 * Observed live (mcp-client-bio, 2026-07-28): "A hook blocked the turn from
 * ending 9 consecutive times — overriding and ending turn", every turn, until
 * the runner's cap force-ended it.
 *
 * This guard bounds the whole CLASS: whatever a future code path emits on
 * Stop, it gets exactly one pass — the first Stop of a turn arrives with the
 * flag unset, so every nudge still surfaces once — and the re-entry pass
 * yields unconditionally.
 */
export function isStopHookReentry(eventName: string, nativeJson: unknown): boolean {
	if (eventName !== "Stop" && eventName !== "SubagentStop") return false;
	if (!nativeJson || typeof nativeJson !== "object") return false;
	// Both casings: runners deliver snake_case OR camelCase for the same field
	// (this repo's payload-casing map lists this exact pair). Reading one casing
	// only would silently disable the guard under the other — and the loop this
	// guard exists to prevent would return for that runner alone.
	const raw = nativeJson as { stop_hook_active?: unknown; stopHookActive?: unknown };
	return raw.stop_hook_active === true || raw.stopHookActive === true;
}

async function mainFromStdin(): Promise<void> {
	const nativeJson = await readStdinJson();
	const nativeEventName = argOrEnv("--event") ?? process.env.INTERLINKED_EVENT ?? "PreToolUse";
	if (isStopHookReentry(nativeEventName, nativeJson)) process.exit(0);
	const runner = argOrEnv("--runner") ?? process.env.INTERLINKED_RUNNER;
	const socketPath = argOrEnv("--socket") ?? process.env.INTERLINKED_SOCKET;
	const result = await runHookEntry({
		nativeEventName,
		nativeJson,
		env: process.env,
		runner: runner as RunnerId | undefined,
		socketPath,
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exit(result.exit_code);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveAdapter(opts: HookEntryOptions): RunnerAdapter | null {
	const all = buildAllAdapters();
	if (opts.runner) return getAdapter(opts.runner, all);
	return detectAdapter(opts.env, all);
}

function tryBuildEvent(
	adapter: RunnerAdapter,
	nativeJson: unknown,
	nativeEventName: string,
): UnifiedHookEvent {
	// Adapters are tolerant of unknown fields and never throw; the wrapper
	// exists only as a single seam where a future caller can add fallback
	// behavior if adapter contracts change.
	const event: UnifiedHookEvent = adapter.parseHookInput(nativeJson, nativeEventName);
	// Census the payload keys the pipeline does NOT consume. This is the only
	// point that still holds the untruncated runner payload — everything
	// downstream sees the whitelisted subset — so a field a runner starts
	// sending is either noticed here or nowhere. Fail-open by contract.
	recordPayloadKeys({
		runner: adapter.id,
		nativeEvent: nativeEventName,
		raw: event.raw,
		cwd: event.context?.cwd ?? process.cwd(),
	});
	return event;
}

interface SafeCallDaemonArgs {
	socketPath: string;
	method: RpcMethod;
	event: UnifiedHookEvent;
	timeoutMs: number;
}

async function safeCallDaemon(
	args: SafeCallDaemonArgs,
): Promise<{ ok: true; decision: HarnessDecision } | { ok: false; reason: string }> {
	const client = createDaemonClient(args.socketPath);
	let decision: HarnessDecision | null = null;
	let reason = "";
	const done = await client
		.call(args.method as "hook.pre_tool_use", args.event, { timeout_ms: args.timeoutMs })
		.then((d) => {
			decision = d as HarnessDecision;
			return true;
		})
		.catch((err: Error) => {
			reason = err.message;
			return false;
		});
	if (done && decision) return { ok: true, decision };
	return { ok: false, reason };
}

async function safeCallLegacy(
	socketPath: string,
	event: UnifiedHookEvent,
	timeoutMs: number,
): Promise<{ ok: true; decision: HarnessDecision } | { ok: false; reason: string }> {
	try {
		return {
			ok: true,
			decision: await callLegacyHarness(socketPath, event, { timeout_ms: timeoutMs }),
		};
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

function resolveHookProtocol(socketPath: string, env: NodeJS.ProcessEnv): HookProtocol {
	const requested = env.INTERLINKED_HOOK_PROTOCOL;
	if (requested === HOOK_PROTOCOL_RAW) return HOOK_PROTOCOL_RAW;
	if (requested === HOOK_PROTOCOL_FRAMED) return HOOK_PROTOCOL_FRAMED;
	return isLegacyHarnessSocket(socketPath) ? HOOK_PROTOCOL_RAW : HOOK_PROTOCOL_FRAMED;
}

/** Discover the daemon socket. Priority:
 *    1. `--socket` flag / INTERLINKED_SOCKET env var (handled by caller)
 *    2. Per-session `.interlinked/harness-<sanitized>.sock`
 *    3. Default framed `.interlinked/harness-default.sock`
 *    4. Legacy `.interlinked/harness.sock`
 *    5. Any other `harness-*.sock` in the dir (first hit, alphabetical) */
export function discoverSocket(cwd: string, sessionId: string): string | null {
	const root = findRepoRoot(cwd);
	if (!root) return null;
	const dir = join(root, ".interlinked");
	if (!existsSync(dir)) return null;

	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	const perSession = join(dir, `harness-${safe}.sock`);
	if (existsSync(perSession)) return perSession;

	const defaultFramed = join(dir, "harness-default.sock");
	if (existsSync(defaultFramed)) return defaultFramed;

	const legacy = join(dir, "harness.sock");
	if (existsSync(legacy)) return legacy;

	const entries = safeReaddir(dir);
	const socketFiles = entries.filter((n) => n.endsWith(".sock")).sort();
	if (socketFiles.length > 0) return join(dir, nonNull(socketFiles[0]));
	return null;
}

function safeReaddir(dir: string): string[] {
	let out: string[] = [];
	try {
		out = readdirSync(dir);
	} catch {
		out = [];
	}
	return out;
}

/** Build a cold fail-closed BLOCK result for a named gate, appending the
 *  "<gate> fail-closed gate engaged" notice to stderr. Shared by every cold gate
 *  so the encode + notice shape is defined once. */
function coldBlockResult(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	fallbackReason: string,
	gateLabel: string,
	blockReason: string,
): HookEntryResult {
	const blockOutput = adapter.encodeDecision({ decision: "block", reason: blockReason }, event);
	const notice = `[interlinked] ${fallbackReason}; ${gateLabel} fail-closed gate engaged\n`;
	return {
		stdout: blockOutput.stdout,
		stderr: blockOutput.stderr ? `${blockOutput.stderr}\n${notice}` : notice,
		exit_code: blockOutput.exit_code,
		fell_back: true,
	};
}

/** True when the runner's native payload marked this a simulated event
 *  (`interlinked harness test --write/--edit`). The unified event carries no
 *  `dry_run` field of its own, so the raw payload is the only source. Every
 *  evaluator that PERSISTS must honor this — a read-only probe that mutates
 *  state is how three simulated writes opened real transient debt on 2026-08-04. */
function isDryRunEvent(event: UnifiedHookEvent): boolean {
	const raw = event.raw;
	if (typeof raw !== "object" || raw === null) return false;
	// SAFETY: object-ness checked above; the field is read as unknown and
	// compared to `true`, so a non-boolean value can never be trusted.
	return (raw as { dry_run?: unknown }).dry_run === true;
}

async function encodeColdFallback(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	reason: string,
	cwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HookEntryResult> {
	// Cold fallback: allow the action and report the skipped evaluator only
	// on stderr. Do not put timeout/socket failures in decision warnings:
	// Claude routes PreToolUse warnings into model-visible additionalContext,
	// and transport failures are not useful task context for the agent.
	// The full evaluator is too heavy to run inline in the hook process in
	// every runner — the correct place to add cold checks is here as this
	// module grows, but never at the cost of the per-tool-class budget.
	//
	// FIRST gate — daemon-crashed-mid-session. If a harness daemon was started
	// for this project (a `harness.pid` exists) but we've reached the cold
	// path, the daemon died or hung while the agent is mid-session. Block the
	// tool call rather than let the agent proceed UNGUARDED — a silently-dead
	// guard layer is a security failure, not a degraded-mode convenience.
	// Pre-tool only, with an explicit env escape hatch. (Distinct from "no
	// daemon ever ran here", which preserves the allow path below.)
	// One fresh socket connect before the outage stands: the file evidence
	// (pid, socket, ledger tail) went stale under us on 2026-08-15 and refused
	// a Write while a live daemon was answering. See hook-entry-daemon-probe.ts.
	const daemonDownReason = await coldDaemonUnreachableBlockReasonFresh(event, cwd, env);
	if (daemonDownReason) {
		// Self-heal: respawn the daemon (lock-guarded, backoff-throttled, no
		// rebuild) so the NEXT call is guarded again; block THIS one.
		// attemptDaemonSelfHeal never throws. A dry-run event must not advance the
		// supervisor's spawn ladder — a simulated write is a probe, not a caller.
		attemptDaemonSelfHeal(
			cwd ?? event.context?.cwd,
			env,
			isDryRunEvent(event) ? { dryRun: true } : {},
		);
		return coldBlockResult(adapter, event, reason, "harness-offline", daemonDownReason);
	}
	// PROACTIVE self-heal on Stop/SubagentStop: the reactive gate above only
	// runs on a blocked pre-tool call, so a turn with zero tool calls left a
	// dead daemon unrevived for 22 minutes (root-caused 2026-08-22). Never
	// blocks; no-ops on every other phase and every healthy/recent case.
	attemptSelfHealOnStop(event, cwd, env, isDryRunEvent(event) ? { dryRun: true } : {});

	// Exception: fail-closed graph-prediction gate. If the agent is about to
	// edit a file with a fresh `.graph.*` shard and we can't reach the
	// evaluator, block — the protocol requires it.
	// Cold fail-closed gate: merge-conflict markers are a guaranteed parse
	// error. Checked before the graph-shard gate — broken content is a more
	// immediate signal than the protocol-restart mechanics.
	const mergeBlockReason = coldMergeConflictBlockReason(event);
	if (mergeBlockReason) return coldBlockResult(adapter, event, reason, "merge-conflict", mergeBlockReason);

	const shardBlockReason = coldGraphShardBlockReason(event);
	if (shardBlockReason) return coldBlockResult(adapter, event, reason, "graph-shard", shardBlockReason);

	const destructiveReason = coldDestructiveCommandBlockReason(event);
	if (destructiveReason)
		return coldBlockResult(adapter, event, reason, "destructive-command", destructiveReason);

	const packageInstallReason = coldPackageInstallBlockReason(event);
	if (packageInstallReason)
		return coldBlockResult(adapter, event, reason, "supply-chain", packageInstallReason);

	// Quality gate, daemon-independent: enforce the per-file line cap inline so an
	// over-cap write does not slip through while the daemon is unreachable (the gap
	// that let a 797→802 edit cross the cap unblocked on a socket blip).
	const largeFileReason = coldLargeFileBlockReason(event);
	if (largeFileReason)
		return coldBlockResult(adapter, event, reason, "large-file cap", largeFileReason);
	const decision: HarnessDecision = {
		decision: "allow",
	};
	const output = adapter.encodeDecision(decision, event);
	const fallbackNotice = `[interlinked] ${reason}; evaluator skipped\n`;
	const functionTokenNotice = isCodeEditEvent(event)
		? "[interlinked:function-tokens:not-measured] function-token enforcement requires the running harness daemon and an exact language adapter; this cold-fallback edit was not measured\n"
		: "";
	return {
		stdout: output.stdout,
		stderr: output.stderr
			? `${output.stderr}\n${fallbackNotice}${functionTokenNotice}`
			: `${fallbackNotice}${functionTokenNotice}`,
		exit_code: output.exit_code,
		fell_back: true,
	};
}

async function readStdinJson(): Promise<unknown> {
	const data = await new Promise<string>((resolve) => {
		let collected = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			collected += chunk;
		});
		process.stdin.on("end", () => resolve(collected));
		process.stdin.on("error", () => resolve(collected));
	});
	if (!data) return {};
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(data);
	} catch {
		parsed = {};
	}
	return parsed;
}

function argOrEnv(flag: string): string | undefined {
	const args = process.argv.slice(2);
	for (const [i, a] of args.entries()) {
		if (a === flag && i + 1 < args.length) return args[i + 1];
		if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
	}
	return undefined;
}

function isDirectRun(): boolean {
	const invoked = process.argv[1];
	if (!invoked) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	void mainFromStdin().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[interlinked] hook failed open: ${message}\n`);
		process.exit(0);
	});
}
