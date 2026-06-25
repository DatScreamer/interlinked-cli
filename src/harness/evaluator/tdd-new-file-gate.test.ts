// Tests for the new-file TDD gate.
//
// Shape of each case: build a tmpdir, optionally pre-seed companion tests or
// session state, call `evaluateTddNewFileGate`, assert the decision. No
// mocking — the gate only touches the filesystem and the session trajectory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readOpenDebts } from "../obligation-ledger-io.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluateTddNewFileGate, evaluateTddNewFileGateForEvent } from "./tdd-new-file-gate.js";

let tmp: string;

function makeSession(writtenAbs: string[] = []): SessionTrajectory {
	// Minimal trajectory — the gate only touches `files_written`. Every other
	// field is filled with a zero/empty value to satisfy the structural type.
	return {
		session_id: "t",
		agent_name: "t",
		agent_source: "claude",
		started_at: "",
		tool_call_count: 0,
		first_write_at: null,
		files_read: new Set(),
		files_written: new Set(writtenAbs),
		file_read_at: new Map(),
		file_write_times: new Map(),
		file_edit_counts: new Map(),
		pending_completions: new Map(),
		soft_blocks: new Set(),
		acknowledged_checks: new Map(),
		error_count: 0,
		consecutive_tool_failures: new Map(),
		tdd_cycles: new Map(),
		recent_bash_commands: [],
	} as unknown as SessionTrajectory;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "tdd-gate-"));
	mkdirSync(join(tmp, "src"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("evaluateTddNewFileGate — mode gating", () => {
	it("returns null when test_first_mode is not 'enforce'", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "warn",
		});
		expect(decision).toBeNull();
	});

	it("returns null when test_first_mode is undefined", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: undefined,
		});
		expect(decision).toBeNull();
	});
});

describe("evaluateTddNewFileGate — happy paths (allow)", () => {
	it("allows when the companion .test.ts already exists on disk", () => {
		writeFileSync(join(tmp, "src/foo.test.ts"), "import { it } from 'vitest';\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when a __tests__/ sibling test exists", () => {
		mkdirSync(join(tmp, "src/__tests__"), { recursive: true });
		writeFileSync(join(tmp, "src/__tests__/foo.test.ts"), "");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when the companion test was written earlier in the session", () => {
		const session = makeSession([join(tmp, "src/foo.test.ts")]);
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when editing an existing source file (only new files gated)", () => {
		writeFileSync(join(tmp, "src/foo.ts"), "export const x = 1;\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when the new file carries the exempt directive in its first bytes", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/wrapper.ts"),
			cwd: tmp,
			session: undefined,
			content: "// interlinked-tdd: exempt\nexport const x = 1;\n",
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});
});

describe("evaluateTddNewFileGate — exempt paths", () => {
	const cases: Array<[string, string]> = [
		["type declaration", "src/types.d.ts"],
		["test file itself", "src/foo.test.ts"],
		["spec file itself", "src/foo.spec.ts"],
		["__tests__/ nested file", "src/__tests__/foo.ts"],
		["__fixtures__/ nested file", "src/__fixtures__/foo.ts"],
		["__mocks__/ nested file", "src/__mocks__/foo.ts"],
		["config file", "vite.config.ts"],
		["scripts/ file", "scripts/release.ts"],
		["dist artifact", "dist/bundle.ts"],
		[".claude hook artifact", ".claude/hooks/activity.ts"],
		[".interlinked runtime", ".interlinked/harness/foo.ts"],
		["landing/ static-site worker", "landing/src/worker.ts"],
		["web/ static-site source", "web/src/index.ts"],
		["site/ docs source", "site/src/page.ts"],
	];
	for (const [label, rel] of cases) {
		it(`allows new file in exempt path (${label})`, () => {
			const decision = evaluateTddNewFileGate({
				filePath: join(tmp, rel),
				cwd: tmp,
				session: undefined,
				testFirstMode: "enforce",
			});
			expect(decision).toBeNull();
		});
	}
});

describe("evaluateTddNewFileGate — blocking", () => {
	it("blocks a brand-new .ts source with no companion on disk or in session", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: makeSession([]),
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/companion test/i);
		expect(decision?.reason).toMatch(/interlinked-tdd: exempt/);
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		expect(decision?.severity).toBe("high");
	});

	it("blocks a brand-new .tsx source", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/Widget.tsx"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
	});

	it("blocks when only an unrelated test sibling exists", () => {
		writeFileSync(join(tmp, "src/other.test.ts"), "");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
	});

	it("block message lists all searched candidate paths", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.reason).toContain("src/foo.test.ts");
		expect(decision?.reason).toContain("__tests__/foo.test.ts");
		expect(decision?.reason).toContain(".spec.ts");
	});

	it("block message lists the public surface extracted from the impl content", () => {
		// Saves the agent a re-Read of the impl when authoring the test —
		// the gate already saw the content, so it can summarize what the
		// test should at minimum exercise.
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			content: [
				"export function ensureFlag(base: string): 'created' | 'preserved' {",
				"    return 'created';",
				"}",
				"export const NAMESPACE = 'features';",
				"export class FeatureRegistry {",
				"    register(name: string) {}",
				"}",
				"export interface Options {}",
				"export type Action = 'on' | 'off';",
			].join("\n"),
			testFirstMode: "enforce",
		});
		expect(decision?.reason).toContain("Public surface to test");
		expect(decision?.reason).toContain("ensureFlag");
		expect(decision?.reason).toContain("NAMESPACE");
		expect(decision?.reason).toContain("FeatureRegistry");
		// Type-only exports aren't testable at runtime — skip them.
		expect(decision?.reason).not.toContain("Options");
		expect(decision?.reason).not.toContain("Action");
	});

	it("block message omits the surface line when no content is provided", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.reason).not.toContain("Public surface to test");
	});

	it("block message omits the surface line when the file has no exports", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			content: "// just a side-effect module\nconsole.log('hi');\n",
			testFirstMode: "enforce",
		});
		expect(decision?.reason).not.toContain("Public surface to test");
	});
});

