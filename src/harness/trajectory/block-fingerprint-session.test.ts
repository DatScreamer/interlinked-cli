import { describe, expect, it } from "vitest";
import { SessionTracker } from "../session-state.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { DEFAULT_FINGERPRINT_TTL_MS } from "./block-fingerprint.js";
import {
	detectWorkaround,
	formatWorkaroundStopLine,
	noteWorkaroundSignal,
	observeBlockWorkaround,
	recordBlockFingerprint,
} from "./block-fingerprint-session.js";
import { clearArchive, persistArmedFingerprints } from "./fingerprint-archive.js";

function write(filePath: string | undefined, content: string): HarnessEvent {
	const tool_input: Record<string, unknown> = { content };
	if (filePath !== undefined) tool_input.file_path = filePath;
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Write",
		tool_input,
		cwd: "/repo",
		timestamp: "t",
	};
}

function bash(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd: "/repo",
		timestamp: "t",
	};
}

function fresh(): SessionTrajectory {
	return new SessionTracker().recordEvent(bash("ls"));
}

const T0 = 1_000_000;

describe("recordBlockFingerprint", () => {
	it("arms a fingerprint on the session", () => {
		const s = fresh();
		recordBlockFingerprint(s, {
			ruleId: "empty_catch",
			content: "try { risky() } catch (e) {}",
			target: "src/a.ts",
			atMs: T0,
		});
		expect(s.block_fingerprints).toHaveLength(1);
		expect(s.block_fingerprints?.[0]?.ruleId).toBe("empty_catch");
		expect(s.block_fingerprints?.[0]?.target).toBe("src/a.ts");
	});

	it("prunes an expired fingerprint when a fresh one is recorded", () => {
		const s = fresh();
		recordBlockFingerprint(s, { ruleId: "old", content: "aaa bbb ccc", atMs: T0 });
		// A second block well past the TTL — the old one must be dropped.
		recordBlockFingerprint(s, {
			ruleId: "new",
			content: "ddd eee fff",
			atMs: T0 + DEFAULT_FINGERPRINT_TTL_MS + 1,
		});
		expect(s.block_fingerprints).toHaveLength(1);
		expect(s.block_fingerprints?.[0]?.ruleId).toBe("new");
	});
});

describe("detectWorkaround", () => {
	const blockedContent = "export function danger() { eval(userInput); return unsafe(); }";

	function armed(): SessionTrajectory {
		const s = fresh();
		recordBlockFingerprint(s, {
			ruleId: "eval_injection",
			content: blockedContent,
			target: "src/danger.ts",
			atMs: T0,
		});
		return s;
	}

	it("returns null when nothing is armed", () => {
		const s = fresh();
		expect(detectWorkaround(s, { content: blockedContent }, T0)).toBeNull();
	});

	it("D1 — flags the same refused content resurfacing through another channel", () => {
		const s = armed();
		const sig = detectWorkaround(s, { content: blockedContent }, T0 + 1000);
		expect(sig?.detector).toBe("same-content-resurfacing");
		expect(sig?.ruleId).toBe("eval_injection");
	});

	it("D1 — does NOT flag unrelated content", () => {
		const s = armed();
		const sig = detectWorkaround(
			s,
			{ content: "const total = numbers.reduce((a, b) => a + b, 0);" },
			T0 + 1000,
		);
		expect(sig).toBeNull();
	});

	it("D2 — flags a write to the same target path via a different channel", () => {
		const s = armed();
		const sig = detectWorkaround(s, { target: "src/danger.ts" }, T0 + 1000);
		expect(sig?.detector).toBe("same-target-different-channel");
	});

	it("D3 — flags a config/baseline loosening while a block is armed", () => {
		const s = armed();
		const sig = detectWorkaround(
			s,
			{ target: ".interlinked/guard-rules.local.json" },
			T0 + 1000,
		);
		expect(sig?.detector).toBe("config-loosening-in-window");
	});

	it("D4 — flags an escape-env bypass following a block", () => {
		const s = armed();
		const sig = detectWorkaround(
			s,
			{ command: "INTERLINKED_DISABLE_BASELINE_GUARD=1 git commit -m x" },
			T0 + 1000,
		);
		expect(sig?.detector).toBe("escape-env-after-block");
	});

	it("returns null once the fingerprint has expired (arming window closed)", () => {
		const s = armed();
		const sig = detectWorkaround(
			s,
			{ content: blockedContent, target: "src/danger.ts" },
			T0 + DEFAULT_FINGERPRINT_TTL_MS + 1,
		);
		expect(sig).toBeNull();
	});
});

