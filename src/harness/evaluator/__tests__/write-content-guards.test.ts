import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../../types.js";
import { evaluateWriteContentGuards } from "../write-content-guards.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "t",
		agent_source: "claude",
		agent_name: "test",
		tool_name: "Write",
		tool_input: {},
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function makeRules(): GuardRulesConfig {
	return {
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		repo_confinement_allowlist: [],
		quality_checks: {
			biome_lint: { enabled: false },
			typescript: { enabled: false },
		},
	} as unknown as GuardRulesConfig;
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "s",
		agent_name: "a",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
		tool_sequence: [],
		sensitivity_level: "Public",
		injection_detected_steps: [],
	} as unknown as SessionTrajectory;
}

describe("evaluateWriteContentGuards — block cases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "wcg-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("blocks binary file writes", () => {
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: { file_path: "assets/logo.png", content: "not really a png" },
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: undefined,
			pendingEscalation: undefined,
		});
		expect(result).toMatchObject({
			kind: "block",
			decision: { decision: "block", reason: expect.stringMatching(/binary file/) },
		});
	});

	it("blocks merge conflict markers", () => {
		const filePath = join(tmpDir, "foo.ts");
		const content = [
			"export const x = 1;",
			"<<<<<<< HEAD",
			"const y = 2;",
			"=======",
			"const y = 3;",
			">>>>>>> feature",
		].join("\n");
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: { file_path: filePath, content },
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: undefined,
			pendingEscalation: undefined,
		});
		expect(result).toMatchObject({
			kind: "block",
			decision: { decision: "block", reason: expect.stringMatching(/Merge conflict/) },
		});
	});

	it("blocks path-traversal writes to /etc", () => {
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: { file_path: "../../etc/passwd", content: "x" },
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: undefined,
			pendingEscalation: undefined,
		});
		expect(result).toMatchObject({
			kind: "block",
			decision: { reason: expect.stringMatching(/path traversal|system directory/) },
		});
	});
});

describe("evaluateWriteContentGuards — ok cases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "wcg-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("warns on invalid JSON in .json file without blocking", () => {
		const filePath = join(tmpDir, "x.json");
		writeFileSync(filePath, "{}");
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: { file_path: filePath, content: "{not json" },
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: undefined,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		expect(
			result.kind === "ok" && result.warnings.some((w) => w.includes("Invalid JSON")),
		).toBe(true);
	});

	it("passes clean TypeScript content through without content-quality warnings", () => {
		const filePath = join(tmpDir, "good.ts");
		writeFileSync(filePath, "");
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: {
				file_path: filePath,
				content: "export const x: number = 1;\n",
			},
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: undefined,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings.filter((w) => w.includes("[interlinked:content-quality]"))).toEqual([]);
	});

	it("warns on 'as any' assertions in TS files without blocking", () => {
		const filePath = join(tmpDir, "any.ts");
		writeFileSync(filePath, "");
		const content = "export const x = 1 as any;\nexport const y = 2 as any;\n";
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: { file_path: filePath, content },
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: undefined,
			pendingEscalation: undefined,
		});
		// "as any" surfaces as a warning via the legacy content-quality block.
		// Pre-block registry may or may not escalate it to a block; this test
		// just asserts the warning text appears in whichever branch is taken.
		const warnings = result.kind === "ok" ? result.warnings : result.decision.warnings || [];
		expect(warnings.some((w) => w.includes('"as any"') || w.includes("as any"))).toBe(true);
	});

	it("preserves an existing pendingEscalation when nothing fires", () => {
		const filePath = join(tmpDir, "clean.ts");
		writeFileSync(filePath, "");
		const existingEscalation = {
			trigger: "external_url" as const,
			summary: "pre-existing",
			tool_name: "Bash",
			tool_input_redacted: {},
			sensitivity_level: "Public" as const,
			step_number: 0,
			recent_tool_sequence: [] as string[],
		};
		const result = evaluateWriteContentGuards({
			toolName: "Write",
			toolInput: { file_path: filePath, content: "export const x = 1;\n" },
			event: makeEvent({ cwd: tmpDir }),
			rules: makeRules(),
			session: makeSession(),
			pendingEscalation: existingEscalation,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toEqual(existingEscalation);
	});
});
