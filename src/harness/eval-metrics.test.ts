import { describe, expect, it } from "vitest";
import {
	type ArmCellSummary,
	aggregateMetrics,
	compareArms,
	type EvalMetrics,
	extractEvalMetrics,
	isVerifierCommand,
	noiseRatio,
	taskVerdict,
} from "./eval-metrics.js";

// Synthetic activity.jsonl lines mirroring the real schema_version 5 events
// (verified against this repo's .interlinked/activity.jsonl: tool_use_start /
// tool_use / guard_block / guard_warn / guard_allow with guard_* fields).

function ev(fields: Record<string, unknown>): string {
	return JSON.stringify({ schema_version: 5, ts: "2026-07-06T00:00:00.000Z", session: "s1", ...fields });
}

function start(tool: string): string {
	return ev({ type: "tool_use_start", hook: "PreToolUse", tool });
}

function done(tool: string, command?: string): string {
	const fields: Record<string, unknown> = { type: "tool_use", hook: "PostToolUse", tool };
	if (command !== undefined) fields.tool_input = { command };
	return ev(fields);
}

interface BlockFields {
	rule?: string | null;
	tool?: string | null;
	reason?: string;
}

function block(fields: BlockFields): string {
	return ev({
		type: "guard_block",
		hook: "PreToolUse",
		tool: fields.tool ?? null,
		guard_decision: "block",
		guard_rule_id: fields.rule ?? null,
		guard_reason: fields.reason ?? null,
	});
}

function warn(warnings?: string[]): string {
	return ev({
		type: "guard_warn",
		hook: "PreToolUse",
		tool: "Bash",
		guard_decision: "warn",
		guard_warnings: warnings ?? null,
	});
}

function zeroMetrics(over?: Partial<EvalMetrics>): EvalMetrics {
	return {
		blocks: {},
		blocks_total: 0,
		warnings: 0,
		edits: 0,
		verifier_runs: 0,
		block_retry_success: 0,
		block_loops: 0,
		turns: 0,
		...over,
	};
}

interface CellFields {
	arm: "on" | "off";
	rep: number;
	success: boolean;
	over?: Partial<EvalMetrics>;
}

function cell(fields: CellFields): ArmCellSummary {
	return { arm: fields.arm, rep: fields.rep, success: fields.success, metrics: zeroMetrics(fields.over) };
}

