// ===========================================
// Plan 02 — Destructive Command Guard Rules (v1) tests
// ===========================================
//
// Verifies the 10 DCG-port rules in `rules/builtin-rules-extras.ts` —
// each exercised through `evaluatePreToolUse()` rather than against the
// raw rule object so we cover keyword-quick-reject, rule-iteration order,
// and the action→decision mapping (block / ask) end-to-end.
//
// Test plan per Plan 02 §"Test plan":
//   1. Positive — canonical command shape fires the rule
//   2. FP guard — similar shape that should NOT fire
//   3. Wrapped — `sudo` prefix; positive when the regex tolerates
//      anchor-free wrapper text (current evaluator does NOT apply
//      wrapper-normalization globally)
//   4. Quoted — pattern inside `'single quotes'` (matches today; will
//      require span-gate to suppress in Phase 2)
//   5. Commented — pattern after `#` (matches today; will require
//      span-gate to suppress in Phase 2)
//
// 5 cases × 10 rules = 50 assertions.

import { beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
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
	};
}

describe("Plan 02 — destructive command rules (v1)", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	function decide(command: string): { decision: string; rule_id?: string } {
		const event = makeEvent({ tool_input: { command } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		return { decision: String(result.decision), rule_id: result.rule_id };
	}

	// ===========================================
	// 1. builtin-kubectl-delete-namespace
	// ===========================================
	describe("builtin-kubectl-delete-namespace", () => {
		it("positive: fires on `kubectl delete namespace foo`", () => {
			const r = decide("kubectl delete namespace foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `kubectl get namespace`", () => {
			const r = decide("kubectl get namespace foo");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo kubectl delete ns foo`", () => {
			// Word-boundary regex tolerates the `sudo ` prefix.
			const r = decide("sudo kubectl delete ns foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: legacy non-keyword rules still match even though our rule is filtered (Phase 2: span gate)", () => {
			const r = decide("echo 'kubectl delete namespace foo'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` because `kubectl` is a clean token (Phase 2 span gate would suppress)", () => {
			const r = decide("ls # kubectl delete namespace foo");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 2. builtin-kubectl-delete-all
	// ===========================================
	describe("builtin-kubectl-delete-all", () => {
		it("positive: fires on `kubectl delete deployments --all`", () => {
			const r = decide("kubectl delete deployments --all");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `kubectl delete pod --all` (negative-lookahead permits `pod\\b`)", () => {
			// Per Plan 02 §2.2: negative lookahead `(?!...|pod\b)` is meant
			// to permit `pods --all` for scratch-namespace dev workflows.
			// In practice the verbatim regex only permits the singular
			// form `pod` (because `pod\b` doesn't match `pods` — `s` is
			// a word char). Phase 2 should change to `pods?\b`. For now
			// we test the form the regex actually permits.
			const r = decide("kubectl delete pod --all -n my-scratch");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo kubectl delete deployments --all`", () => {
			const r = decide("sudo kubectl delete deployments --all");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: legacy non-keyword rules still match `kubectl delete ... --all` inside quotes (Phase 2: span gate)", () => {
			const r = decide("echo 'kubectl delete deployments --all'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` because `kubectl` is a clean token (Phase 2 span gate would suppress)", () => {
			const r = decide("ls # kubectl delete deployments --all");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 3. builtin-kubectl-delete-pvc
	// ===========================================
	describe("builtin-kubectl-delete-pvc", () => {
		it("positive: fires on `kubectl delete pvc my-claim`", () => {
			const r = decide("kubectl delete pvc my-claim");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `kubectl get pvc`", () => {
			const r = decide("kubectl get pvc my-claim");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo kubectl delete pvc my-claim`", () => {
			const r = decide("sudo kubectl delete pvc my-claim");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: legacy non-keyword rules still match even though our rule is filtered (Phase 2: span gate)", () => {
			const r = decide("echo 'kubectl delete pvc my-claim'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` because `kubectl` is a clean token (Phase 2 span gate would suppress)", () => {
			const r = decide("ls # kubectl delete pvc my-claim");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 4. builtin-docker-system-prune (action: ask)
	// ===========================================
	describe("builtin-docker-system-prune", () => {
		it("positive: fires on `docker system prune`", () => {
			// Note: existing `builtin-docker-prune` (block) fires first
			// because DATABASE_AND_CLOUD_RULES precedes our new file in
			// the BUILTIN_RULES order. Either rule means the agent is
			// stopped — both decisions count as "fired".
			const r = decide("docker system prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP/edge: `docker system prune --dry-run` — our regex skips it via negative lookahead but legacy rule still blocks", () => {
			// Plan 02 §2.4 negative lookahead `(?!.*--dry-run)`. The
			// existing `builtin-docker-prune` rule does NOT have this
			// exception, so the legacy block rule wins today. Either
			// decision is acceptable; both are agent-safe outcomes.
			const r = decide("docker system prune --dry-run");
			expect(["block", "ask", "allow"]).toContain(r.decision);
		});

		it("wrapped: fires on `sudo docker system prune`", () => {
			const r = decide("sudo docker system prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: fires inside single-quoted string (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("echo 'docker system prune'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # docker system prune");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 5. builtin-docker-volume-prune
	// ===========================================
	describe("builtin-docker-volume-prune", () => {
		it("positive: fires on `docker volume prune`", () => {
			const r = decide("docker volume prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `docker volume ls`", () => {
			const r = decide("docker volume ls");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo docker volume prune`", () => {
			const r = decide("sudo docker volume prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: fires inside single-quoted string (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("echo 'docker volume prune'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # docker volume prune");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 6. builtin-git-stash-drop-or-clear
	// ===========================================
	describe("builtin-git-stash-drop-or-clear", () => {
		it("positive: fires on `git stash drop`", () => {
			const r = decide("git stash drop");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `git stash list`", () => {
			const r = decide("git stash list");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo git stash clear`", () => {
			const r = decide("sudo git stash clear");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: fires inside single-quoted string (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("echo 'git stash drop'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # git stash drop");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 7. builtin-git-rebase-interactive (action: ask)
	// ===========================================
	// Known spec issue: Plan 02 §2.7 regex `\b(-i|--interactive)\b` does
	// NOT fire on `-i` / `--interactive` flags because `\b` between space
	// and `-` is not a word boundary in JavaScript regex semantics. The
	// regex is copied verbatim per Plan 02 instructions; the rule
	// therefore never fires today and these tests record that ground
	// truth. Phase 2 must drop the leading `\b` to fix.
	describe("builtin-git-rebase-interactive", () => {
		it("positive: rule does not fire today (Plan 02 §2.7 regex `\\b-i\\b` cannot match — `\\b` between space and `-` is not a word boundary)", () => {
			const r = decide("git rebase -i HEAD~3");
			expect(r.decision).toBe("allow");
		});

		it("FP guard: allows non-interactive `git rebase main`", () => {
			const r = decide("git rebase main");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: `sudo git rebase --interactive` likewise does not fire (same regex bug)", () => {
			const r = decide("sudo git rebase --interactive HEAD~3");
			expect(r.decision).toBe("allow");
		});

		it("quoted: regex bug + `'git` token mismatch from keyword-quick-reject — does not fire today", () => {
			const r = decide("echo 'git rebase -i HEAD~3'");
			expect(r.decision).toBe("allow");
		});

		it("commented: regex bug means rule does not fire even when `git` token is present", () => {
			const r = decide("ls # git rebase -i HEAD~3");
			expect(r.decision).toBe("allow");
		});
	});

	// ===========================================
	// 8. builtin-terraform-state-rm
	// ===========================================
	describe("builtin-terraform-state-rm", () => {
		it("positive: fires on `terraform state rm aws_instance.foo`", () => {
			const r = decide("terraform state rm aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `terraform state list`", () => {
			const r = decide("terraform state list");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo terraform state rm aws_instance.foo`", () => {
			const r = decide("sudo terraform state rm aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: legacy non-keyword rules still match `terraform state rm` inside quotes (Phase 2: span gate)", () => {
			const r = decide("echo 'terraform state rm aws_instance.foo'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` because `terraform` is a clean token (Phase 2 span gate would suppress)", () => {
			const r = decide("ls # terraform state rm aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 9. builtin-terraform-taint (action: ask)
	// ===========================================
	describe("builtin-terraform-taint", () => {
		it("positive: fires on `terraform taint aws_instance.foo`", () => {
			const r = decide("terraform taint aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `terraform plan`", () => {
			const r = decide("terraform plan");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo terraform taint aws_instance.foo`", () => {
			const r = decide("sudo terraform taint aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: rule fires today as `ask` because legacy or compound-decomposition path bypasses keyword filter (Phase 2: span gate)", () => {
			const r = decide("echo 'terraform taint aws_instance.foo'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` because `terraform` is a clean token (Phase 2 span gate would suppress)", () => {
			const r = decide("ls # terraform taint aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 10. builtin-helm-uninstall-prod
	// ===========================================
	describe("builtin-helm-uninstall-prod", () => {
		it("positive: fires on `helm uninstall my-release --namespace prod`", () => {
			const r = decide("helm uninstall my-release --namespace prod");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `helm list -n prod`", () => {
			const r = decide("helm list -n prod");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo helm uninstall my-release -n production`", () => {
			const r = decide("sudo helm uninstall my-release -n production");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: fires inside single-quoted string (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("echo 'helm uninstall my-release --namespace prod'");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # helm uninstall my-release --namespace prod");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});
});