describe("evaluateTddNewFileGate — non-source extensions", () => {
	it("returns null for a .js file (not our concern)", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.js"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("returns null for a .json file", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.json"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("returns null when filePath is empty", () => {
		const decision = evaluateTddNewFileGate({
			filePath: "",
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});
});

// ===========================================
// Event wrapper — debt-mode downgrade
// ===========================================
// When `per_edit_coverage.debt_mode` is on (now the default), a would-be
// new-file BLOCK is downgraded to an opened coverage debt + allow, so an agent
// can write a new source file then its companion test as two ordinary edits
// (the "Pair B" case). With debt_mode off the historical hard block is
// preserved. The `// interlinked-tdd: exempt` escape still allows with no debt.
// These exercise `evaluateTddNewFileGateForEvent`, which both resolves the
// block AND appends the open txn to `.interlinked/obligations.jsonl` under cwd.

function rulesFor(debtMode: boolean | undefined): GuardRulesConfig {
	// SAFETY: the wrapper reads only `structural_checks.test_first_mode` and
	// `per_edit_coverage.debt_mode`; every other GuardRulesConfig field is
	// unused on this path, so a two-field stand-in is sufficient for the test.
	return {
		structural_checks: { test_first_mode: "enforce" },
		per_edit_coverage: debtMode === undefined ? undefined : { debt_mode: debtMode },
	} as unknown as GuardRulesConfig;
}

function writeEvent(absPath: string, content: string | undefined): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: content === undefined ? { file_path: absPath } : { file_path: absPath, content },
		cwd: tmp,
		timestamp: "t",
	};
}

describe("evaluateTddNewFileGateForEvent — debt-mode downgrade", () => {
	it("debt_mode ON: allows the new test-less source AND opens a coverage debt for it", () => {
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(true),
			makeSession([]),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.[0]).toMatch(/Opened coverage debt for src\/foo\.ts/);
		expect(decision?.warnings?.[0]).toMatch(/companion test \(src\/foo\.test\.ts\)/);

		const debts = readOpenDebts(tmp);
		expect(debts).toHaveLength(1);
		expect(debts[0]?.file).toBe("src/foo.ts");
		expect(debts[0]?.kind).toBe("coverage");
	});

	it("debt_mode OFF: still hard-blocks the new test-less source (unchanged) and opens no debt", () => {
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(false),
			makeSession([]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/companion test/i);
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});

	it("debt_mode default-absent: hard-blocks (no per_edit_coverage config means no downgrade)", () => {
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(undefined),
			makeSession([]),
		);
		expect(decision?.decision).toBe("block");
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});

	it("exempt directive: allows with no block and no debt even when debt_mode is on", () => {
		const abs = join(tmp, "src/wrapper.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "// interlinked-tdd: exempt\nexport const x = 1;\n"),
			rulesFor(true),
			makeSession([]),
		);
		expect(decision).toBeNull();
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});

	it("debt_mode ON but companion already on disk: allows with no block and no debt", () => {
		writeFileSync(join(tmp, "src/foo.test.ts"), "import './foo.js';\n");
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(true),
			makeSession([]),
		);
		expect(decision).toBeNull();
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});
});
