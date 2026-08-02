import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { encodeFrame, type RpcMessage, splitFrames } from "./daemon-protocol.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import {
	claimSessionPid,
	DaemonOwnershipConflictError,
	type SessionDaemonHandle,
	startSessionDaemon,
} from "./session-daemon.js";
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
					resolve(JSON.parse(nonNull(frames[0])));
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

	it("handles multiple framed requests on one connection", async () => {
		const paths = makePaths("t2b");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t2b",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const responses = await new Promise<RpcMessage[]>((resolve, reject) => {
			const socket = createConnection(paths.socket);
			let pending = "";
			const out: RpcMessage[] = [];
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, 1000);
			socket.on("connect", () => {
				socket.write(
					encodeFrame({
						schema_version: "1",
						id: "multi-1",
						method: "daemon.health",
						params: {},
					} as RpcMessage),
				);
				socket.write(
					encodeFrame({
						schema_version: "1",
						id: "multi-2",
						method: "daemon.invalidate",
						params: { path: "/a.ts" },
					} as RpcMessage),
				);
			});
			socket.on("data", (b: Buffer) => {
				const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
				pending = remainder;
				for (const frame of frames) out.push(JSON.parse(frame) as RpcMessage);
				if (out.length === 2) {
					clearTimeout(timer);
					socket.destroy();
					resolve(out);
				}
			});
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		expect(responses.map((response) => response.id).sort()).toEqual(["multi-1", "multi-2"]);
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
		expect(nonNull((tsgo.invalidate as ReturnType<typeof vi.fn>).mock.calls[0])[0]).toBe("/x/y.ts");
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
					resolve(JSON.parse(nonNull(frames[0])));
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

	it("refuses to steal a framed socket owned by a live PID", async () => {
		const paths = makePaths("owned");
		writeFileSync(paths.pid, "1");
		writeFileSync(paths.socket, "");

		let caught: unknown;
		try {
			await startSessionDaemon({
				paths,
				session_id: "owned",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			});
		} catch (err) {
			caught = err;
		}
		// Typed so server.ts can route it through the anti-stomp loser
		// contract instead of the generic survive-on-error crash handler.
		expect(caught).toBeInstanceOf(DaemonOwnershipConflictError);
		expect((caught as DaemonOwnershipConflictError).ownerPid).toBe(1);
		expect((caught as Error).message).toContain("already running");
		// A losing claim must never touch the socket path — the pre-seeded
		// placeholder content proves nothing rebound over it.
		expect(readFileSync(paths.socket, "utf-8")).toBe("");
	});

	it("releases its pid claim if the socket bind subsequently fails", async () => {
		// Force a genuine bind failure (ENOTDIR) unrelated to file existence:
		// the socket's parent path component is a plain FILE, not a
		// directory. `paths.pid` lives in a normal directory so the claim
		// still succeeds; only the LATER bind fails, exercising the release
		// path without the pre-bind `rmSync(paths.socket, …)` cleanup (which
		// only ever removes a STALE artifact — never a live rival's socket,
		// since a live rival would already have failed the pid claim above)
		// masking the scenario.
		const notADir = join(tmp, "not-a-directory");
		writeFileSync(notADir, "");
		const paths = {
			socket: join(notADir, "harness-bindfail.sock"),
			pid: join(tmp, "harness-bindfail.pid"),
			log: join(tmp, "logs", "daemon-bindfail.log"),
		};
		await expect(
			startSessionDaemon({
				paths,
				session_id: "bindfail",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			}),
		).rejects.toThrow();
		expect(existsSync(paths.pid)).toBe(false);
	});

	it("claimSessionPid: two different (both-alive) pids racing for the same path — exactly one wins, regardless of call order", () => {
		const pidPath = join(tmp, "claim-race.pid");

		const a = claimSessionPid(pidPath, process.pid);
		const b = claimSessionPid(pidPath, process.ppid);
		expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
		expect(a.claimed).toBe(true);
		expect(b).toEqual({ claimed: false, ownerPid: process.pid });

		rmSync(pidPath, { force: true });

		// Reversed order: confirms the winner is whoever claims FIRST, not a
		// fixed argument-position bias.
		const c = claimSessionPid(pidPath, process.ppid);
		const d = claimSessionPid(pidPath, process.pid);
		expect([c.claimed, d.claimed].filter(Boolean)).toHaveLength(1);
		expect(c.claimed).toBe(true);
		expect(d).toEqual({ claimed: false, ownerPid: process.ppid });
	});

	it("claimSessionPid: a dead process's stale claim is stolen, not treated as a conflict", () => {
		const pidPath = join(tmp, "stale-claim.pid");
		writeFileSync(pidPath, "2147480000"); // effectively never live on a test host

		const claim = claimSessionPid(pidPath, process.pid);
		expect(claim).toEqual({ claimed: true });
		expect(readFileSync(pidPath, "utf-8")).toBe(String(process.pid));
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
