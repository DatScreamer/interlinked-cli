// ===========================================
// Strict profile via TEAM config — composed routing pins
// ===========================================
// Review 2026-08-29 P0: the committed guard-rules.json enabled
// `mutation_directed_strict_profile`, but only mergeLocalOverrides honored
// the section — mergeTeamRules silently dropped it, so
// `loadRules(cwd).mutation_directed_strict_profile` was undefined and the
// strict profile never fired. Every prior test either passed a manually
// built STRICT_ON object or exercised the LOCAL merge, so the unreachable
// team path stayed green. These tests go through the real filesystem
// loader and the real guard so the routing itself is what is pinned.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules } from "../rules-loader.js";
import type { HarnessEvent } from "../types.js";
import { evaluateMutationDirectedProfile } from "./mutation-directed-guard.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdp-team-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeTeamConfig(body: object): void {
	// interlinked: defer write_without_mkdir -- beforeEach creates .interlinked/
	writeFileSync(join(dir, ".interlinked", "guard-rules.json"), JSON.stringify(body));
}

describe("loadRules — team-level mutation_directed_strict_profile (filesystem)", () => {
	// test-contract: bug — the exact defect: a TEAM guard-rules.json enabling
	// the strict profile must survive loadRules(); before the mergeTeamRules
	// branch existed this read returned undefined ("configured but
	// unreachable").
	it("P1: a team guard-rules.json enabling the profile reaches the loaded config", () => {
		writeTeamConfig({ mutation_directed_strict_profile: { enabled: true } });
		const rules = loadRules(dir);
		expect(rules.mutation_directed_strict_profile?.enabled).toBe(true);
	});

	// test-contract: bug — the original failure came from the real multi-section
	// TEAM file, not only the minimal object above. Keep that regression shape as
	// a source fixture so Stryker's sandbox can exercise it even though
	// `.interlinked/` is intentionally excluded from every mutation copy.
	it("P2: the committed multi-section team fixture enables the profile through loadRules", () => {
		const committed = readFileSync(
			new URL("./__fixtures__/mutation-directed-strict-team-rules.json", import.meta.url),
			"utf-8",
		);
		// interlinked: defer write_without_mkdir -- beforeEach creates .interlinked/
		writeFileSync(join(dir, ".interlinked", "guard-rules.json"), committed);
		const rules = loadRules(dir);
		expect(rules.mutation_directed_strict_profile?.enabled).toBe(true);
		expect(rules.diff_aware?.enabled).toBe(true);
	});

	// test-contract: boundary — absence stays absence: no team section, no
	// local section ⇒ the flag is undefined and the profile stays OFF.
	it("N1: with no team section the profile stays off", () => {
		writeTeamConfig({});
		const rules = loadRules(dir);
		expect(rules.mutation_directed_strict_profile?.enabled).toBeUndefined();
	});
});

function editEvent(filePath: string, oldString: string, newString: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
		cwd: dir,
		timestamp: "t",
	};
}

const RECEIPTED_SEED = [
	'import { describe, expect, it } from "vitest";',
	"// test-contract: invariant — receipted seed case for the composed pin.",
	'it("P1: seed", () => {',
	"\texpect(1 + 1).toBe(2);",
	"});",
	"",
].join("\n");

const RECEIPTLESS_ADDITION = [
	'it("N9: added without a receipt", () => {',
	"\texpect(2 + 2).toBe(4);",
	"});",
	"",
].join("\n");

describe("composed: team-enabled strict profile blocks a receipt-less mutation-kill case", () => {
	// test-contract: bug — the composed end-to-end pin for the routing defect:
	// rules come from loadRules() over a TEAM guard-rules.json (never a
	// hand-built STRICT_ON object), and an ordinary Edit that introduces a
	// mutation-directed test case with no test-contract receipt must BLOCK.
	// This is the Edit the review reproduced being allowed.
	it("P3: an Edit adding a receipt-less it() to a mutation-kill file blocks", () => {
		writeTeamConfig({ mutation_directed_strict_profile: { enabled: true } });
		const rules = loadRules(dir);
		const filePath = join(dir, "detect.mutation-kill.test.ts");
		writeFileSync(filePath, RECEIPTED_SEED);
		const event = editEvent(filePath, RECEIPTED_SEED, RECEIPTED_SEED + RECEIPTLESS_ADDITION);
		const warnings: string[] = [];
		// SAFETY: editEvent always sets tool_input; the non-null assertion only
		// unwraps the optional field the helper just populated.
		const decision = evaluateMutationDirectedProfile(event, rules, "Edit", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("test-contract");
	});

	// test-contract: boundary — the same Edit WITH a receipt on the new case
	// must pass: the gate demands the receipt, not a freeze on adding tests.
	it("N2: the same addition carrying a test-contract receipt is allowed", () => {
		writeTeamConfig({ mutation_directed_strict_profile: { enabled: true } });
		const rules = loadRules(dir);
		const filePath = join(dir, "detect.mutation-kill.test.ts");
		writeFileSync(filePath, RECEIPTED_SEED);
		const receipted =
			"// test-contract: bug — receipted addition must not block.\n" + RECEIPTLESS_ADDITION;
		const event = editEvent(filePath, RECEIPTED_SEED, RECEIPTED_SEED + receipted);
		const warnings: string[] = [];
		// SAFETY: editEvent always sets tool_input; the non-null assertion only
		// unwraps the optional field the helper just populated.
		const decision = evaluateMutationDirectedProfile(event, rules, "Edit", event.tool_input!, warnings);
		expect(decision).toBeNull();
	});
});
