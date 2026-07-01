import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDebtMode } from "./coverage-debt-gate.js";
import { readOpenDebts } from "./obligation-ledger-io.js";
import type { PerEditCoverageConfig } from "./types/config.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "debt-gate-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function cfg(over: Partial<PerEditCoverageConfig> = {}): PerEditCoverageConfig {
	return { enabled: true, mode: "block", budget_ms: 25_000, languages: ["ts"], debt_mode: true, ...over };
}

function edit(file: string): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Edit", tool_input: { file_path: join(root, file) }, cwd: root, timestamp: "t" };
}

function bashEvent(): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command: "ls" }, cwd: root, timestamp: "t" };
}

/** A read-only Read carries `file_path` just like an Edit, but mutates nothing. */
function readEvent(file: string): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Read", tool_input: { file_path: join(root, file) }, cwd: root, timestamp: "t" };
}

const uncovered = (file: string): HarnessDecision => ({
	decision: "block",
	reason: `[interlinked:coverage] BLOCKED: ${file} line 5 is executable but uncovered by the test suite after this edit.`,
	rule_id: "per-edit-coverage",
});

describe("applyDebtMode — pair A (source then test, two ordinary edits)", () => {
	it("opens debt + allows the first uncovered source edit, then discharges on the test", () => {
		// Edit 1 — uncovered source. OLD harness blocked here; now it ALLOWS.
		const e1 = applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(e1?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);

		// Edit 2 — the companion test. Base gate returns null (test not a target);
		// the wrapper optimistically discharges foo.ts's debt.
		const e2 = applyDebtMode(edit("src/foo.test.ts"), cfg(), null);
		expect(e2).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("discharges a decomposed-sibling debt when its UMBRELLA test is edited", () => {
		// Debt opens on a decomposed sibling…
		const e1 = applyDebtMode(edit("src/evaluator/foo-bar.ts"), cfg(), uncovered("src/evaluator/foo-bar.ts"));
		expect(e1?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);

		// …and editing the umbrella test under __tests__/ (NOT the co-located
		// sibling) discharges it via the umbrella-pair rule.
		const e2 = applyDebtMode(edit("src/evaluator/__tests__/foo.test.ts"), cfg(), null);
		expect(e2).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("applyDebtMode — wandering blocks", () => {
	it("blocks an unrelated-file edit while debt is open", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("src/foo.ts");
	});

	it("WIP > 1 lets a second pair open instead of blocking", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg({ debt_wip_limit: 3 }), uncovered("src/bar.ts"));
		expect(out?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(2);
	});

	it("does NOT block a read-only Read of an unrelated file while debt is open", () => {
		// Open a debt on foo.ts, then READ an unrelated file. A read edits nothing,
		// so it must pass through — not be mis-read as an edit that "wanders" away
		// from the open pair (regression: the debt-lock was gating read-only calls).
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(readEvent("src/bar.ts"), cfg(), null);
		expect(out).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(1); // debt untouched by the read
	});
});

describe("applyDebtMode — pass-through (no debt logic)", () => {
	it("leaves a non-code file edit's verdict untouched", () => {
		const base = uncovered("docs/x.md");
		expect(applyDebtMode(edit("docs/x.md"), cfg(), base)).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("leaves a non-file (Bash) event untouched", () => {
		expect(applyDebtMode(bashEvent(), cfg(), null)).toBeNull();
	});

	it("is a no-op clean allow when there is no debt and no uncovered verdict", () => {
		expect(applyDebtMode(edit("src/foo.ts"), cfg(), null)).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("is a pure pass-through when debt_mode is off", () => {
		const base = uncovered("src/foo.ts");
		expect(applyDebtMode(edit("src/foo.ts"), cfg({ debt_mode: false }), base)).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("applyDebtMode — non-Claude edit verbs (canonical isFileWrite, not a hand-rolled set)", () => {
	// Copilot / Codex / Gemini emit str_replace / edit_file / … instead of
	// Write / Edit / MultiEdit. The hand-rolled set silently dropped them, so
	// debt-mode detection never engaged for those agents (baseline-review finding).
	const nonClaudeEdit = (file: string, toolName: string): HarnessEvent => ({
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "codex",
		tool_name: toolName,
		tool_input: { file_path: join(root, file) },
		cwd: root,
		timestamp: "t",
	});

	it("treats a str_replace edit as an edit (opens debt; pre-fix it fell through to the raw block)", () => {
		const out = applyDebtMode(nonClaudeEdit("src/foo.ts", "str_replace"), cfg(), uncovered("src/foo.ts"));
		expect(out?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);
	});

	it("treats an edit_file wander as an edit (blocks while a debt is open)", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(nonClaudeEdit("src/bar.ts", "edit_file"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("src/foo.ts");
	});
});