describe("extractEvalMetrics", () => {
	it("counts blocks by rule id, total blocks, and turns (positive)", () => {
		const m = extractEvalMetrics([
			start("Write"),
			block({ rule: "tdd_new_file_gate", tool: "Write" }),
			start("Write"),
			block({ rule: "tdd_new_file_gate", tool: "Write" }),
			start("Bash"),
			block({ tool: "Bash", reason: "BLOCKED: `cat` requesting 101 lines without a downstream filter" }),
			start("Read"),
		]);
		expect(m.blocks.tdd_new_file_gate).toBe(2);
		expect(m.blocks_total).toBe(3);
		expect(m.turns).toBe(4);
		const unattributed = Object.keys(m.blocks).filter((k) => k.startsWith("unattributed:"));
		expect(unattributed).toHaveLength(1);
		expect(m.blocks[unattributed[0] ?? ""]).toBe(1);
	});

	it("keys a block with neither rule id nor reason as unattributed:<no-reason> (positive)", () => {
		const m = extractEvalMetrics([block({}), block({ rule: "" })]);
		expect(m.blocks["unattributed:<no-reason>"]).toBe(2);
	});

	it("counts warnings across guard_warn / guard_allow / guard_block payloads (positive)", () => {
		const m = extractEvalMetrics([
			warn(["[interlinked:sequence] a", "[interlinked:cyclomatic] b"]),
			warn(),
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit", guard_warnings: ["[interlinked:file-size] c"] }),
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit", guard_warnings: null }),
			ev({ type: "guard_block", hook: "PreToolUse", tool: "Bash", guard_rule_id: "r", guard_warnings: ["d"] }),
		]);
		expect(m.warnings).toBe(5);
	});

	it("counts completed edits and verifier runs (positive)", () => {
		const m = extractEvalMetrics([
			done("Edit"),
			done("Write"),
			done("MultiEdit"),
			done("Bash", "npx vitest run src/x.test.ts"),
			done("Bash", "npm run typecheck"),
			done("Bash", "ls -la"),
			done("Read"),
		]);
		expect(m.edits).toBe(3);
		expect(m.verifier_runs).toBe(2);
	});

	it("credits block_retry_success only when the same tool later completes (positive)", () => {
		const m = extractEvalMetrics([
			block({ rule: "tdd_new_file_gate", tool: "Write" }),
			done("Write"),
			block({ rule: "complexity_write_guard", tool: "Edit" }),
			done("Bash", "git status"),
		]);
		expect(m.block_retry_success).toBe(1);
	});

	it("detects a block loop at >=3 consecutive same-rule blocks, counting each run once (positive)", () => {
		const a = block({ rule: "a", tool: "Edit" });
		const b = block({ rule: "b", tool: "Write" });
		expect(extractEvalMetrics([a, a, a]).block_loops).toBe(1);
		expect(extractEvalMetrics([a, a, a, a]).block_loops).toBe(1);
		expect(extractEvalMetrics([a, a, a, b, b, b]).block_loops).toBe(2);
	});

	it("ignores malformed, empty, and non-object lines (negative)", () => {
		const m = extractEvalMetrics(["{not json", "", "   ", "42", '"str"', "null", "[1,2]"]);
		expect(m).toEqual(zeroMetrics());
	});

	it("does not count attempts, allows, or non-edit tools as edits (negative)", () => {
		const m = extractEvalMetrics([
			start("Edit"),
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit" }),
			done("Read"),
			done("Grep"),
			ev({ type: "tool_use", hook: "PostToolUse" }),
		]);
		expect(m.edits).toBe(0);
		expect(m.turns).toBe(1);
	});

	it("does not count non-verifier bash or commandless/odd tool_input as verifier runs (negative)", () => {
		const m = extractEvalMetrics([
			done("Bash", "git status"),
			done("Bash", "cat notes.txt"),
			done("Bash"),
			ev({ type: "tool_use", hook: "PostToolUse", tool: "Bash", tool_input: "not-an-object" }),
		]);
		expect(m.verifier_runs).toBe(0);
	});

	it("does not credit retry success for blocks without a tool or with no later completion (negative)", () => {
		const m = extractEvalMetrics([block({}), done("Edit"), block({ rule: "r2", tool: "Write" })]);
		expect(m.block_retry_success).toBe(0);
	});

	it("does not report a loop for runs shorter than 3 or interrupted runs (negative)", () => {
		const a = block({ rule: "a", tool: "Edit" });
		const b = block({ rule: "b", tool: "Edit" });
		expect(extractEvalMetrics([a, a, b, a, a]).block_loops).toBe(0);
	});
});

describe("isVerifierCommand", () => {
	it("matches common test / typecheck / build invocations (positive)", () => {
		expect(isVerifierCommand("npx vitest run src/a.test.ts")).toBe(true);
		expect(isVerifierCommand("npm test")).toBe(true);
		expect(isVerifierCommand("npm run typecheck")).toBe(true);
		expect(isVerifierCommand("pytest -q")).toBe(true);
		expect(isVerifierCommand("npx tsc --noEmit")).toBe(true);
		expect(isVerifierCommand("node --test")).toBe(true);
	});

	it("does not match ordinary shell work (negative)", () => {
		expect(isVerifierCommand("git status")).toBe(false);
		expect(isVerifierCommand("ls -la src")).toBe(false);
		expect(isVerifierCommand("node scripts/count-lines.mjs")).toBe(false);
		expect(isVerifierCommand("cat package.json")).toBe(false);
	});
});

describe("noiseRatio", () => {
	it("divides warnings by turns, guarding zero turns", () => {
		expect(noiseRatio(zeroMetrics({ warnings: 3, turns: 4 }))).toBe(0.75);
		expect(noiseRatio(zeroMetrics({ warnings: 2, turns: 0 }))).toBe(2);
	});
});

describe("aggregateMetrics", () => {
	it("sums counters and merges block records (positive)", () => {
		const a = zeroMetrics({ blocks: { r1: 1 }, blocks_total: 1, warnings: 2, edits: 3, turns: 10 });
		const b = zeroMetrics({ blocks: { r1: 2, r2: 1 }, blocks_total: 3, warnings: 1, verifier_runs: 2, turns: 5 });
		const sum = aggregateMetrics([a, b]);
		expect(sum.blocks).toEqual({ r1: 3, r2: 1 });
		expect(sum.blocks_total).toBe(4);
		expect(sum.warnings).toBe(3);
		expect(sum.edits).toBe(3);
		expect(sum.verifier_runs).toBe(2);
		expect(sum.turns).toBe(15);
	});

	it("returns zero metrics for an empty list (negative)", () => {
		expect(aggregateMetrics([])).toEqual(zeroMetrics());
	});
});

