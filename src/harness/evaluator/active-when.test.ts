import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardRule, HarnessEvent, SessionTrajectory } from "../types.js";
import { recordSkillEnter } from "../session-state.js";
import { describeActiveWhen, evaluateActiveWhen } from "./active-when.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		...overrides,
	};
}

function makeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "block",
		patterns: [],
		reason: "test",
		severity: "high",
		...overrides,
	};
}

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

describe("evaluateActiveWhen — no active_when", () => {
	it("returns true (always-on) when active_when is absent", () => {
		const rule = makeRule();
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(true);
	});

	it("returns true with empty active_when {}", () => {
		const rule = makeRule({ active_when: {} });
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(true);
	});
});

describe("evaluateActiveWhen — skill axis", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("dormant when no skills are active", () => {
		const rule = makeRule({ active_when: { skill: "ship" } });
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(false);
	});

	it("live when the named skill is active", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "ship" });
		const rule = makeRule({ active_when: { skill: "ship" } });
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(true);
	});

	it("dormant when a different skill is active", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "review" });
		const rule = makeRule({ active_when: { skill: "ship" } });
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(false);
	});

	it("OR semantics: live when any listed skill is active", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "review" });
		const rule = makeRule({ active_when: { skill: ["ship", "review"] } });
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(true);
	});

	it("dormant when the skill is expired (TTL elapsed)", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "ship", ttl_seconds: 60 });
		vi.setSystemTime(FIXED_NOW + 120 * 1000);
		const rule = makeRule({ active_when: { skill: "ship" } });
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(false);
	});

	it("dormant when session is undefined", () => {
		const rule = makeRule({ active_when: { skill: "ship" } });
		expect(evaluateActiveWhen(rule, undefined, makeEvent())).toBe(false);
	});
});

describe("evaluateActiveWhen — phase axis", () => {
	it("always dormant in v1 (no phase state machines wired)", () => {
		const rule = makeRule({
			active_when: { phase: { name: "ship_phase", value: "verifying" } },
		});
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(false);
	});
});

describe("evaluateActiveWhen — after_command axis", () => {
	it("dormant when commands_run is empty", () => {
		const rule = makeRule({
			active_when: { after_command: { pattern: "^/ship\\b", window_steps: 5 } },
		});
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(false);
	});

	it("live when a recent command matches the pattern", () => {
		const session = makeSession({ commands_run: ["git status", "/ship", "git diff"] });
		const rule = makeRule({
			active_when: { after_command: { pattern: "^/ship\\b", window_steps: 5 } },
		});
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(true);
	});

	it("dormant when the matching command is outside the window", () => {
		const recent = Array.from({ length: 8 }, (_, i) => `step-${i}`);
		const session = makeSession({ commands_run: ["/ship", ...recent] });
		const rule = makeRule({
			active_when: { after_command: { pattern: "^/ship\\b", window_steps: 5 } },
		});
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(false);
	});

	it("uses default window of 10 when omitted", () => {
		const recent = Array.from({ length: 5 }, (_, i) => `step-${i}`);
		const session = makeSession({ commands_run: ["/ship", ...recent] });
		const rule = makeRule({
			active_when: { after_command: { pattern: "^/ship\\b" } },
		});
		expect(evaluateActiveWhen(rule, session, makeEvent())).toBe(true);
	});
});

describe("evaluateActiveWhen — file_scope axis", () => {
	it("live when event file_path matches", () => {
		const event = makeEvent({ tool_input: { file_path: "src/foo.ts" } });
		const rule = makeRule({ active_when: { file_scope: "^src/" } });
		expect(evaluateActiveWhen(rule, makeSession(), event)).toBe(true);
	});

	it("dormant when event file_path doesn't match", () => {
		const event = makeEvent({ tool_input: { file_path: "tests/foo.test.ts" } });
		const rule = makeRule({ active_when: { file_scope: "^src/" } });
		expect(evaluateActiveWhen(rule, makeSession(), event)).toBe(false);
	});

	it("dormant when event has no file_path", () => {
		const rule = makeRule({ active_when: { file_scope: "^src/" } });
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(false);
	});
});

describe("evaluateActiveWhen — agent_source / overlay axes", () => {
	it("live when agent_source matches the listed overlay", () => {
		const rule = makeRule({ active_when: { overlay: "claude" } });
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent({ agent_source: "claude" }))).toBe(
			true,
		);
	});

	it("dormant when agent_source is not in overlay list", () => {
		const rule = makeRule({ active_when: { overlay: ["claude", "cursor"] } });
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent({ agent_source: "codex" }))).toBe(
			false,
		);
	});

	it("agent_source axis behaves the same way", () => {
		const rule = makeRule({ active_when: { agent_source: "codex" } });
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent({ agent_source: "codex" }))).toBe(
			true,
		);
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent({ agent_source: "claude" }))).toBe(
			false,
		);
	});
});

describe("evaluateActiveWhen — predicate escape hatch", () => {
	it("always dormant (v1 fail-safe; design contract requires action=ask)", () => {
		const rule = makeRule({
			active_when: { predicate: { name: "tests_passed_recently", args: { window_steps: 5 } } },
		});
		expect(evaluateActiveWhen(rule, makeSession(), makeEvent())).toBe(false);
	});
});

describe("evaluateActiveWhen — AND across axes", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("all axes must hold for the rule to be live", () => {
		const session = makeSession({ commands_run: ["/ship"] });
		recordSkillEnter(session, { name: "ship" });
		const event = makeEvent({
			tool_input: { file_path: "src/foo.ts" },
			agent_source: "claude",
		});

		const allMatching = makeRule({
			active_when: {
				skill: "ship",
				after_command: { pattern: "^/ship\\b" },
				file_scope: "^src/",
				agent_source: "claude",
			},
		});
		expect(evaluateActiveWhen(allMatching, session, event)).toBe(true);

		const oneFailing = makeRule({
			active_when: {
				skill: "ship",
				after_command: { pattern: "^/ship\\b" },
				file_scope: "^src/",
				agent_source: "codex",
			},
		});
		expect(evaluateActiveWhen(oneFailing, session, event)).toBe(false);
	});
});

describe("describeActiveWhen", () => {
	it("returns 'always-on' for absent active_when", () => {
		expect(describeActiveWhen(undefined)).toBe("always-on");
		expect(describeActiveWhen({})).toBe("always-on");
	});

	it("formats single-skill axis", () => {
		expect(describeActiveWhen({ skill: "ship" })).toContain("skill∈{ship}");
	});

	it("joins multiple axes with AND", () => {
		const desc = describeActiveWhen({
			skill: ["ship", "review"],
			file_scope: "^src/",
		});
		expect(desc).toContain("skill∈{ship,review}");
		expect(desc).toContain("file_scope~/^src/");
		expect(desc).toContain("∧");
	});
});