describe("observeBlockWorkaround (choke-point glue)", () => {
	const BLOCK: HarnessDecision = { decision: "block", reason: "no", rule_id: "empty_catch" };
	const ALLOW: HarnessDecision = { decision: "allow" };

	it("fast-exits (no arming) on an allowed event when nothing is armed", () => {
		const s = fresh();
		const sig = observeBlockWorkaround(s, bash("echo hi"), ALLOW, "/repo", T0);
		expect(sig).toBeNull();
		expect(s.block_fingerprints ?? []).toHaveLength(0);
	});

	it("arms a fingerprint from the command when the event is blocked", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		expect(s.block_fingerprints).toHaveLength(1);
		expect(s.block_fingerprints?.[0]?.ruleId).toBe("empty_catch");
	});

	it("detects an escape-env bypass on a later ALLOWED event after a block armed it", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		const sig = observeBlockWorkaround(
			s,
			bash("INTERLINKED_DISABLE_BASELINE_GUARD=1 git commit -m x"),
			ALLOW,
			"/repo",
			T0 + 1000,
		);
		expect(sig?.detector).toBe("escape-env-after-block");
		expect(formatWorkaroundStopLine(s)).toContain("escape-env-after-block");
	});

	it("a still-blocked retry arms but never self-counts as a workaround", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		const sig = observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0 + 1000);
		expect(sig).toBeNull();
		expect(s.workaround_signals ?? []).toHaveLength(0);
	});

	it("arms a fingerprint from a blocked Write, extracting content + target via strField", () => {
		const s = fresh();
		observeBlockWorkaround(s, write("src/danger.ts", "eval(x)"), BLOCK, "/repo", T0);
		expect(s.block_fingerprints).toHaveLength(1);
		expect(s.block_fingerprints?.[0]?.target).toBe("src/danger.ts");
	});

	it("arms with a null target when a blocked Write carries no file_path/path", () => {
		const s = fresh();
		observeBlockWorkaround(s, write(undefined, "eval(x)"), BLOCK, "/repo", T0);
		expect(s.block_fingerprints).toHaveLength(1);
		expect(s.block_fingerprints?.[0]?.target).toBeNull();
	});

	it("hydrates persisted signals from a prior daemon on the first event of a fresh session", () => {
		const cwd = process.cwd();
		const sessionId = `hydrate-signals-${T0}`;
		persistArmedFingerprints(
			cwd,
			sessionId,
			[],
			[{ detector: "escape-env-after-block", ruleId: "empty_catch" }],
		);
		try {
			const s = new SessionTracker().recordEvent(bash("ls"));
			const event: HarnessEvent = { ...bash("echo hi"), session_id: sessionId };
			observeBlockWorkaround(s, event, ALLOW, cwd, T0);
			expect(s.workaround_signals).toEqual([
				{ detector: "escape-env-after-block", ruleId: "empty_catch" },
			]);
		} finally {
			clearArchive(cwd, sessionId);
		}
	});
});

describe("noteWorkaroundSignal + formatWorkaroundStopLine", () => {
	it("returns null with no signals recorded", () => {
		expect(formatWorkaroundStopLine(fresh())).toBeNull();
	});

	it("dedupes identical detector+rule signals", () => {
		const s = fresh();
		noteWorkaroundSignal(s, { detector: "escape-env-after-block", ruleId: "empty_catch" });
		noteWorkaroundSignal(s, { detector: "escape-env-after-block", ruleId: "empty_catch" });
		expect(s.workaround_signals).toHaveLength(1);
	});

	it("keeps distinct signals and names them in the Stop line", () => {
		const s = fresh();
		noteWorkaroundSignal(s, { detector: "same-content-resurfacing", ruleId: "eval_injection" });
		noteWorkaroundSignal(s, { detector: "config-loosening-in-window", ruleId: "coverage_gate" });
		const line = formatWorkaroundStopLine(s);
		expect(line).toContain("[interlinked:trajectory]");
		expect(line).toContain("2 workaround signal(s)");
		expect(line).toContain("eval_injection");
		expect(line).toContain("coverage_gate");
	});
});

describe("channel awareness — evasion vs remediation", () => {
	const REFUSED = "try { risky() } catch (e) {}";
	const arm = (channel: "write" | "command") => {
		const s = fresh();
		recordBlockFingerprint(s, { ruleId: "empty_catch", content: REFUSED, target: "src/a.ts", atMs: T0, channel });
		return s;
	};

	it("flags refused WRITE content that comes back through a bash command", () => {
		// The real evasion shape: the bash channel does not run the write gate.
		const signal = detectWorkaround(arm("write"), { content: REFUSED, command: REFUSED, channel: "command" }, T0 + 1000);
		expect(signal?.detector).toBe("same-content-resurfacing");
	});

	it("does NOT flag refused COMMAND content that comes back as a file write — command→write is compliance (2026-08-23 reversal)", () => {
		// The bash-redirect guards block shell writes precisely to force the
		// content through the fully-gated Write tool, and their block text says
		// so. Flagging the agent for following that advice taught the opposite
		// lesson (operator report, unrelated session). Script-staging evasion is
		// covered by the install-then-execute sequence detector instead.
		expect(detectWorkaround(arm("command"), { content: REFUSED, channel: "write" }, T0 + 1000)).toBeNull();
	});

	it("does NOT flag a same-channel retry — that is remediation, not evasion", () => {
		// This path is only reached when the gate ALLOWED the retry, which means
		// the agent fixed the objection. Measured: 11 of 11 signals in one session
		// were this, e.g. re-applying an edit after adding the missing import.
		expect(detectWorkaround(arm("write"), { content: REFUSED, channel: "write" }, T0 + 1000)).toBeNull();
	});

	it("does NOT flag a same-channel bash retry either", () => {
		expect(
			detectWorkaround(arm("command"), { content: REFUSED, command: REFUSED, channel: "command" }, T0 + 1000),
		).toBeNull();
	});

	it("still flags when the armed fingerprint predates channel tracking", () => {
		// An undefined channel must not silently disable the detector for
		// fingerprints persisted by an older daemon.
		const s = fresh();
		recordBlockFingerprint(s, { ruleId: "empty_catch", content: REFUSED, target: "src/a.ts", atMs: T0 });
		expect(detectWorkaround(s, { content: REFUSED, channel: "write" }, T0 + 1000)?.detector).toBe(
			"same-content-resurfacing",
		);
	});
});
