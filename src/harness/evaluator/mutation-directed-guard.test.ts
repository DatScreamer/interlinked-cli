import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { evaluateMutationDirectedProfile } from "./mutation-directed-guard.js";

// Same fixture pattern as write-content-guards.test.ts's BASE_RULES: the
// functions under test only ever read specific optional-chained fields, so
// an empty object cast to the full config type is the established shortcut
// for these guard tests rather than stubbing every required field.
const BASE_RULES = {} as GuardRulesConfig;
const STRICT_ON = { mutation_directed_strict_profile: { enabled: true } } as never as GuardRulesConfig;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdp-guard-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeEvent(filePath: string, content: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: filePath, content },
		cwd: dir,
		timestamp: "t",
	};
}

describe("evaluateMutationDirectedProfile — file-class scoping", () => {
	it("N1: a non-mutation-directed file is a no-op regardless of flag state", () => {
		const filePath = join(dir, "widget.test.ts");
		const event = writeEvent(filePath, 'it("x", () => expect(1).toBeTruthy());');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("N2: a read-shaped call (no content/new_string) is a no-op", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			timestamp: "t",
		};
		const warnings: string[] = [];
		expect(
			evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings),
		).toBeNull();
	});
});

describe("evaluateMutationDirectedProfile — GATE 1 (severity remap, flag-gated)", () => {
	it("flag OFF: an introduced receipt-missing finding does not block", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts"); // no on-disk baseline
		const event = writeEvent(filePath, 'it("covers survivor", () => expect(render()).toEqual("Empty"));');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
	});

	it("flag ON: an introduced receipt-missing finding blocks with rule_id test_legitimacy", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts"); // no on-disk baseline ⇒ strict/introduced
		const event = writeEvent(filePath, 'it("covers survivor", () => expect(render()).toEqual("Empty"));');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("test_legitimacy");
	});

	it("flag ON: a pre-existing (unchanged) finding warns but does not block", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		const content = 'it("covers survivor", () => expect(render()).toEqual("Empty"));';
		writeFileSync(filePath, content, "utf-8"); // baseline == proposed ⇒ nothing introduced
		const event = writeEvent(filePath, content);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("pre-existing"))).toBe(true);
	});
});

describe("evaluateMutationDirectedProfile — GATE 2 (assertion-removal delta)", () => {
	it("warns unconditionally (flag OFF) when an edit removes an assertion line", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull(); // flag off ⇒ never blocks
		expect(warnings.some((w) => w.includes("mutation_directed_assertion_removal"))).toBe(true);
	});

	it("blocks (flag ON) when an edit removes an assertion line", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("mutation_directed_assertion_removal");
	});

	it("does not warn or block when nothing is removed (pure addition)", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("mutation_directed_assertion_removal"))).toBe(false);
	});
});
