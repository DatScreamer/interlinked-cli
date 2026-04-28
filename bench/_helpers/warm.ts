// Shared setup for bench scenarios. Reuses the canonical fixtures from
// `src/harness/__tests__/evaluator.test.ts` so bench results are comparable
// against unit-test conditions.

import { CohortManager } from "../../src/harness/cohort.js";
import { ReservationManager } from "../../src/harness/reservations.js";
import { getDefaultConfig, loadRules } from "../../src/harness/rules-loader.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	SessionTrajectory,
} from "../../src/harness/types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

export interface WarmHarness {
	rules: GuardRulesConfig;
	session: SessionTrajectory;
	reservations: ReservationManager;
	cohort: CohortManager;
}

/** Build a fresh harness state with all built-in rules loaded. */
export function warmHarness(cwd: string = process.cwd()): WarmHarness {
	const rules = getDefaultConfig();
	const loaded = loadRules(cwd);
	rules.rules = loaded.rules;
	if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
	return {
		rules,
		session: makeSession(),
		reservations: new ReservationManager(),
		cohort: new CohortManager(),
	};
}

export function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "bench-session",
		agent_source: "claude",
		agent_name: "bench-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

export function makeSession(): SessionTrajectory {
	return {
		session_id: "bench-session",
		agent_name: "bench-agent",
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
	};
}
