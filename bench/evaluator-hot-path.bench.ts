// Latency bench for evaluatePreToolUse — Plan 11 §"Tool-class bench scenarios".
//
// Phase-1 scaffolding ships ONE Read-class scenario with NO threshold
// enforcement. We measure first; thresholds get locked in a follow-up commit
// once Plan 01's evaluator upgrades land and a stable warm-daemon p99 baseline
// exists. Every additional scenario (Modify, Side-effect) added later follows
// the same shape — `bench()` block with a single representative call.

import { bench, describe } from "vitest";
import { evaluatePreToolUse } from "../src/harness/evaluator.js";
import { makeEvent, warmHarness } from "./_helpers/warm.js";

const harness = warmHarness();

describe("PreToolUse — Read class (target p99 < 300ms)", () => {
	bench(
		"Bash ls — no rule fires",
		() => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "ls -la /tmp" },
			});
			evaluatePreToolUse(
				event,
				harness.rules,
				harness.session,
				harness.reservations,
				harness.cohort,
			);
		},
		{ iterations: 200, warmupIterations: 50 },
	);
});