describe("compareArms", () => {
	it("flags harness_regression when off succeeds and on fails", () => {
		const rows = compareArms(zeroMetrics(), zeroMetrics(), false, true);
		const success = rows.find((r) => r.metric === "success");
		expect(success?.flag).toBe("harness_regression");
		expect(success?.delta).toBe(-1);
	});

	it("flags both_arms_failed when neither arm succeeds", () => {
		const rows = compareArms(zeroMetrics(), zeroMetrics(), false, false);
		expect(rows.find((r) => r.metric === "success")?.flag).toBe("both_arms_failed");
	});

	it("flags block_loop and noisy from the harness-on metrics", () => {
		const on = zeroMetrics({ block_loops: 1, warnings: 6, turns: 10 });
		const rows = compareArms(on, zeroMetrics(), true, true);
		expect(rows.find((r) => r.metric === "block_loops")?.flag).toBe("block_loop");
		expect(rows.find((r) => r.metric === "noise_ratio")?.flag).toBe("noisy");
	});

	it("produces the full row set with numeric deltas and no flags on a clean pair", () => {
		const on = zeroMetrics({ blocks_total: 1, warnings: 2, edits: 5, verifier_runs: 3, turns: 20 });
		const off = zeroMetrics({ edits: 4, verifier_runs: 2, turns: 15 });
		const rows = compareArms(on, off, true, true);
		expect(rows.map((r) => r.metric)).toEqual([
			"success",
			"blocks_total",
			"block_loops",
			"warnings",
			"noise_ratio",
			"edits",
			"verifier_runs",
			"turns",
		]);
		expect(rows.every((r) => r.flag === null)).toBe(true);
		expect(rows.find((r) => r.metric === "turns")?.delta).toBe(5);
		expect(rows.find((r) => r.metric === "noise_ratio")?.on).toBe(0.1);
	});
});

describe("taskVerdict", () => {
	it("FAILs when harness-off succeeds but harness-on fails twice in a row", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false }),
			cell({ arm: "on", rep: 2, success: false }),
		]);
		expect(v.verdict).toBe("FAIL");
		expect(v.reasons.join(" ")).toContain("twice in a row");
	});

	it("WARNs on a single harness-on failure when harness-off succeeds", () => {
		const v = taskVerdict([cell({ arm: "off", rep: 1, success: true }), cell({ arm: "on", rep: 1, success: false })]);
		expect(v.verdict).toBe("WARN");
		expect(v.reasons.join(" ")).toContain("candidate");
	});

	it("WARNs on block loops or a noisy harness-on arm even when both succeed", () => {
		const loops = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { block_loops: 2 } }),
		]);
		expect(loops.verdict).toBe("WARN");
		const noisy = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 8, turns: 10 } }),
		]);
		expect(noisy.verdict).toBe("WARN");
	});

	it("PASSes a clean on/off pair (negative: no spurious flags)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 1, turns: 10 } }),
		]);
		expect(v).toEqual({ verdict: "PASS", reasons: [] });
	});

	it("SKIPs when either arm is missing (negative)", () => {
		expect(taskVerdict([cell({ arm: "on", rep: 1, success: true })]).verdict).toBe("SKIP");
		expect(taskVerdict([cell({ arm: "off", rep: 1, success: true })]).verdict).toBe("SKIP");
		expect(taskVerdict([]).verdict).toBe("SKIP");
	});

	it("does not FAIL on non-consecutive harness-on failures, but keeps the candidate WARN (negative)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false }),
			cell({ arm: "on", rep: 2, success: true }),
			cell({ arm: "on", rep: 3, success: false }),
		]);
		expect(v.verdict).toBe("WARN");
	});

	it("keeps FAIL precedence and accumulates auxiliary reasons", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false, over: { block_loops: 1 } }),
			cell({ arm: "on", rep: 2, success: false }),
		]);
		expect(v.verdict).toBe("FAIL");
		expect(v.reasons.length).toBeGreaterThanOrEqual(2);
	});
});
