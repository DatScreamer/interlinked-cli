import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	writeFileSync: vi.fn(),
	readFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	existsSync: vi.fn(),
	unlinkSync: vi.fn(),
	chmodSync: vi.fn(),
	rmSync: vi.fn(),
}));

import { existsSync, writeFileSync } from "node:fs";
import { writeHookScript } from "../hooks.js";

const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("hook script generation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
	});

	it("includes realtime retry and sync error infrastructure", () => {
		writeHookScript("/repo");

		const writeCalls = mockWriteFileSync.mock.calls;
		expect(writeCalls.length).toBeGreaterThan(0);

		const generatedScript = String(writeCalls[0][1]);
		expect(generatedScript).toContain("realtime-retry.jsonl");
		expect(generatedScript).toContain("sync-errors.jsonl");
		expect(generatedScript).toContain("flushRealtimeRetry");
	});

	it("captures PermissionRequest event with tool and suggestions", () => {
		writeHookScript("/repo");

		const writeCalls = mockWriteFileSync.mock.calls;
		const generatedScript = String(writeCalls[0][1]);

		// PermissionRequest dispatch handler emits a real event, not null
		expect(generatedScript).toContain("PermissionRequest: (");
		expect(generatedScript).toContain('hook_event: "PermissionRequest"');
		expect(generatedScript).toContain('event_type: "permission_request"');
		expect(generatedScript).toContain("permission_suggestions");
	});

	it("includes all 14 Claude Code events in script", () => {
		writeHookScript("/repo");

		const generatedScript = String(mockWriteFileSync.mock.calls[0][1]);
		const expectedEvents = [
			"SessionStart",
			"SessionEnd",
			"UserPromptSubmit",
			"Stop",
			"PreToolUse",
			"PostToolUse",
			"PostToolUseFailure",
			"PermissionRequest",
			"SubagentStart",
			"SubagentStop",
			"Notification",
			"PreCompact",
			"TaskCompleted",
			"TeammateIdle",
		];
		// Each event is registered in the CLAUDE_DISPATCH lookup table AND
		// its handler emits the matching `hook_event:` field on the canonical
		// record. Either-or wouldn't catch an accidental copy-paste — both
		// pin the contract.
		for (const event of expectedEvents) {
			expect(generatedScript).toContain(`${event}: (`);
			expect(generatedScript).toContain(`hook_event: "${event}"`);
		}
	});

	it("includes Codex CLI handler in CLIENT_HANDLERS", () => {
		writeHookScript("/repo");

		const generatedScript = String(mockWriteFileSync.mock.calls[0][1]);
		// Codex normalizer present
		expect(generatedScript).toContain("function normalizeCodexEvent(");
		// Codex client handler is detected before the Claude catch-all
		expect(generatedScript).toContain('name: "codex"');
		expect(generatedScript).toContain("normalize: normalizeCodexEvent");
		// Codex events tag the canonical record with client_runner so the
		// downstream pipeline (provider-responses, server payload) can
		// branch on the agent source even though the payload shape mirrors
		// Claude Code's contract.
		expect(generatedScript).toContain('client_runner = "codex"');
	});

	it("formatProviderResponse echoes incoming hookEvent in hookSpecificOutput", () => {
		writeHookScript("/repo");
		const generatedScript = String(mockWriteFileSync.mock.calls[0][1]);

		// Must dynamically resolve event echo, NOT hardcode "PostToolUse" / "PreToolUse"
		expect(generatedScript).toContain("postEventEcho");
		expect(generatedScript).toContain("preEventEcho");
		// Pre-event detection includes the failure variants and PermissionRequest
		expect(generatedScript).toContain('"PreToolUse"');
		expect(generatedScript).toContain('"BeforeTool"');
		expect(generatedScript).toContain('"PermissionRequest"');
		// Sanity: the hookEventName field references the resolved variable, not a literal
		expect(generatedScript).toMatch(/hookEventName:\s*postEventEcho/);
		expect(generatedScript).toMatch(/hookEventName:\s*preEventEcho/);
	});

	it("PostToolUseFailure check reaches harness for failure-recovery channels", () => {
		writeHookScript("/repo");
		const generatedScript = String(mockWriteFileSync.mock.calls[0][1]);

		// New restrictive set of mutation tools (still defined for the
		// successful-Post fast-path skip).
		expect(generatedScript).toContain("mutationTools");
		expect(generatedScript).toContain('"Edit"');
		expect(generatedScript).toContain('"Write"');
		expect(generatedScript).toContain('"MultiEdit"');
		expect(generatedScript).toContain('"NotebookEdit"');

		// Phase 1: skipPostCheck disarmed so every Post* failure reaches the
		// harness for triage/recurrence/recovery. The legacy gate that limited
		// the harness round-trip to mutation-tool failures is gone.
		expect(generatedScript).toContain("const skipPostCheck = false;");
		expect(generatedScript).not.toMatch(
			/skipPostCheck\s*=\s*hookEvent === "PostToolUseFailure"/,
		);

		// Fast-path now also gates on tool_outcome — failed Bash (or any
		// failed non-mutation tool) must NOT take the early-return path.
		expect(generatedScript).toContain('postOutcomeIsError = event.tool_outcome === "error"');
		expect(generatedScript).toMatch(
			/if \(isPostTool && !isMutationPost && !postOutcomeIsError && hookEvent !== "PostToolUseFailure"\)/,
		);

		// Should NOT have the old read-only allowlist approach
		expect(generatedScript).not.toContain("readOnlyTools");
	});
});
