import { describe, expect, it } from "vitest";
import {
	formatDebtEvasionStopLine,
	isInlineExecCommand,
	markDebtWanderBlocked,
	noteWanderBlockDecision,
	trackDebtEvasion,
} from "./debt-evasion.js";
import { SessionTracker } from "./session-state.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

function bash(command: string, sessionId = "s"): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: sessionId,
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd: "/repo",
		timestamp: "t",
	};
}

describe("isInlineExecCommand", () => {
	it("matches interpreter eval flags", () => {
		expect(isInlineExecCommand(`node -e 'console.log(1)'`)).toBe(true);
		expect(isInlineExecCommand(`node --eval "x()"`)).toBe(true);
		expect(isInlineExecCommand(`python3 -c "print(1)"`)).toBe(true);
		expect(isInlineExecCommand(`perl -e 'print 1'`)).toBe(true);
	});

	it("matches inline exec buried mid-command", () => {
		expect(isInlineExecCommand(`git status && node -e "probe()"`)).toBe(true);
	});

	it("matches code piped into an interpreter", () => {
		expect(isInlineExecCommand(`cat probe.js | node`)).toBe(true);
		expect(isInlineExecCommand(`echo "print(1)" | python3`)).toBe(true);
	});

	it("matches a heredoc feeding an interpreter", () => {
		expect(isInlineExecCommand(`node <<'EOF'\nconsole.log(1)\nEOF`)).toBe(true);
	});

	it("does NOT match ordinary script invocations", () => {
		expect(isInlineExecCommand(`node scratch/measure.mjs`)).toBe(false);
		expect(isInlineExecCommand(`node dist/hook-entry.js --runner claude-code`)).toBe(false);
		expect(isInlineExecCommand(`npx vitest run src/foo.test.ts`)).toBe(false);
		expect(isInlineExecCommand(`python3 manage.py -c settings`)).toBe(false);
	});

	it("does NOT match pipes into non-interpreters", () => {
		expect(isInlineExecCommand(`history | grep node`)).toBe(false);
		expect(isInlineExecCommand(`rg -l "node" src | head -5`)).toBe(false);
	});
});

describe("trackDebtEvasion / markDebtWanderBlocked", () => {
	function fresh(): SessionTrajectory {
		return new SessionTracker().recordEvent(bash("ls"));
	}

	it("does not count inline exec before any debt block", () => {
		const s = fresh();
		trackDebtEvasion(s, bash(`node -e '1'`));
		expect(s.inline_exec_after_debt_block ?? 0).toBe(0);
	});

	it("counts inline exec after the session is marked debt-blocked", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1000);
		trackDebtEvasion(s, bash(`node -e '1'`));
		trackDebtEvasion(s, bash(`python3 -c 'print(1)'`));
		expect(s.inline_exec_after_debt_block).toBe(2);
	});

	it("ignores non-Bash events and non-inline commands after the mark", () => {
		const s = fresh();
		markDebtWanderBlocked(s, 1000);
		trackDebtEvasion(s, { ...bash("ls"), tool_name: "Edit" });
		trackDebtEvasion(s, bash("npx vitest run"));
		expect(s.inline_exec_after_debt_block ?? 0).toBe(0);
	});

	it("is wired into SessionTracker.recordEvent end-to-end", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(bash("ls", "e2e"));
		const session = tracker.get("e2e");
		expect(session).toBeDefined();
		if (!session) return;
		// Before the mark: recorded but not counted.
		tracker.recordEvent(bash(`node -e '1'`, "e2e"));
		expect(session.inline_exec_after_debt_block ?? 0).toBe(0);
		// After the mark: recordEvent itself counts.
		markDebtWanderBlocked(session, 1000);
		tracker.recordEvent(bash(`node -e '1'`, "e2e"));
		expect(session.inline_exec_after_debt_block).toBe(1);
	});
});

describe("noteWanderBlockDecision", () => {
	function trackerWith(sessionId: string): { tracker: SessionTracker; session: SessionTrajectory } {
		const tracker = new SessionTracker();
		const session = tracker.recordEvent(bash("ls", sessionId));
		return { tracker, session };
	}

	it("arms the counter on a debt-focus wander block", () => {
		const { tracker, session } = trackerWith("s1");
		noteWanderBlockDecision(
			tracker,
			bash("ls", "s1"),
			{ decision: "block", reason: "r", rule_id: "per-edit-coverage-debt" },
			1234,
		);
		expect(session.debt_wander_blocked_at_ms).toBe(1234);
	});

	it("ignores allows, nulls, and blocks from other rules", () => {
		const { tracker, session } = trackerWith("s2");
		noteWanderBlockDecision(tracker, bash("ls", "s2"), null, 1);
		noteWanderBlockDecision(tracker, bash("ls", "s2"), { decision: "allow" }, 2);
		noteWanderBlockDecision(
			tracker,
			bash("ls", "s2"),
			{ decision: "block", reason: "r", rule_id: "per-edit-coverage" },
			3,
		);
		expect(session.debt_wander_blocked_at_ms).toBeUndefined();
	});

	it("is a no-op for an unknown session id", () => {
		const { tracker } = trackerWith("s3");
		expect(() =>
			noteWanderBlockDecision(
				tracker,
				bash("ls", "missing"),
				{ decision: "block", reason: "r", rule_id: "per-edit-coverage-debt" },
				9,
			),
		).not.toThrow();
	});
});

describe("formatDebtEvasionStopLine", () => {
	it("is silent for a session with no evasion signal", () => {
		const s = new SessionTracker().recordEvent(bash("ls"));
		expect(formatDebtEvasionStopLine(s)).toBeNull();
	});

	it("reflects the count and the remedy once armed", () => {
		const s = new SessionTracker().recordEvent(bash("ls"));
		markDebtWanderBlocked(s, 1);
		trackDebtEvasion(s, bash(`node -e '1'`));
		const line = formatDebtEvasionStopLine(s);
		expect(line).toContain("[interlinked:debt-evasion]");
		expect(line).toContain("1 inline script(s)");
		expect(line).toContain("scratch/");
	});
});
