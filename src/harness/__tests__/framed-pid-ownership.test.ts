// Regression test for the framed-PID-clobber bug flagged in the Plan 08
// review.
//
// Background: in dual-mode startup, `writePidFile()` in server.ts used to
// write BOTH the legacy `harness.pid` and the framed
// `harness-<session>.pid`. The framed write happened BEFORE
// `startSessionDaemon()` ran its ownership check at session-daemon.ts:60-66,
// so the check saw `existingPid === process.pid` and silently passed —
// leading the daemon to remove and rebind a live socket that another
// daemon process actually owned.
//
// Fix: writePidFile now owns the LEGACY file only. The framed file's
// lifecycle is owned exclusively by `startSessionDaemon()` (write at
// session-daemon.ts:136 after the ownership claim, removal at :167-169).
// This test enforces that ownership boundary at the source level.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_TS = readFileSync(
	join(process.cwd(), "src", "harness", "server.ts"),
	"utf-8",
);
const SESSION_DAEMON_TS = readFileSync(
	join(process.cwd(), "src", "harness", "session-daemon.ts"),
	"utf-8",
);

describe("framed-PID file ownership (Plan 08 review fix)", () => {
	it("writePidFile in server.ts does NOT write FRAMED_PATHS.pid", () => {
		// Find the writePidFile function body and confirm the framed write
		// is gone. Limit the scan to the function body so unrelated
		// occurrences elsewhere don't false-pass us.
		const startIdx = SERVER_TS.indexOf("function writePidFile(): void {");
		expect(startIdx).toBeGreaterThan(0);
		const endIdx = SERVER_TS.indexOf("\n}\n", startIdx);
		expect(endIdx).toBeGreaterThan(startIdx);

		const body = SERVER_TS.slice(startIdx, endIdx);
		// The legacy write must still happen.
		expect(body).toContain("writeFileSync(PID_PATH, String(process.pid))");
		// The framed write must be gone.
		expect(body).not.toContain("FRAMED_PATHS.pid");
		expect(body).not.toContain("writeFileSync(FRAMED_PATHS");
	});

	it("removePidFile in server.ts does NOT touch FRAMED_PATHS.pid", () => {
		const startIdx = SERVER_TS.indexOf("function removePidFile(): void {");
		expect(startIdx).toBeGreaterThan(0);
		const endIdx = SERVER_TS.indexOf("\n}\n", startIdx);
		expect(endIdx).toBeGreaterThan(startIdx);

		const body = SERVER_TS.slice(startIdx, endIdx);
		// Legacy removal stays — now via the dedup'd `removeFileIfExists` helper
		// (server decomposition ce71204), or a bare `rmSync`. Either form removes
		// the legacy PID; the assertion stays implementation-tolerant so a
		// behavior-preserving refactor doesn't false-fail this safety regression.
		expect(body).toMatch(/(?:rmSync|removeFileIfExists)\(PID_PATH\)/);
		// Framed removal must be gone — it's owned by session-daemon.handle.stop().
		expect(body).not.toContain("FRAMED_PATHS.pid");
	});

	it("session-daemon.ts is the sole writer of paths.pid (the framed file)", () => {
		// Confirm the framed PID write *does* live in session-daemon, AFTER
		// its ownership check. This pairs with the deletions above to prove
		// the responsibility moved, not vanished.
		expect(SESSION_DAEMON_TS).toContain("writeFileSync(paths.pid, String(process.pid))");

		// Sanity: the ownership check (process-alive guard) must come before
		// that write, otherwise we'd still have the same race.
		const checkIdx = SESSION_DAEMON_TS.indexOf("isProcessAlive(existingPid)");
		const writeIdx = SESSION_DAEMON_TS.indexOf(
			"writeFileSync(paths.pid, String(process.pid))",
		);
		expect(checkIdx).toBeGreaterThan(0);
		expect(writeIdx).toBeGreaterThan(checkIdx);
	});

	it("session-daemon.handle.stop removes paths.pid", () => {
		// The fix only works if session-daemon also owns the *cleanup* —
		// otherwise a dead daemon's PID file lingers and the next start
		// trips the alive-pid guard.
		const stopIdx = SESSION_DAEMON_TS.indexOf("async stop(");
		expect(stopIdx).toBeGreaterThan(0);
		const stopSlice = SESSION_DAEMON_TS.slice(stopIdx, stopIdx + 800);
		expect(stopSlice).toContain("paths.pid");
		expect(stopSlice).toContain("rmSync");
	});
});
