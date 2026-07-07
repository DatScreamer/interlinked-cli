import { beforeEach, describe, expect, it } from "vitest";
import type { Verdict } from "../trajectory/types.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	__resetTrajectoryShadowForTest,
	formatTrajectoryVerdict,
	mergeTrajectoryShadow,
	trajectoryShadowWarnings,
} from "./trajectory-shadow.js";

const CONFIG_ON = { trajectory_shadow: { enabled: true } };
const CONFIG_OFF = { trajectory_shadow: { enabled: false } };
const ALLOW: HarnessDecision = { decision: "allow" };

interface EditSpec {
	file: string;
	from: string;
	to: string;
	step: string;
}

function postEdit({ file, from, to, step }: EditSpec): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Edit",
		tool_use_id: `tu-${step}`,
		tool_input: { file_path: file, old_string: from, new_string: to },
		tool_outcome: "success",
		tool_response_sha256: `sha-${step}`,
		timestamp: "2026-07-01T00:00:00.000Z",
	};
}

beforeEach(() => {
	__resetTrajectoryShadowForTest();
});

describe("formatTrajectoryVerdict", () => {
	it("renders a block-catalog verdict as a non-blocking metric line, never a decision", () => {
		const verdict: Verdict = {
			ruleId: "sec_env_add_then_git_commit",
			action: "block",
			severity: "high",
			reason: "BLOCKED: a secret would be committed.",
		};
		const line = formatTrajectoryVerdict(verdict);
		expect(line.startsWith("[interlinked:trajectory]")).toBe(true);
		expect(line).toContain("sec_env_add_then_git_commit");
		expect(line).toContain("shadow — would block"); // the action is reported, never enacted
	});
});

describe("trajectoryShadowWarnings", () => {
	it("surfaces a firing rule as an [interlinked:trajectory] warning", () => {
		trajectoryShadowWarnings(postEdit({ file: "/x.ts", from: "foo", to: "bar", step: "1" }), ALLOW, CONFIG_ON);
		const warnings = trajectoryShadowWarnings(
			postEdit({ file: "/x.ts", from: "bar", to: "foo", step: "2" }),
			ALLOW,
			CONFIG_ON,
		);
		expect(warnings.some((w) => w.includes("churn_literal_edit_revert"))).toBe(true);
		expect(warnings.every((w) => w.startsWith("[interlinked:trajectory]"))).toBe(true);
	});

	it("is silent when the shadow flag is disabled (negative path)", () => {
		trajectoryShadowWarnings(postEdit({ file: "/x.ts", from: "foo", to: "bar", step: "1" }), ALLOW, CONFIG_OFF);
		expect(
			trajectoryShadowWarnings(postEdit({ file: "/x.ts", from: "bar", to: "foo", step: "2" }), ALLOW, CONFIG_OFF),
		).toEqual([]);
	});

	it("ignores non-forwarded lifecycle events such as SessionStart (negative path)", () => {
		const sessionStart: HarnessEvent = {
			hook_event: "SessionStart",
			session_id: "sess-1",
			agent_source: "claude",
			timestamp: "2026-07-01T00:00:00.000Z",
		};
		expect(trajectoryShadowWarnings(sessionStart, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("forwards Stop events so the Stop-gated obligation inventory can fire", () => {
		// Open an obligation (a TODO the session never closes), then Stop.
		trajectoryShadowWarnings(
			postEdit({ file: "/z.ts", from: "x", to: "// TODO wire this", step: "1" }),
			ALLOW,
			CONFIG_ON,
		);
		const stop: HarnessEvent = {
			hook_event: "Stop",
			session_id: "sess-1",
			agent_source: "claude",
			timestamp: "2026-07-01T00:00:00.000Z",
		};
		const warnings = trajectoryShadowWarnings(stop, ALLOW, CONFIG_ON);
		expect(warnings.some((w) => w.includes("obl_net_open_at_stop"))).toBe(true);
	});
});

describe("mergeTrajectoryShadow", () => {
	it("appends warnings without ever changing the decision verdict", () => {
		trajectoryShadowWarnings(postEdit({ file: "/y.ts", from: "a", to: "b", step: "1" }), ALLOW, CONFIG_ON); // seed
		const decision: HarnessDecision = { decision: "allow", warnings: ["existing"] };
		mergeTrajectoryShadow(postEdit({ file: "/y.ts", from: "b", to: "a", step: "2" }), decision, CONFIG_ON);
		expect(decision.decision).toBe("allow"); // verdict never mutated — shadow is metric-only
		expect(decision.warnings).toContain("existing"); // prior warnings preserved
		expect(decision.warnings?.some((w) => w.includes("churn_literal_edit_revert"))).toBe(true);
	});
});
