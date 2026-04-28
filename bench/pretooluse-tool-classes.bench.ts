// interlinked-tdd: exempt
// Bench files are not source modules with testable surface — they ARE the
// test surface for performance budgets, exercised via `npm run bench`. The
// existing `bench/evaluator-hot-path.bench.ts` follows the same convention.
//
// Latency bench across the three PreToolUse tool classes. Plan 11
// §"Tool-class bench scenarios" — each class has its own budget:
//
//   Read       p99 < 300 ms
//   Modify     p99 < 800 ms
//   Side-effect p99 < 2 000 ms
//
// All three are bounded by the SAME evaluator code path (`evaluatePreToolUse`)
// today; the budget difference matters once Phase A wires async runners into
// PostToolUse. We bench the pre-event path here because it's the agent-blocking
// surface — even if Phase A's parallelism makes Post fast, Pre stays on the
// hot path for every tool call.
//
// All scenarios run with the full 105-rule built-in set + Plan 01's keyword
// quick-reject + Plan 04's 9 inline detectors active.

import { bench, describe, expect } from "vitest";
import { evaluatePreToolUse } from "../src/harness/evaluator.js";
import { makeEvent, warmHarness } from "./_helpers/warm.js";

const harness = warmHarness();

describe("PreToolUse Read class (target p99 < 300 ms)", () => {
	bench(
		"Bash ls — no rule fires",
		() => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "ls -la /tmp" },
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(r.decision).toBe("allow");
		},
		{ iterations: 200, warmupIterations: 50 },
	);

	bench(
		"Read file_path — no rule fires",
		() => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "/tmp/hello.txt" },
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(r.decision).toBe("allow");
		},
		{ iterations: 200, warmupIterations: 50 },
	);
});

describe("PreToolUse Modify class (target p99 < 800 ms)", () => {
	bench(
		"Edit on a benign .ts file (no critical content)",
		() => {
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/tmp/example.ts",
					old_string: "const x = 1;",
					new_string: "const y = 2;",
				},
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(["allow", "ask"]).toContain(r.decision);
		},
		{ iterations: 200, warmupIterations: 50 },
	);

	bench(
		"Write benign .py content",
		() => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/example.py",
					content: "def add(a, b):\n    return a + b\n",
				},
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(["allow", "ask"]).toContain(r.decision);
		},
		{ iterations: 200, warmupIterations: 50 },
	);
});

describe("PreToolUse Side-effect class (target p99 < 2 s)", () => {
	bench(
		"Bash git push (force) — fires a guard rule",
		() => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "git push --force origin main" },
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(["block", "ask"]).toContain(r.decision);
		},
		{ iterations: 200, warmupIterations: 50 },
	);

	bench(
		"Bash terraform destroy — fires a guard rule (Plan 02)",
		() => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "terraform destroy" },
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(["block", "ask"]).toContain(r.decision);
		},
		{ iterations: 200, warmupIterations: 50 },
	);

	bench(
		"Bash npm command (worst case for keyword-quick-reject)",
		() => {
			// Plan 01 §1.3 keyword-quick-reject. An npm-only command should
			// skip every kubectl/docker/git/terraform/helm rule via keyword
			// filter, leaving only un-keyworded rules to evaluate. This
			// bench measures how cheap "irrelevant rule corpus" is in
			// practice.
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "npm install --save-dev @types/node" },
			});
			const r = evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
			expect(r.decision).toBe("allow");
		},
		{ iterations: 200, warmupIterations: 50 },
	);
});
