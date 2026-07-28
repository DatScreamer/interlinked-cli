import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { createDaemonClient } from "./daemon-client.js";
import { encodeFrame } from "./daemon-protocol.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import { type SessionDaemonHandle, startSessionDaemon } from "./session-daemon.js";
import type { DaemonPaths } from "./session-paths.js";
import type { TsgoRunner } from "./tsgo-runner.js";

let tmp = "";
let daemon: SessionDaemonHandle | null = null;
let server: Server | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-dc-"));
});
afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
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
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

describe("DaemonClient.call — happy path", () => {
	it("returns the result of daemon.health", async () => {
		const paths = makePaths("c1");
		daemon = await startSessionDaemon({
			paths,
			session_id: "c1",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const client = createDaemonClient(paths.socket);
		const health = await client.call("daemon.health", {});
		expect(health.status).toBe("ready");
		expect(health.protocol_version).toBe("1");
	});

	it("forwards tsgo.invalidate and receives ack", async () => {
		const paths = makePaths("c2");
		const tsgo = makeTsgo();
		daemon = await startSessionDaemon({
			paths,
			session_id: "c2",
			state: { tsgo, getEvaluatorContext: makeEvaluatorContext },
		});
		const client = createDaemonClient(paths.socket);
		const ack = await client.call("daemon.invalidate", { path: "/x.ts" });
		expect(ack.ack).toBe(true);
		expect(nonNull((tsgo.invalidate as ReturnType<typeof vi.fn>).mock.calls[0])[0]).toBe("/x.ts");
	});

	it("ignores responses whose id does not match the request", async () => {
		const socketPath = join(tmp, "mismatch.sock");
		server = createServer((socket) => {
			socket.on("data", () => {
				socket.write(
					encodeFrame({
						id: "wrong-id",
						result: {
							status: "degraded",
							uptime_ms: 0,
							warm_caches: [],
							tsgo_status: "unavailable",
							rpc_inflight: 0,
							protocol_version: "1",
						},
					}),
				);
				socket.write(
					encodeFrame({
						id: "expected-id",
						result: {
							status: "ready",
							uptime_ms: 1,
							warm_caches: [],
							tsgo_status: "ready",
							rpc_inflight: 0,
							protocol_version: "1",
						},
					}),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(socketPath, () => resolve());
		});

		const health = await createDaemonClient(socketPath).call(
			"daemon.health",
			{},
			{ id: "expected-id", timeout_ms: 250 },
		);

		expect(health.status).toBe("ready");
	});
});

describe("DaemonClient.call — errors", () => {
	it("rejects with `timeout` when the socket does not exist", async () => {
		const missing = join(tmp, "nope.sock");
		expect(existsSync(missing)).toBe(false);
		const client = createDaemonClient(missing);
		await expect(client.call("daemon.health", {}, { timeout_ms: 250 })).rejects.toBeDefined();
	});
});
