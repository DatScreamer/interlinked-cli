import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	cleanupOrphans,
	daemonPathsFor,
	discoverDaemons,
	isDaemonSocketServing,
	liveForeignDaemonPid,
	sanitizeSessionId,
} from "./session-paths.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-sp-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("daemonPathsFor", () => {
	it("returns legacy paths when no session id is given", () => {
		const p = daemonPathsFor("/repo");
		expect(p.socket).toBe("/repo/.interlinked/harness.sock");
		expect(p.pid).toBe("/repo/.interlinked/harness.pid");
	});

	it("returns per-session paths when a session id is given", () => {
		const p = daemonPathsFor("/repo", "abc123");
		expect(p.socket).toBe("/repo/.interlinked/harness-abc123.sock");
		expect(p.pid).toBe("/repo/.interlinked/harness-abc123.pid");
	});

	it("treats an explicit 'default' session id as the framed default socket", () => {
		const p = daemonPathsFor("/repo", "default");
		expect(p.socket.endsWith("/harness-default.sock")).toBe(true);
	});
});

describe("liveForeignDaemonPid", () => {
	it("returns null when the pid file is absent", () => {
		expect(liveForeignDaemonPid(join(tmp, ".interlinked", "harness.pid"))).toBeNull();
	});

	it("returns null for a stale pid (dead process) so a post-crash restart proceeds", () => {
		const p = join(tmp, ".interlinked", "harness.pid");
		// PID 2^31-ish is effectively never live on a test host.
		writeFileSync(p, "2147480000\n");
		expect(liveForeignDaemonPid(p)).toBeNull();
	});

	it("returns null for our own pid (never self-trip)", () => {
		const p = join(tmp, ".interlinked", "harness.pid");
		writeFileSync(p, `${process.pid}\n`);
		expect(liveForeignDaemonPid(p)).toBeNull();
	});

	it("returns the pid of a live foreign daemon (the stomp guard)", () => {
		const p = join(tmp, ".interlinked", "harness.pid");
		// process.ppid is alive and (in vitest) not equal to our own pid.
		writeFileSync(p, `${process.ppid}\n`);
		expect(liveForeignDaemonPid(p)).toBe(process.ppid);
	});
});

describe("sanitizeSessionId", () => {
	it("keeps alphanumerics and separators", () => {
		expect(sanitizeSessionId("abc-123_x")).toBe("abc-123_x");
	});
	it("replaces unsafe characters", () => {
		expect(sanitizeSessionId("abc/def")).toBe("abc_def");
		expect(sanitizeSessionId("a b")).toBe("a_b");
	});
	it("caps length at 64", () => {
		const long = "a".repeat(200);
		expect(sanitizeSessionId(long).length).toBe(64);
	});
});

describe("discoverDaemons", () => {
	it("returns empty when .interlinked is empty", () => {
		expect(discoverDaemons(tmp)).toEqual([]);
	});

	it("finds the legacy daemon PID file", () => {
		writeFileSync(join(tmp, ".interlinked", "harness.pid"), `${process.pid}`);
		const daemons = discoverDaemons(tmp);
		expect(daemons.length).toBe(1);
		expect(nonNull(daemons[0]).session_id).toBe("default");
		expect(nonNull(daemons[0]).alive).toBe(true);
	});

	it("finds per-session daemon PID files", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-sess1.pid"), `${process.pid}`);
		writeFileSync(join(tmp, ".interlinked", "harness-sess2.pid"), "999999999");
		const daemons = discoverDaemons(tmp);
		expect(daemons.length).toBe(2);
		const ids = daemons.map((d) => d.session_id).sort();
		expect(ids).toEqual(["sess1", "sess2"]);
	});

	it("flags dead daemons via alive=false", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-dead.pid"), "999999999");
		const daemons = discoverDaemons(tmp);
		expect(nonNull(daemons[0]).alive).toBe(false);
	});
});

describe("cleanupOrphans", () => {
	it("removes PID+socket pairs for dead daemons", () => {
		const pidFile = join(tmp, ".interlinked", "harness-dead.pid");
		const sockFile = join(tmp, ".interlinked", "harness-dead.sock");
		writeFileSync(pidFile, "999999999");
		writeFileSync(sockFile, "");
		const cleaned = cleanupOrphans(tmp);
		expect(cleaned.length).toBe(1);
		expect(nonNull(cleaned[0]).session_id).toBe("dead");
	});

	it("leaves live daemons alone", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-live.pid"), `${process.pid}`);
		const cleaned = cleanupOrphans(tmp);
		expect(cleaned.length).toBe(0);
	});
});

// ===========================================================================
// isDaemonSocketServing — the anti-stomp "is the incumbent actually
// answering" probe (session-paths.ts). Real Unix-domain sockets, not mocks:
// this is exactly the connect-level distinction the function exists to make.
// ===========================================================================
describe("isDaemonSocketServing", () => {
	let server: Server | null = null;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => nonNull(server).close(() => resolve()));
			server = null;
		}
	});

	it("resolves true for a real listener actively accepting connections", async () => {
		const sockPath = join(tmp, ".interlinked", "serving.sock");
		server = createServer((sock) => sock.destroy());
		await new Promise<void>((resolve) => nonNull(server).listen(sockPath, () => resolve()));

		await expect(isDaemonSocketServing(sockPath)).resolves.toBe(true);
	});

	it("resolves false when the socket path does not exist (ENOENT — nobody ever bound it)", async () => {
		const sockPath = join(tmp, ".interlinked", "never-bound.sock");
		await expect(isDaemonSocketServing(sockPath)).resolves.toBe(false);
	});

	it("resolves false for a stale socket FILE left behind by a dead listener (ECONNREFUSED)", async () => {
		// Bind a real server, then close it WITHOUT unlinking the path — the
		// exact zombie shape: the pid is (hypothetically) still alive, the
		// inode is still on disk, but nothing is bound there anymore.
		const sockPath = join(tmp, ".interlinked", "stale.sock");
		const s = createServer();
		await new Promise<void>((resolve) => s.listen(sockPath, () => resolve()));
		await new Promise<void>((resolve) => s.close(() => resolve()));
		writeFileSync(sockPath, ""); // recreate a plain file at the same path — nothing listens on it

		await expect(isDaemonSocketServing(sockPath)).resolves.toBe(false);
	});

	it("resolves true on a bare successful connect, even when the listener never sends data back", async () => {
		// Deliberately connect-only semantics: a listener that accepts the
		// connection but never responds still counts as "serving" — the probe
		// proves a bound listener exists, it does not attempt a protocol
		// round-trip (see the function's own doc comment for why: no
		// coupling to raw vs. framed wire format, no side effects on the
		// incumbent from the probe itself).
		const sockPath = join(tmp, ".interlinked", "silent.sock");
		server = createServer(() => {
			/* never destroy/respond — connection stays open */
		});
		await new Promise<void>((resolve) => nonNull(server).listen(sockPath, () => resolve()));

		await expect(isDaemonSocketServing(sockPath, { timeout_ms: 200 })).resolves.toBe(true);
	});
});
