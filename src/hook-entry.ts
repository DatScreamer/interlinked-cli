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
import type { HarnessDecision } from "./harness/types.js";
import type { RunnerId, UnifiedHookEvent } from "./harness/unified-event.js";

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
	runner?: RunnerId;
	/** Explicit socket path (overrides discovery). */
	socketPath?: string;
	/** Hard timeout for the daemon call. Defaults to 2s. */
	timeout_ms?: number;
}

export interface HookEntryResult {
	stdout?: string;
	stderr?: string;
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

	const socketPath =
		opts.socketPath ?? discoverSocket(opts.cwd ?? process.cwd(), event.session_id);
	if (!socketPath) {
		// No daemon available at all — cold fallback to allow with note.
		return encodeColdFallback(adapter, event, "daemon socket not found");
	}

	const method = methodForPhase(event.phase);
	const timeoutMs = opts.timeout_ms ?? 2000;
	const client = createDaemonClient(socketPath);
	let decision: HarnessDecision;
	const fellBack = false;
	const result = await safeCallDaemon(client, method, event, timeoutMs);
	if (result.ok) {
		decision = result.decision;
	} else {
		const cold = encodeColdFallback(adapter, event, result.reason);
		return cold;
	}

	const output = adapter.encodeDecision(decision, event);
	return {
		stdout: output.stdout,
		stderr: output.stderr,
		exit_code: output.exit_code,
		fell_back: fellBack,
	};
}

/** Entry point for CLI invocation — reads stdin, detects runner + event,
 *  writes stdout/stderr, exits with the adapter-decided code. */
export async function mainFromStdin(): Promise<void> {
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
	// Adapters are tolerant of unknown fields; they should never throw.
	// If they do, we surface a minimal placeholder so the hook exits cleanly.
	const event: UnifiedHookEvent = adapter.parseHookInput(nativeJson, nativeEventName);
	return event;
}

async function safeCallDaemon(
	client: ReturnType<typeof createDaemonClient>,
	method: RpcMethod,
	event: UnifiedHookEvent,
	timeoutMs: number,
): Promise<{ ok: true; decision: HarnessDecision } | { ok: false; reason: string }> {
	let decision: HarnessDecision | null = null;
	let reason = "";
	const done = await client
		.call(method as "hook.pre_tool_use", event, { timeout_ms: timeoutMs })
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

/** Discover the daemon socket. Priority:
 *    1. `--socket` flag / INTERLINKED_SOCKET env var (handled by caller)
 *    2. Per-session `.interlinked/harness-<sanitized>.sock`
 *    3. Legacy `.interlinked/harness.sock`
 *    4. Any other `harness-*.sock` in the dir (first hit, alphabetical) */
export function discoverSocket(cwd: string, sessionId: string): string | null {
	const root = findRepoRoot(cwd);
	if (!root) return null;
	const dir = join(root, ".interlinked");
	if (!existsSync(dir)) return null;

	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	const perSession = join(dir, `harness-${safe}.sock`);
	if (existsSync(perSession)) return perSession;

	const legacy = join(dir, "harness.sock");
	if (existsSync(legacy)) return legacy;

	const entries = safeReaddir(dir);
	const socketFiles = entries.filter((n) => n.endsWith(".sock")).sort();
	if (socketFiles.length > 0) return join(dir, socketFiles[0]);
	return null;
}

function findRepoRoot(cwd: string): string | null {
	let dir = cwd;
	let depth = 0;
	while (depth < 20) {
		if (existsSync(join(dir, ".interlinked"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
		depth++;
	}
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

function encodeColdFallback(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	reason: string,
): HookEntryResult {
	// Cold fallback: allow the action, attach a short notice, never block.
	// The full evaluator is too heavy to run inline in the hook process in
	// every runner — the correct place to add cold checks is here as this
	// module grows, but never at the cost of the per-tool-class budget.
	const decision: HarnessDecision = {
		decision: "allow",
		warnings: [`[interlinked] ${reason}; evaluator skipped`],
	};
	const output = adapter.encodeDecision(decision, event);
	return {
		stdout: output.stdout,
		stderr: output.stderr,
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
