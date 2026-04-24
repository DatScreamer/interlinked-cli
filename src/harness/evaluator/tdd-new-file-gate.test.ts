// Tests for the new-file TDD gate.
//
// Shape of each case: build a tmpdir, optionally pre-seed companion tests or
// session state, call `evaluateTddNewFileGate`, assert the decision. No
// mocking — the gate only touches the filesystem and the session trajectory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionTrajectory } from "../types.js";
import { evaluateTddNewFileGate } from "./tdd-new-file-gate.js";

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
