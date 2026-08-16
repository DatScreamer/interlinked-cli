import { describe, expect, it } from "vitest";
import {
	collectServingDaemonPids,
	type DaemonControlDeps,
	reapOrphanHarnessesVerified,
	stopAllDaemons,
} from "./harness-daemon-control.js";
import type { ReapOptions, ReapResult } from "./harness-process.js";

const CWD = "/repo";

function daemon(pid: number | null, socket: string, alive = true) {
	return {
		session_id: socket,
		paths: { socket, pid: `${socket}.pid`, log: "log" },
		pid,
		alive,
	};
}

describe("collectServingDaemonPids — positive (must fire)", () => {
	it("P1: a pid whose socket ANSWERS is reported as serving", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			probe: () => Promise.resolve(true),
		};
		expect([...(await collectServingDaemonPids(CWD, deps))]).toEqual([11]);
	});

	it("P2: several serving daemons are all reported", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock"), daemon(12, "/b.sock")],
			probe: () => Promise.resolve(true),
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(2);
	});
});

describe("collectServingDaemonPids — negative (must not fire)", () => {
	it("N1: a pid whose socket refuses is NOT serving", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			probe: () => Promise.resolve(false),
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(0);
	});

	it("N2: a dead process is never probed nor reported", async () => {
		let probed = 0;
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock", false)],
			probe: () => {
				probed++;
				return Promise.resolve(true);
			},
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(0);
		expect(probed).toBe(0);
	});

	it("N3: a pid-less entry is skipped", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(null, "/a.sock")],
			probe: () => Promise.resolve(true),
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(0);
	});
});

function sweepRecorder(seen: ReapOptions[]) {
	return (_cwd: string, opts: ReapOptions): ReapResult => {
		seen.push(opts);
		return { candidates: [], killed: [], dryRun: opts.dryRun === true };
	};
}

describe("reapOrphanHarnessesVerified — positive (must fire: protect the serving set)", () => {
	it("P1: the answering pid arrives at the sweep in protectPids", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{},
			{
				discover: () => [daemon(11, "/a.sock")],
				probe: () => Promise.resolve(true),
				reap: sweepRecorder(seen),
			},
		);
		expect([...(seen[0]?.protectPids ?? [])]).toEqual([11]);
	});

	it("P2: caller opts (dryRun/killAll) are forwarded alongside the protected set", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{ dryRun: true, killAll: true },
			{
				discover: () => [daemon(11, "/a.sock")],
				probe: () => Promise.resolve(true),
				reap: sweepRecorder(seen),
			},
		);
		expect(seen[0]?.dryRun).toBe(true);
		expect(seen[0]?.killAll).toBe(true);
		expect(seen[0]?.protectPids?.has(11)).toBe(true);
	});
});

describe("reapOrphanHarnessesVerified — negative (must not fire)", () => {
	it("N1: a refusing socket leaves the protected set empty", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{},
			{
				discover: () => [daemon(11, "/a.sock")],
				probe: () => Promise.resolve(false),
				reap: sweepRecorder(seen),
			},
		);
		expect(seen[0]?.protectPids?.size).toBe(0);
	});

	it("N2: with no discovered daemons the sweep still runs, with nothing protected", async () => {
		const seen: ReapOptions[] = [];
		const result = await reapOrphanHarnessesVerified(
			CWD,
			{},
			{ discover: () => [], reap: sweepRecorder(seen) },
		);
		expect(seen).toHaveLength(1);
		expect(result.killed).toEqual([]);
	});
});

describe("stopAllDaemons — positive (must fire: stop EVERY daemon for this repo)", () => {
	it("P1: signals the pid-file daemon AND the orphans the pid file never knew about", async () => {
		const killed: number[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			extraPids: () => [22, 33],
			probe: () => Promise.resolve(true),
			kill: (pid) => killed.push(pid),
			isAlive: () => false,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(killed.sort((a, b) => a - b)).toEqual([11, 22, 33]);
		expect(result.stopped.sort((a, b) => a - b)).toEqual([11, 22, 33]);
		expect(result.survived).toEqual([]);
	});

	it("P2: records an explicit-stop ledger marker BEFORE signalling", async () => {
		const order: string[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			recordEvent: (evt) => order.push(`record:${evt.reason}`),
			kill: (pid) => order.push(`kill:${pid}`),
			isAlive: () => false,
			wait: () => Promise.resolve(),
		};
		await stopAllDaemons(CWD, deps);
		expect(order).toEqual(["record:explicit-stop", "kill:11"]);
	});

	it("P3: a daemon still alive after SIGTERM is reported as survived", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			kill: () => {},
			isAlive: () => true,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(result.survived).toEqual([11]);
		expect(result.stopped).toEqual([]);
	});
});

describe("stopAllDaemons — negative (must not fire)", () => {
	it("N1: never signals this process or an ancestor", async () => {
		const killed: number[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(process.pid, "/self.sock")],
			extraPids: () => [4242],
			protectedPids: () => new Set([process.pid, 4242]),
			kill: (pid) => killed.push(pid),
			isAlive: () => false,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(killed).toEqual([]);
		expect(result.stopped).toEqual([]);
	});

	it("N2: no daemons at all is a no-op with no ledger row", async () => {
		let recorded = 0;
		const deps: DaemonControlDeps = {
			discover: () => [],
			extraPids: () => [],
			recordEvent: () => {
				recorded++;
			},
			kill: () => {
				throw new Error("must not signal");
			},
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(result.stopped).toEqual([]);
		expect(recorded).toBe(0);
	});

	it("N3: a pid appearing in BOTH sources is signalled once", async () => {
		const killed: number[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			extraPids: () => [11],
			kill: (pid) => killed.push(pid),
			isAlive: () => false,
			wait: () => Promise.resolve(),
		};
		await stopAllDaemons(CWD, deps);
		expect(killed).toEqual([11]);
	});
});
