import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, type RpcMessage, splitFrames } from "./daemon-protocol.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import { type SessionDaemonHandle, startSessionDaemon } from "./session-daemon.js";
import type { DaemonPaths } from "./session-paths.js";
import type { TsgoRunner } from "./tsgo-runner.js";

let tmp = "";
let daemon: SessionDaemonHandle | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-sd-"));
});
afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function makePaths(id: string): DaemonPaths {
	return {
		socket: join(tmp, `harness-${id}.sock`),
		pid: join(tmp, `harness-${id}.pid`),
		log: join(tmp, "logs", `daemon-${id}.log`),
	};
}

function makeTsgo(): TsgoRunner {
	return {
		available: () => true,
		checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
		simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
		invalidate: vi.fn(),
		stats: () => ({ cache_size: 0, available: true }),
	};
}

function makeEvaluatorContext(): EvaluateUnifiedContext {
	// Minimal stub — only used when hook.* RPCs are sent; most tests avoid those.
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

async function roundTrip(
	paths: DaemonPaths,
	request: RpcMessage,
	timeoutMs = 1500,
): Promise<RpcMessage> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(paths.socket);
		let pending = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("timeout"));
		}, timeoutMs);
		socket.on("connect", () => {
			socket.write(encodeFrame(request));
		});
		socket.on("data", (b: Buffer) => {
			const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
			pending = remainder;
			if (frames.length > 0) {
				clearTimeout(timer);
				socket.destroy();
				try {
					resolve(JSON.parse(frames[0]));
				} catch (err) {
					reject(err);
				}
			}
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

describe("startSessionDaemon", () => {
	it("creates pid + socket files and returns a handle", async () => {
		const paths = makePaths("t1");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t1",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(existsSync(paths.pid)).toBe(true);
		expect(existsSync(paths.socket)).toBe(true);
		expect(daemon.rpcInflight()).toBe(0);
	});

	it("serves daemon.health over the socket", async () => {
		const paths = makePaths("t2");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t2",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const response = await roundTrip(paths, {
			schema_version: "1",
			id: "h-1",
			method: "daemon.health",
			params: {},
		} as RpcMessage);
		const result = (response as { result: { status: string } }).result;
		expect(result.status).toBe("ready");
	});

	it("invalidate forwards to tsgo.invalidate and acks", async () => {
		const paths = makePaths("t3");
		const tsgo = makeTsgo();
		daemon = await startSessionDaemon({
			paths,
			session_id: "t3",
			state: { tsgo, getEvaluatorContext: makeEvaluatorContext },
		});
		await roundTrip(paths, {
			schema_version: "1",
			id: "inv-1",
			method: "daemon.invalidate",
			params: { path: "/x/y.ts" },
		} as RpcMessage);
		expect((tsgo.invalidate as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/x/y.ts");
	});

	it("responds with bad_request for malformed frames", async () => {
		const paths = makePaths("t4");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t4",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const response = await new Promise<RpcMessage>((resolve, reject) => {
			const socket = createConnection(paths.socket);
			let pending = "";
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, 1000);
			socket.on("connect", () => {
				socket.write("not valid json\n");
			});
			socket.on("data", (b: Buffer) => {
				const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
				pending = remainder;
				if (frames.length > 0) {
					clearTimeout(timer);
					socket.destroy();
					resolve(JSON.parse(frames[0]));
				}
			});
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		const asError = response as { error?: { code: string } };
		expect(asError.error?.code).toBe("bad_request");
	});

	it("stop() removes the pid and socket files", async () => {
		const paths = makePaths("t5");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t5",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		await daemon.stop();
		daemon = null;
		expect(existsSync(paths.pid)).toBe(false);
		expect(existsSync(paths.socket)).toBe(false);
	});
});
