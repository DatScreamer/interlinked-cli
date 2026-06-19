import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import {
	attemptDaemonSelfHeal,
	coldDaemonUnreachableBlockReason,
	findRepoRoot,
} from "./hook-entry-daemon-gate.js";

function makeEvent(phase: UnifiedHookEvent["phase"], cwd: string): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "e1",
		session_id: "s1",
		ts: "2026-06-12T00:00:00.000Z",
		runner: "claude-code" as never,
		runner_native_event: phase === "pre-tool" ? "PreToolUse" : "Stop",
		phase,
		action:
			phase === "pre-tool"
				? ({ kind: "shell_command", command: "echo hi", cwd } as never)
				: ({ kind: "lifecycle" } as never),
		context: { cwd },
		raw: null,
	} as UnifiedHookEvent;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "he-daemon-gate-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
	it("finds the nearest ancestor holding .interlinked/", () => {
		const nested = join(dir, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findRepoRoot(nested)).toBe(dir);
	});

	it("returns null when no ancestor has .interlinked/", () => {
		const bare = mkdtempSync(join(tmpdir(), "he-bare-"));
		expect(findRepoRoot(bare)).toBeNull();
		rmSync(bare, { recursive: true, force: true });
	});
});

describe("coldDaemonUnreachableBlockReason", () => {
	function writePid(pid = "2147480000"): void {
		writeFileSync(join(dir, ".interlinked", "harness.pid"), `${pid}\n`);
	}
	/** Write a framed/session pid file (e.g. `harness-default.pid`,
	 *  `harness-<id>.pid`) — what `--protocol framed` / `--session-id` daemons
	 *  write instead of the raw `harness.pid` (see `session-paths.ts`). */
	function writeFramedPid(name: string, pid = "2147480000"): void {
		writeFileSync(join(dir, ".interlinked", name), `${pid}\n`);
	}
	function writeSock(name: string): void {
		writeFileSync(join(dir, ".interlinked", name), "");
	}
	function writeConfig(): void {
		writeFileSync(join(dir, ".interlinked", "config.json"), "{}");
	}
	function writeDisable(
		name = "guard-disabled.local.json",
		body: Record<string, unknown> = { disabled: true, scope: "project", version: 1 },
	): void {
		writeFileSync(join(dir, ".interlinked", name), JSON.stringify(body));
	}

	it("blocks a pre-tool call when a dead harness.pid proves the daemon crashed", () => {
		writePid();
		const reason = coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {});
		expect(reason).toContain("BLOCKED");
		expect(reason).toContain("harness pid present");
	});

	it("blocks when the daemon is alive but its socket file is gone (the stomp incident)", () => {
		writePid(String(process.pid));
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toContain(
			"BLOCKED",
		);
	});

	it("ALLOWS when an alive pid AND a socket file are present — the daemon is up but slow, not gone (continuity; reverts the 2026-06 over-block)", () => {
		// A live pid plus a present `.sock` file means the daemon is listening but
		// was momentarily too busy to answer within the hook's short connect budget
		// (common on large repos under load). Blocking here turned a transient
		// slowdown into a flood of blocked edits across every repo — a continuity
		// failure. Fail OPEN: the next call is served by the same daemon.
		writePid(String(process.pid));
		writeFileSync(join(dir, ".interlinked", "harness.sock"), "");
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toBeNull();
	});

	it("ALLOWS a framed daemon present (harness-default.pid alive + harness-default.sock, NO harness.pid)", () => {
		// A `--protocol framed` daemon writes harness-default.pid / .sock, never the
		// raw harness.pid. Discovering only harness.pid made it look GONE on a connect
		// timeout → block + needless self-heal of a LIVE daemon. The gate must scan the
		// framed names and take the alive+slow ALLOW path here.
		writeFramedPid("harness-default.pid", String(process.pid));
		writeSock("harness-default.sock");
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toBeNull();
	});

	it("ALLOWS a non-default session daemon (harness-myid.pid alive + harness-myid.sock)", () => {
		// A `--session-id myid` daemon writes harness-myid.pid / .sock. Both the pid
		// scan and the socket scan must recognize an arbitrary session id, not just
		// the framed default.
		writeFramedPid("harness-myid.pid", String(process.pid));
		writeSock("harness-myid.sock");
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toBeNull();
	});

	it("BLOCKS a DEAD framed pid on a configured repo (crash on a framed daemon still fails closed)", () => {
		// A framed daemon that crashed leaves a stale harness-default.pid pointing at a
		// dead process. With the repo configured, that is a genuine cut-out → block +
		// self-heal, exactly like a dead raw harness.pid.
		writeFramedPid("harness-default.pid", "2147480000");
		writeConfig();
		const reason = coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {});
		expect(reason).toContain("BLOCKED");
	});

	it("BLOCKS a framed daemon whose socket was stomped (alive pid, no .sock anywhere)", () => {
		// Live framed pid but every socket file removed → unreachable (the stomp
		// incident, framed variant). A live pid alone is not enough; the socket scan
		// finds nothing, so the alive+slow allow path does NOT fire.
		writeFramedPid("harness-default.pid", String(process.pid));
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toContain(
			"BLOCKED",
		);
	});

	it("blocks when NO pid but the repo is configured — the clean-stop/idle hole", () => {
		writeConfig(); // no harness.pid → daemon cleanly stopped while session active
		const reason = coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {});
		expect(reason).toContain("BLOCKED");
		expect(reason).toContain("configured here");
	});

	it("allows when no pid AND the repo is not configured (never set up / pre-init)", () => {
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toBeNull();
	});

	it("never blocks lifecycle events even with a pid present", () => {
		writePid();
		expect(coldDaemonUnreachableBlockReason(makeEvent("stop", dir), dir, {})).toBeNull();
	});

	it("honors the INTERLINKED_ALLOW_NO_DAEMON escape hatch", () => {
		writePid();
		expect(
			coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {
				INTERLINKED_ALLOW_NO_DAEMON: "1",
			}),
		).toBeNull();
	});

	it("stands down (allows) on an intentional disable marker, even over a crashed pid", () => {
		writePid();
		writeDisable();
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toBeNull();
	});

	it("stands down on a committed team disable marker", () => {
		writeConfig();
		writeDisable("guard-disabled.json");
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toBeNull();
	});

	it("an EXPIRED disable marker does not stand down — a crash still fails closed", () => {
		writePid();
		writeDisable("guard-disabled.local.json", {
			disabled: true,
			scope: "project",
			version: 1,
			expires_at: "2000-01-01T00:00:00.000Z",
		});
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toContain(
			"BLOCKED",
		);
	});

	it("a MALFORMED disable marker fails toward guarding (crash still blocks)", () => {
		writePid();
		writeFileSync(join(dir, ".interlinked", "guard-disabled.local.json"), "{ not json");
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", dir), dir, {})).toContain(
			"BLOCKED",
		);
	});

	it("allows outside any interlinked project", () => {
		const bare = mkdtempSync(join(tmpdir(), "he-bare2-"));
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", bare), bare, {})).toBeNull();
		rmSync(bare, { recursive: true, force: true });
	});

	it("does not throw when .interlinked is unreadable as a dir (the readdir fails-open guard)", () => {
		// `.interlinked` present as a FILE (not a directory): findRepoRoot still
		// resolves the root (it only checks existence), but readdirSync throws
		// ENOTDIR. The shared listing guard must fail open to [] so the pid + socket
		// scans treat it as "nothing found" rather than crashing the cold gate. With
		// no readable pid and no config it resolves to a fresh-checkout ALLOW.
		const root = mkdtempSync(join(tmpdir(), "he-notdir-"));
		writeFileSync(join(root, ".interlinked"), "i am a file, not a dir");
		expect(coldDaemonUnreachableBlockReason(makeEvent("pre-tool", root), root, {})).toBeNull();
		rmSync(root, { recursive: true, force: true });
	});
});

