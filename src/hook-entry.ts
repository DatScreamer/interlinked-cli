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
import {
	callLegacyHarness,
	DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS,
	isLegacyHarnessSocket,
} from "./harness/legacy-client.js";
import type { HarnessDecision } from "./harness/types.js";
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
import { writeLastCheckArtifact, writeNoHarnessArtifact } from "./lib/last-check-writer.js";

// Re-export for back-compat: tests import this from "./hook-entry.js".
export { coldDaemonUnreachableBlockReason };

const DEFAULT_HOOK_TIMEOUT_MS = 2000;

// Hook-socket transport variants. The legacy server uses newline-delimited
// JSON over a raw stream; the new server uses length-prefixed framing.
const HOOK_PROTOCOL_RAW = "raw";
const HOOK_PROTOCOL_FRAMED = "framed";
type HookProtocol = typeof HOOK_PROTOCOL_RAW | typeof HOOK_PROTOCOL_FRAMED;

// Unified phase tags (a subset of UnifiedPhase). Centralized as constants
// because hook-entry compares against them in multiple places — magic
// strings drift across files when one place is refactored and the others
// aren't.
const PHASE_PRE_TOOL = "pre-tool";

// Discriminator values for UnifiedAction. Same rationale as above.
const ACTION_TOOL_CALL = "tool_call";
const ACTION_SHELL_COMMAND = "shell_command";
const ACTION_FILE_OPERATION = "file_operation";

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
		return encodeColdFallback(adapter, event, "daemon socket not found", gateCwd, opts.env);
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
	} else {
		writeNoHarnessArtifact(dirname(socketPath), event, Date.now() - callStartMs);
		const cold = encodeColdFallback(adapter, event, result.reason, gateCwd, opts.env);
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
async function mainFromStdin(): Promise<void> {
	const nativeJson = await readStdinJson();
	const nativeEventName = argOrEnv("--event") ?? process.env.INTERLINKED_EVENT ?? "PreToolUse";
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

/**
 * Client wait ceiling for a code-edit PreToolUse. A Write/Edit can trigger the
 * daemon's per-edit coverage/CRAP overlay, which runs to its `budget_ms` (25s
 * default) — mirror + vitest + v8 routinely exceeds the 5s base. If the CLIENT
 * gives up first it cold-fallback-ALLOWS, so the daemon's coverage BLOCK never
 * reaches the agent and per-edit enforcement is silently a no-op (the 5s came
 * from the 2026-05 fast-guard era; per-edit coverage landed 2026-06-07 with the
 * 25s budget and the two were never reconciled — found 2026-06-12). The daemon
 * answers the instant it has a verdict, so a non-coverage edit still returns in
 * ~1ms; this ceiling only bites while coverage is genuinely computing (or the
 * daemon is hung, where the fail-closed gate then engages).
 */
const COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS = 30_000;
// Stored NORMALIZED (lowercased, underscores stripped) so every naming style
// maps in: Claude/Codex camelCase `MultiEdit`/`NotebookEdit` AND snake_case
// `multi_edit`/`notebook_edit`/`apply_patch` all collapse to the same key.
// Codex preserves raw tool names, so without the strip its `MultiEdit` →
// `multiedit` would miss the (formerly snake_case) set and get the short
// non-coverage timeout, falling back before the per-edit overlay's verdict
// (finding 2026-06).
const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "applypatch", "notebookedit"]);

/** A PreToolUse whose tool could trigger the per-edit coverage overlay. */
export function isCodeEditEvent(event: UnifiedHookEvent): boolean {
	const action = event.action as { kind?: string; tool_name?: string };
	if (action?.kind === ACTION_FILE_OPERATION) return true;
	return (
		action?.kind === ACTION_TOOL_CALL &&
		EDIT_TOOL_NAMES.has((action.tool_name ?? "").toLowerCase().replace(/_/g, ""))
	);
}

function defaultTimeoutForPhase(event: UnifiedHookEvent): number {
	if (event.phase !== PHASE_PRE_TOOL) return DEFAULT_HOOK_TIMEOUT_MS;
	// Edits may run the coverage overlay (up to budget_ms) — wait for that
	// verdict; Bash/Read/Grep answer in ~1ms, so keep them on the snappy ceiling.
	return isCodeEditEvent(event)
		? COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS
		: DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS;
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
	if (socketFiles.length > 0) return join(dir, socketFiles[0]);
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

function encodeColdFallback(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	reason: string,
	cwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): HookEntryResult {
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
	const daemonDownReason = coldDaemonUnreachableBlockReason(event, cwd, env);
	if (daemonDownReason) {
		// Self-heal: respawn the daemon (lock-guarded, no rebuild) so the NEXT call is
		// guarded again; block THIS one. attemptDaemonSelfHeal never throws.
		attemptDaemonSelfHeal(cwd ?? event.context?.cwd, env);
		return coldBlockResult(adapter, event, reason, "harness-offline", daemonDownReason);
	}

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
	return {
		stdout: output.stdout,
		stderr: output.stderr ? `${output.stderr}\n${fallbackNotice}` : fallbackNotice,
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
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
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
