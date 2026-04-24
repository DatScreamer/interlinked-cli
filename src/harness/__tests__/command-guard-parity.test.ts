// ===========================================
// Parity Test: Old command-guard-hook.ts vs Harness Built-in Rules
// ===========================================
// Proves that every command the old .claude/hooks/command-guard-hook.ts
// would block is also blocked by the harness's evaluatePreToolUse().
// This test is the gate for removing the old hook.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

function makeEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: new Date().toISOString(),
	};
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: new Date().toISOString(),
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
		last_coordination_ts: Date.now(),
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
	};
}

describe("command-guard-hook.ts parity with harness", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	function runGuard(command: string): string {
		const event = makeEvent(command);
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		return String(result.decision);
	}

	function _expectBlocked(command: string): string {
		const decision = runGuard(command);
		expect(decision, `Expected "${command}" to be blocked`).toBe("block");
		return decision;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ===========================================
	// Process Killing — Direct commands
	// Old hook patterns 1-8
	// ===========================================
	describe("process killing (direct)", () => {
		it("blocks pkill -f", () => {
			expect(runGuard("pkill -f myprocess")).toBe("block");
		});

		it("blocks pkill -9", () => {
			expect(runGuard("pkill -9 myprocess")).toBe("block");
		});

		it("blocks killall (not -l)", () => {
			expect(runGuard("killall node")).toBe("block");
		});

		it("blocks pkill wrangler", () => {
			expect(runGuard("pkill wrangler")).toBe("block");
		});

		it("blocks pkill node", () => {
			expect(runGuard("pkill node")).toBe("block");
		});

		it("blocks pkill bun", () => {
			expect(runGuard("pkill bun")).toBe("block");
		});

		it("blocks pkill python", () => {
			expect(runGuard("pkill python")).toBe("block");
		});

		it("blocks pkill claude", () => {
			expect(runGuard("pkill claude")).toBe("block");
		});
	});

	// ===========================================
	// Process Killing — Indirect patterns
	// Old hook patterns 9-13
	// ===========================================
	describe("process killing (indirect)", () => {
		it("blocks pgrep | xargs kill", () => {
			expect(runGuard("pgrep node | xargs kill")).toBe("block");
		});

		it("blocks kill $(pgrep ...)", () => {
			expect(runGuard("kill $(pgrep node)")).toBe("block");
		});

		it("blocks kill `pgrep ...`", () => {
			expect(runGuard("kill `pgrep node`")).toBe("block");
		});

		it("blocks ps aux | grep | kill", () => {
			expect(runGuard("ps aux | grep node | xargs kill")).toBe("block");
		});
	});

	// ===========================================
	// Dangerous rm
	// Old hook patterns 14-15
	// ===========================================
	describe("dangerous rm", () => {
		it("blocks rm on root paths", () => {
			expect(runGuard("rm -rf /usr")).toBe("block");
		});

		it("blocks rm -rf *", () => {
			expect(runGuard("rm -rf *")).toBe("block");
		});
	});

	// ===========================================
	// Local Development State
	// Old hook patterns 16-18
	// ===========================================
	describe("local development state", () => {
		it("blocks rm .wrangler", () => {
			expect(runGuard("rm -rf .wrangler")).toBe("block");
		});

		it("blocks rm .wrangler/state", () => {
			expect(runGuard("rm -rf .wrangler/state")).toBe("block");
		});

		it("blocks rm node_modules", () => {
			expect(runGuard("rm -rf node_modules")).toBe("block");
		});
	});

	// ===========================================
	// Git Force Operations
	// Old hook patterns 19-21
	// ===========================================
	describe("git operations", () => {
		it("blocks git push --force", () => {
			expect(runGuard("git push --force origin main")).toBe("block");
		});

		it("blocks git reset --hard", () => {
			expect(runGuard("git reset --hard HEAD~1")).toBe("block");
		});

		it("blocks git clean -f", () => {
			expect(runGuard("git clean -f")).toBe("block");
		});
	});

	// ===========================================
	// System Operations
	// Old hook patterns 22-23
	// ===========================================
	describe("system operations", () => {
		it("blocks sudo rm", () => {
			expect(runGuard("sudo rm /etc/hosts")).toBe("block");
		});

		it("blocks chmod -R 777", () => {
			expect(runGuard("chmod -R 777 .")).toBe("block");
		});

		it("blocks chmod 777", () => {
			expect(runGuard("chmod 777 mydir")).toBe("block");
		});
	});

	// ===========================================
	// Database Destruction
	// Old hook patterns 24-25
	// ===========================================
	describe("database destruction", () => {
		it("blocks DROP DATABASE", () => {
			expect(runGuard("echo 'DROP DATABASE mydb;' | psql")).toBe("block");
		});

		it("blocks TRUNCATE TABLE", () => {
			expect(runGuard("echo 'TRUNCATE TABLE users;' | psql")).toBe("block");
		});
	});

	// ===========================================
	// Intentional differences (old hook blocked, harness does not)
	// ===========================================
	describe("intentional differences (harness is less aggressive)", () => {
		it("does NOT block pgrep -f alone (read-only, not destructive)", () => {
			const event = makeEvent("pgrep -f node");
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			// pgrep -f is information gathering — not destructive
			// The harness correctly does NOT block it
			expect(result.decision).toBe("allow");
		});

		it("does NOT block killall -l (listing only)", () => {
			const event = makeEvent("killall -l");
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Harness extras not in old hook (regression guard)
	// ===========================================
	describe("harness extras beyond old hook", () => {
		it("blocks git checkout -- .", () => {
			expect(runGuard("git checkout -- .")).toBe("block");
		});

		it("blocks git branch -D", () => {
			expect(runGuard("git branch -D feature-branch")).toBe("block");
		});

		it("blocks docker system prune", () => {
			expect(runGuard("docker system prune")).toBe("block");
		});

		it("blocks terraform destroy", () => {
			expect(runGuard("terraform destroy")).toBe("block");
		});

		it("blocks rm of lock files", () => {
			expect(runGuard("rm package-lock.json")).toBe("block");
		});

		it("blocks shred", () => {
			expect(runGuard("shred /tmp/file")).toBe("block");
		});
	});
});
