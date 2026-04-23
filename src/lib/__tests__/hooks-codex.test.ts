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

		// PermissionRequest normalizer should produce a real event, not null
		expect(generatedScript).toContain('case "PermissionRequest"');
		expect(generatedScript).toContain('event_type: "permission_request"');
		expect(generatedScript).toContain("permission_suggestions");
		// Should NOT return null for PermissionRequest
		expect(generatedScript).not.toMatch(/case "PermissionRequest":\s*\n\s*return null/);
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
		for (const event of expectedEvents) {
			expect(generatedScript).toContain(`case "${event}"`);
		}
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

	it("PostToolUseFailure check is restricted to mutation tools", () => {
		writeHookScript("/repo");
		const generatedScript = String(mockWriteFileSync.mock.calls[0][1]);

		// New restrictive set of mutation tools
		expect(generatedScript).toContain("mutationTools");
		expect(generatedScript).toContain('"Edit"');
		expect(generatedScript).toContain('"Write"');
		expect(generatedScript).toContain('"MultiEdit"');
		expect(generatedScript).toContain('"NotebookEdit"');

		// skipPostCheck negates membership in the mutation set
		expect(generatedScript).toMatch(
			/skipPostCheck\s*=\s*hookEvent === "PostToolUseFailure"\s*&&\s*!mutationTools\.has/,
		);

		// Should NOT have the old read-only allowlist approach
		expect(generatedScript).not.toContain("readOnlyTools");
	});
});
