// ===========================================
// Restart pre-flight — the sweep must not kill a daemon that is ANSWERING
// ===========================================
// `cleanStaleRestartFiles` ran an unverified `ps`-driven reap until 2026-08-16.
// A restart therefore SIGTERM'd any harness process the pid file did not name,
// including a healthy one serving another session, and the gap that opened is
// what made the next blocked caller start yet another daemon (the storm).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanStaleRestartFiles, lockedJsonRestartStart } from "./harness-lifecycle-helpers.js";
import type { StartupLockResult } from "../harness/startup-lock.js";
import type { DaemonControlDeps } from "./harness-daemon-control.js";
import type { ReapOptions, ReapResult } from "./harness-process.js";

const roots: string[] = [];

function tmpRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "il-restart-"));
	roots.push(root);
	return root;
}

function daemon(pid: number | null, socket: string, alive = true) {
	return { session_id: socket, paths: { socket, pid: `${socket}.pid`, log: "log" }, pid, alive };
}

type ReapSeam = (cwd: string, opts: ReapOptions) => ReapResult;

function recorder(seen: ReapOptions[]): ReapSeam {
	return (_cwd: string, opts: ReapOptions): ReapResult => {
		seen.push(opts);
		return { candidates: [], killed: [], dryRun: opts.dryRun === true };
	};
}

/** Compile-time proof the seam above is the one `DaemonControlDeps` declares. */
const _seamShape: DaemonControlDeps["reap"] = recorder([]);
void _seamShape;

function firstSweep(seen: ReapOptions[]): ReapOptions {
	const first = seen[0];
	if (first === undefined) throw new Error("no sweep recorded");
	return first;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
	}
});

describe("cleanStaleRestartFiles — positive (must fire: protect serving daemons)", () => {
	it("P1: an answering daemon is handed to the sweep as a protected pid", async () => {
		const seen: ReapOptions[] = [];
		await cleanStaleRestartFiles(tmpRepo(), {
			discover: () => [daemon(5150, "/live.sock")],
			probe: () => Promise.resolve(true),
			reap: recorder(seen),
		});
		expect([...(firstSweep(seen).protectPids ?? [])]).toEqual([5150]);
	});

	it("P2: every answering daemon is protected, not just the first", async () => {
		const seen: ReapOptions[] = [];
		await cleanStaleRestartFiles(tmpRepo(), {
			discover: () => [daemon(1, "/a.sock"), daemon(2, "/b.sock")],
			probe: () => Promise.resolve(true),
			reap: recorder(seen),
		});
		expect(firstSweep(seen).protectPids?.size).toBe(2);
	});

	// test-contract: invariant — a restart pre-flight must actually clear dead
	// daemons; a dry-run sweep would leave the corpse holding the socket and the
	// respawn would double-bind. See cleanStaleRestartFiles' doc comment.
	it("P3: the sweep is a REAL reap, not a dry run — stale corpses still get cleared", async () => {
		const seen: ReapOptions[] = [];
		await cleanStaleRestartFiles(tmpRepo(), {
			discover: () => [],
			reap: recorder(seen),
		});
		expect(firstSweep(seen).dryRun ?? false).toBe(false);
	});
});

