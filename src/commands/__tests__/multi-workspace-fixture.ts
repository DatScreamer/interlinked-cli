// ===========================================
// Multi-workspace ps-fixture helper
// ===========================================
//
// Why this exists:
// `harness reap`, `harness clean`, and `harness status` all care about
// "what daemons exist on the user's machine across multiple workspaces."
// The cross-workspace bug in this PR — where starting a daemon in repo A
// SIGTERM'd an active daemon in repo B — slipped through because every
// existing test seeded `ps` output with exactly one workspace. The bug
// could not surface against a single-workspace fixture; it required
// telling the test "imagine the user has two repos open."
//
// This helper makes that scenario one line. Tests can write:
//
//   mocks.execSync.mockImplementation((cmd) =>
//     buildPsFixture(cmd, [
//       { pid: 1001, ppid: 1, cwd: "/repoA" },
//       { pid: 1002, ppid: 1, cwd: "/repoB" },
//       { pid: 1003, ppid: 1, cwd: "/repoB", role: "active" },
//     ])
//   );
//
// and immediately get a `ps` payload that distinguishes workspaces by
// `--cwd`. The shape is small enough to inline; the value is in NOT
// having every multi-workspace test reinvent its own ad-hoc cmdline
// formatter.

const HARNESS_BINARY = "node /home/u/interlinked-cli/dist/harness/server.js";

/** One simulated harness daemon. `cwd` is the workspace it serves. */
export interface FixtureDaemon {
	pid: number;
	ppid: number;
	cwd: string;
	/** When set, the daemon's pid is also emitted as the active pid for
	 *  its `cwd` (the workspace's `.interlinked/harness.pid` would point
	 *  to this pid). Use this to mark which daemon a given workspace
	 *  considers "live" — relevant for reap/status semantics. */
	role?: "orphan" | "active";
	/** Override the cmdline. Defaults to the standard
	 *  `node .../server.js --cwd <cwd>` shape. Use this when the test
	 *  cares about a specific cmdline variant (legacy daemons without
	 *  `--cwd`, daemons run via `bun`, etc.). */
	cmd?: string;
}

/**
 * Build a `ps` payload for a multi-workspace scenario. Returns the right
 * payload for either `ps -ax -o pid=,ppid=,command=` (the orphan scan) or
 * `ps -o pid=,ppid= -ax` (the ancestor walk) depending on the requested
 * command. Empty for unrelated `ps` invocations so callers can compose
 * this into existing mocks.
 */
export function buildPsFixture(command: string, daemons: FixtureDaemon[]): string {
	if (command.includes("pid=,ppid= -ax")) {
		// Ancestor walk only needs pid+ppid. Empty here means no
		// synthetic ancestors — the test's process.ppid still drives
		// real ancestor detection.
		return "";
	}
	if (!command.includes("pid=,ppid=,command=")) {
		// Some other `ps` invocation (e.g. `ps -o rss= -p <pid>`) — we
		// don't synthesize that here; the caller's mock should handle
		// it independently.
		return "";
	}
	const rows = daemons.map((d) => {
		const cmd = d.cmd ?? `${HARNESS_BINARY} --cwd ${d.cwd}`;
		return `${d.pid} ${d.ppid} ${cmd}`;
	});
	return rows.join("\n");
}

/** Helper for tests that need to know which daemon is "active" in a
 *  workspace — e.g. when mocking `readActiveHarnessPid`. Returns the pid
 *  of the daemon marked `role: "active"` for that cwd, or null. */
export function activePidForWorkspace(
	daemons: FixtureDaemon[],
	cwd: string,
): number | null {
	const active = daemons.find((d) => d.cwd === cwd && d.role === "active");
	return active?.pid ?? null;
}
