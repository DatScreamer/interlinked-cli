import { describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";

// These assertions are the byte-level invariants for the template:
// the generated .mjs must contain marker strings from every chunk and must
// start with the versioned shebang. If any marker disappears, the refactor
// (hook-template-chunks/*) has drifted and the generated hook will be broken.

describe("buildHookScript", () => {
	it("starts with the versioned shebang", () => {
		const out = buildHookScript("0.1.0");
		expect(out.startsWith("#!/usr/bin/env node\n// interlinked-hook-version: 0.1.0\n")).toBe(
			true,
		);
	});

	it("interpolates the version argument", () => {
		const out = buildHookScript("custom-9.9.9");
		expect(out).toContain("// interlinked-hook-version: custom-9.9.9");
	});

	it("embeds redaction chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("SECRET_PATTERNS");
		expect(out).toContain("function redactSecrets");
		expect(out).toContain("function scrubPayload");
	});

	it("embeds guards-inline chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function inlineGuardCheck");
		expect(out).toContain("BLOCKED: Recursive force-delete");
	});

	it("embeds session-state chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function extractNewThinking");
		expect(out).toContain("function appendLocal");
		expect(out).toContain("function updateSessionState");
		expect(out).toContain("function captureCodeEdit");
		expect(out).toContain("function reconcileCommits");
		expect(out).toContain("async function batchSync");
	});

	it("embeds provider-responses chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function formatProviderResponse");
		expect(out).toContain("Provider-specific response formatting");
	});

	it("embeds event-normalizers chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function normalizeClaudeEvent");
		expect(out).toContain("function normalizeCopilotEvent");
		// --- Client Normalizers --- header is emitted verbatim from the chunk.
		expect(out).toContain("// --- Client Normalizers ---");
	});
});
