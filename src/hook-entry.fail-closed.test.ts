// End-to-end fail-closed behavior through runHookEntry. The pure-function
// gate (coldDaemonUnreachableBlockReason / findRepoRoot) is unit-tested in
// hook-entry-daemon-gate.test.ts; this file proves the BLOCK actually reaches
// the agent through the adapter encoding when the daemon crashed mid-session.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHookEntry } from "./hook-entry.js";

describe("runHookEntry fails closed end-to-end when the daemon crashed", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "he-e2e-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		// Dead PID + no socket file = a crashed daemon → fail closed.
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "2147480000\n");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("blocks a PreToolUse with no reachable socket but a present pid file", async () => {
		const res = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				cwd: dir,
			},
			env: {},
			runner: "claude-code",
			cwd: dir,
		});
		// Claude encodes a PreToolUse deny as a permissionDecision on stdout
		// (exit 0), with the gate notice on stderr — assert the decision.
		expect(res.stdout).toContain('"permissionDecision":"deny"');
		expect(res.stdout).toContain("BLOCKED");
		expect(res.stderr).toContain("harness-offline");
	});

	it("allows the same call once the escape hatch is set", async () => {
		const res = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				cwd: dir,
			},
			env: { INTERLINKED_ALLOW_NO_DAEMON: "1" },
			runner: "claude-code",
			cwd: dir,
		});
		expect(res.exit_code).toBe(0);
	});
});
