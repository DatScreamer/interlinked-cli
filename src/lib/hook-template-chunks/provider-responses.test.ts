import { describe, expect, it } from "vitest";
import { PROVIDER_RESPONSES_CHUNK } from "./provider-responses.js";

// PROVIDER_RESPONSES_CHUNK is a template-literal string that becomes runtime
// JS in the generated `.interlinked/hooks/interlinked-activity.mjs`. We
// can't import its functions directly (they reference outer-scope
// variables defined in the surrounding template), so we verify shape: the
// per-provider formatters exist, the dispatcher is depth-1, and each
// provider's documented response shape is present.

describe("PROVIDER_RESPONSES_CHUNK — shape", () => {
	it("is a non-empty string", () => {
		expect(typeof PROVIDER_RESPONSES_CHUNK).toBe("string");
		expect(PROVIDER_RESPONSES_CHUNK.length).toBeGreaterThan(100);
	});

	it("exposes formatProviderResponse as the dispatcher", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatProviderResponse(");
	});

	it("defines per-provider formatters (claude / copilot / codex)", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatClaudeResponse(");
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatCopilotResponse(");
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function formatCodexResponse(");
	});

	it("dispatches based on detectedClient", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('detectedClient === "copilot"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain('detectedClient === "codex"');
	});

	it("Claude pre_block uses the legacy {decision: 'block'} shape", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('decision: "block"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain("reason: data.reason");
	});

	it("Claude pre_block_grep uses hookSpecificOutput.permissionDecision", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("hookSpecificOutput");
		expect(PROVIDER_RESPONSES_CHUNK).toContain('permissionDecision: "deny"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain("permissionDecisionReason");
	});

	it("Claude pre_ask uses permissionDecision: 'ask' with optional systemMessage", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('permissionDecision: "ask"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain("data.systemMessage");
		expect(PROVIDER_RESPONSES_CHUNK).toContain("askResp.systemMessage");
	});

	it("Copilot collapses ask → deny (no ask primitive)", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("Copilot has no");
		expect(PROVIDER_RESPONSES_CHUNK).toMatch(/Copilot[\s\S]*permissionDecision: "deny"/);
	});

	it("Copilot post_block writes to stderr (observation-only postToolUse)", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain("process.stderr.write");
	});

	it("Claude post_warn uses additionalContext instead of the block shape", () => {
		const claudeBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatClaudeResponse[\s\S]*?function formatCopilotResponse/,
		);
		expect(claudeBlock?.[0]).toContain('responseType === "post_warn"');
		expect(claudeBlock?.[0]).toContain("additionalContext: data.summary");
	});

	it("Copilot post_warn shares the observation-only stderr path", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('responseType === "post_block" || responseType === "post_warn"');
	});

	it("Codex PermissionRequest uses hookSpecificOutput.decision.behavior", () => {
		// Codex has its own permission shape, distinct from Claude's
		// permissionDecision field.
		expect(PROVIDER_RESPONSES_CHUNK).toContain("function codexPermissionDeny(");
		expect(PROVIDER_RESPONSES_CHUNK).toContain('hookEventName: "PermissionRequest"');
		expect(PROVIDER_RESPONSES_CHUNK).toContain('behavior: "deny"');
	});

	it("Codex PreToolUse/PostToolUse use the legacy {decision: 'block'} shape", () => {
		// Codex documents acceptance of both new and legacy shapes for
		// Pre/PostToolUse; we use legacy for simplicity. Specifically check
		// the codex formatter contains the legacy block emit.
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock).not.toBeNull();
		expect(codexBlock?.[0]).toContain('decision: "block"');
	});

	it("Codex post_success surfaces additionalContext on the canonical event echo", () => {
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock?.[0]).toContain("additionalContext: data.summary");
		expect(codexBlock?.[0]).toContain("hookEventName: postEventEcho");
	});

	it("Codex post_warn uses additionalContext so advisory findings do not look blocked", () => {
		const codexBlock = PROVIDER_RESPONSES_CHUNK.match(
			/function formatCodexResponse[\s\S]*?function formatProviderResponse/,
		);
		expect(codexBlock?.[0]).toContain('responseType === "post_warn"');
		expect(codexBlock?.[0]).toContain("additionalContext: data.summary");
	});

	it("preEventEcho reflects PermissionRequest as a pre-event for Claude", () => {
		expect(PROVIDER_RESPONSES_CHUNK).toContain('"PermissionRequest"');
		expect(PROVIDER_RESPONSES_CHUNK).toMatch(
			/incomingEvent === "PreToolUse" \|\| incomingEvent === "BeforeTool" \|\| incomingEvent === "PermissionRequest"/,
		);
	});
});
