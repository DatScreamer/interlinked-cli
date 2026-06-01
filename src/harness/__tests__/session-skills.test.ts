import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gcExpiredSkills,
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
} from "../session-skills.js";
import type { SessionTrajectory } from "../types.js";

// Companion suite for session-skills.ts, importing the active-skill markers
// directly from the new module (the broader integration coverage that goes
// through the session-state.js barrel lives in active-skills.test.ts).

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
		assertion_counts: new Map(),
		...overrides,
	};
}

describe("recordSkillEnter (session-skills module)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates the active_skills map lazily and inserts a cli-sourced record", () => {
		const session = makeSession();
		expect(session.active_skills).toBeUndefined();

		const record = recordSkillEnter(session, { name: "ship" });
		expect(session.active_skills?.size).toBe(1);
		expect(record.name).toBe("ship");
		expect(record.entered_at).toBe(FIXED_NOW);
		expect(record.source).toBe("cli");
	});

	it("uses the default 30-minute TTL when none is provided", () => {
		const session = makeSession();
		const record = recordSkillEnter(session, { name: "ship" });
		expect(record.expires_at - record.entered_at).toBe(30 * 60 * 1000);
	});

	it("clamps oversize TTLs to the 4-hour ceiling and undersize TTLs to the 60s floor", () => {
		const session = makeSession();
		const big = recordSkillEnter(session, { name: "big", ttl_seconds: 24 * 60 * 60 });
		expect(big.expires_at - big.entered_at).toBe(4 * 60 * 60 * 1000);
		const small = recordSkillEnter(session, { name: "small", ttl_seconds: 5 });
		expect(small.expires_at - small.entered_at).toBe(60 * 1000);
	});

	it("re-entering a skill refreshes the TTL and overwrites the record", () => {
		const session = makeSession();
		const first = recordSkillEnter(session, { name: "ship", ttl_seconds: 600 });
		vi.setSystemTime(FIXED_NOW + 5 * 60 * 1000);
		const second = recordSkillEnter(session, { name: "ship", ttl_seconds: 1200 });
		expect(session.active_skills?.size).toBe(1);
		expect(second.entered_at).toBeGreaterThan(first.entered_at);
		expect(second.expires_at - second.entered_at).toBe(1200 * 1000);
	});

	it("preserves the supplied source label", () => {
		const session = makeSession();
		expect(recordSkillEnter(session, { name: "ship", source: "hook" }).source).toBe("hook");
	});
});

describe("recordSkillLeave (session-skills module)", () => {
	it("returns true removing an existing marker, false otherwise", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "ship" });
		expect(recordSkillLeave(session, "ship")).toBe(true);
		expect(session.active_skills?.size).toBe(0);
		expect(recordSkillLeave(session, "ship")).toBe(false);
	});

	it("returns false when the map was never created", () => {
		const session = makeSession();
		expect(recordSkillLeave(session, "ship")).toBe(false);
	});
});

describe("gcExpiredSkills + getActiveSkills (session-skills module)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops only the expired markers and counts them", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "ship", ttl_seconds: 600 });
		recordSkillEnter(session, { name: "review", ttl_seconds: 60 });

		vi.setSystemTime(FIXED_NOW + 120 * 1000);
		expect(gcExpiredSkills(session)).toBe(1);
		expect(session.active_skills?.has("ship")).toBe(true);
		expect(session.active_skills?.has("review")).toBe(false);
	});

	it("gcExpiredSkills is a no-op when active_skills is undefined", () => {
		expect(gcExpiredSkills(makeSession())).toBe(0);
	});

	it("getActiveSkills returns the post-GC snapshot", () => {
		const session = makeSession();
		recordSkillEnter(session, { name: "ship", ttl_seconds: 600 });
		recordSkillEnter(session, { name: "review", ttl_seconds: 60 });

		vi.setSystemTime(FIXED_NOW + 120 * 1000);
		expect(getActiveSkills(session).map((s) => s.name)).toEqual(["ship"]);
	});

	it("getActiveSkills returns [] when active_skills is undefined", () => {
		expect(getActiveSkills(makeSession())).toEqual([]);
	});
});
