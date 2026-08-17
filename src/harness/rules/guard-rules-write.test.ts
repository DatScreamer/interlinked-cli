import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeIntoGuardRules } from "./guard-rules-write.js";

let cwd = "";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "interlinked-grw-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function readRules(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cwd, ".interlinked", "guard-rules.json"), "utf-8"));
}

describe("mergeIntoGuardRules — positive (must merge-preserve)", () => {
	it("P1: creates .interlinked/guard-rules.json from nothing with the patch applied", () => {
		mergeIntoGuardRules(cwd, { per_edit_coverage: { enabled: false } });
		expect(readRules()).toEqual({ per_edit_coverage: { enabled: false } });
	});

	it("P2: deep-merges nested sections without dropping sibling keys", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.json"),
			JSON.stringify({
				rules: [{ id: "keep-me" }],
				per_edit_coverage: { enabled: true, debt_wip_limit: 3 },
			}),
		);
		mergeIntoGuardRules(cwd, { per_edit_coverage: { debt_mode: false } });
		expect(readRules()).toEqual({
			rules: [{ id: "keep-me" }],
			per_edit_coverage: { enabled: true, debt_wip_limit: 3, debt_mode: false },
		});
	});

	it("P3: scalar and array patch values replace, never concatenate", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.json"),
			JSON.stringify({ structural_checks: { test_first_mode: "enforce" } }),
		);
		mergeIntoGuardRules(cwd, { structural_checks: { test_first_mode: "warn" } });
		expect(readRules()).toEqual({ structural_checks: { test_first_mode: "warn" } });
	});
});

describe("mergeIntoGuardRules — negative (must not corrupt)", () => {
	it("N1: a malformed existing file is preserved untouched and the merge reports failure", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, ".interlinked", "guard-rules.json"), "{ not json");
		const r = mergeIntoGuardRules(cwd, { per_edit_coverage: { enabled: false } });
		expect(r.ok).toBe(false);
		expect(readFileSync(join(cwd, ".interlinked", "guard-rules.json"), "utf-8")).toBe("{ not json");
	});

	it("N2: an empty patch still round-trips the existing file unchanged", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.json"),
			JSON.stringify({ diff_aware: { enabled: true } }),
		);
		const r = mergeIntoGuardRules(cwd, {});
		expect(r.ok).toBe(true);
		expect(readRules()).toEqual({ diff_aware: { enabled: true } });
	});
});