describe("cleanStaleRestartFiles — negative (must not fire)", () => {
	it("N1: a daemon whose socket refuses is NOT protected", async () => {
		const seen: ReapOptions[] = [];
		await cleanStaleRestartFiles(tmpRepo(), {
			discover: () => [daemon(9, "/dead.sock")],
			probe: () => Promise.resolve(false),
			reap: recorder(seen),
		});
		expect(firstSweep(seen).protectPids?.size).toBe(0);
	});

	it("N2: a dead pid is never probed — its socket may belong to a live successor", async () => {
		let probes = 0;
		const seen: ReapOptions[] = [];
		await cleanStaleRestartFiles(tmpRepo(), {
			discover: () => [daemon(9, "/dead.sock", false)],
			probe: () => {
				probes++;
				return Promise.resolve(true);
			},
			reap: recorder(seen),
		});
		expect(probes).toBe(0);
		expect(firstSweep(seen).protectPids?.size).toBe(0);
	});

	it("N3: an empty repo yields exactly one sweep and no throw", async () => {
		const seen: ReapOptions[] = [];
		await expect(
			cleanStaleRestartFiles(tmpRepo(), { discover: () => [], reap: recorder(seen) }),
		).resolves.toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	it("N4: a protocol-ready raw socket with no pid metadata is never unlinked", async () => {
		const root = tmpRepo();
		const socketPath = join(root, ".interlinked", "harness.sock");
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(socketPath, "socket-placeholder");
		let classifications = 0;
		await cleanStaleRestartFiles(root, {
			discover: () => [],
			socketPaths: () => [socketPath],
			extraPids: () => [],
			probe: () => Promise.resolve(true),
			reap: recorder([]),
			classifySocket: () => {
				classifications++;
				return Promise.resolve("ready");
			},
		});
		expect(classifications).toBe(1);
		expect(existsSync(socketPath)).toBe(true);
	});

	it("N5: a reused unrelated live pid is stale when the raw socket is confirmed absent", async () => {
		const root = tmpRepo();
		const interlinked = join(root, ".interlinked");
		const pidPath = join(interlinked, "harness.pid");
		mkdirSync(interlinked, { recursive: true });
		writeFileSync(pidPath, String(process.pid));
		let classifications = 0;
		await cleanStaleRestartFiles(root, {
			discover: () => [],
			socketPaths: () => [],
			extraPids: () => [],
			reap: recorder([]),
			classifySocket: () => {
				classifications++;
				return Promise.resolve("absent");
			},
			runningStatus: () => ({ running: true, pid: process.pid }),
			identify: () => null,
		});
		expect(classifications).toBe(0);
		expect(existsSync(pidPath)).toBe(false);
	});
});

// ===========================================
// The JSON restart branch must respawn under the SAME startup mutex
// ===========================================

const WON: StartupLockResult = { acquired: true, path: "/lock", release: () => {} };
const LOST: StartupLockResult = { acquired: false, holder: { pid: 909, at: 0 } };

describe("lockedJsonRestartStart — positive (must fire: winner starts, loser waits)", () => {
	it("P1: the lock WINNER runs the spawn", async () => {
		let started = 0;
		await lockedJsonRestartStart("/repo", { json: true }, "raw", "default", 1, "json", {
			acquire: () => WON,
			start: async () => {
				started++;
			},
			reportPending: async () => {
				throw new Error("winner must not report pending");
			},
		});
		expect(started).toBe(1);
	});

	it("P2: the winner RELEASES the lock even when the spawn throws", async () => {
		let released = 0;
		await expect(
			lockedJsonRestartStart("/repo", { json: true }, "raw", "default", 1, "json", {
				acquire: () => ({
					acquired: true,
					path: "/lock",
					release: () => {
						released++;
					},
				}),
				start: () => Promise.reject(new Error("spawn blew up")),
			}),
		).rejects.toThrow("spawn blew up");
		expect(released).toBe(1);
	});

	it("P3: a LOSER reports the winner's pid instead of spawning", async () => {
		const reported: Array<number | null> = [];
		await lockedJsonRestartStart("/repo", { json: true }, "raw", "default", 1, "json", {
			acquire: () => LOST,
			start: () => {
				throw new Error("loser must not spawn");
			},
			reportPending: async (_cwd, holderPid) => {
				reported.push(holderPid);
			},
		});
		expect(reported).toEqual([909]);
	});
});

describe("lockedJsonRestartStart — negative (must not fire)", () => {
	it("N1: a loser never spawns a second daemon (the herd's root cause)", async () => {
		let started = 0;
		await lockedJsonRestartStart("/repo", { json: true }, "raw", "default", 1, "json", {
			acquire: () => LOST,
			start: async () => {
				started++;
			},
			reportPending: async () => {},
		});
		expect(started).toBe(0);
	});

	it("N2: a loser with an unreadable holder still reports (null pid, no spawn)", async () => {
		const reported: Array<number | null> = [];
		let started = 0;
		await lockedJsonRestartStart("/repo", { json: true }, "raw", "default", 1, "json", {
			acquire: () => ({ acquired: false, holder: null }),
			start: async () => {
				started++;
			},
			reportPending: async (_cwd, holderPid) => {
				reported.push(holderPid);
			},
		});
		expect(reported).toEqual([null]);
		expect(started).toBe(0);
	});
});