describe("attemptDaemonSelfHeal", () => {
	const lockPath = (): string => join(dir, ".interlinked", ".harness-selfheal.lock");

	it("skips when INTERLINKED_NO_SELF_HEAL=1", () => {
		expect(attemptDaemonSelfHeal(dir, { INTERLINKED_NO_SELF_HEAL: "1" })).toBe("skipped");
	});

	it("skips outside any interlinked project", () => {
		const bare = mkdtempSync(join(tmpdir(), "he-bare3-"));
		expect(attemptDaemonSelfHeal(bare, {})).toBe("skipped");
		rmSync(bare, { recursive: true, force: true });
	});

	it("skips when the project is intentionally disabled (does not fight the operator)", () => {
		writeFileSync(
			join(dir, ".interlinked", "guard-disabled.local.json"),
			JSON.stringify({ disabled: true, scope: "project", version: 1 }),
		);
		let spawned = false;
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/fake/server.js",
			spawnDaemon: () => {
				spawned = true;
			},
		});
		expect(result).toBe("skipped");
		expect(spawned).toBe(false);
	});

	it("spawns the daemon and stamps the throttle lock", () => {
		let calledWith: { serverPath: string; root: string } | null = null;
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/fake/harness/server.js",
			spawnDaemon: (serverPath, root) => {
				calledWith = { serverPath, root };
			},
		});
		expect(result).toBe("spawned");
		expect(calledWith).toEqual({ serverPath: "/fake/harness/server.js", root: dir });
		expect(readFileSync(lockPath(), "utf8").length).toBeGreaterThan(0);
	});

	it("is throttled by a fresh lock (returns 'locked', does not respawn)", () => {
		writeFileSync(lockPath(), String(Date.now()));
		let spawned = false;
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/fake/server.js",
			spawnDaemon: () => {
				spawned = true;
			},
		});
		expect(result).toBe("locked");
		expect(spawned).toBe(false);
	});

	it("skips when the daemon binary cannot be resolved", () => {
		expect(attemptDaemonSelfHeal(dir, {}, { resolveServerPath: () => null })).toBe("skipped");
	});

	it("stays fail-closed (skips) when the spawn throws", () => {
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/fake/server.js",
			spawnDaemon: () => {
				throw new Error("spawn boom");
			},
		});
		expect(result).toBe("skipped");
	});

	it("uses the real default resolver/spawn without throwing (covers the wired path)", () => {
		// Default resolveServerPath finds no server.js next to the test module → 'skipped';
		// if a candidate ever resolves, the real detached spawn of a nonexistent path is
		// harmless (the child exits immediately). Either way it must not throw.
		const result = attemptDaemonSelfHeal(dir, {});
		expect(["skipped", "spawned"]).toContain(result);
	});

	it("covers the real detached spawn path with a harmless nonexistent binary", () => {
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/nonexistent/interlinked-selfheal-probe/server.js",
		});
		expect(result).toBe("spawned");
	});
});
