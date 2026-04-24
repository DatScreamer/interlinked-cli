import { spawnSync } from "node:child_process";
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

	it("scrubs credentials in appendLocal before writing to activity.jsonl", () => {
		const out = buildHookScript("v");
		// Regression guard: scrubPayload must run inside appendLocal so local
		// writes get the same credential redaction the remote sync path does.
		// If this assertion fails, credentials in prompts/tool_input_summary/
		// thinking will hit disk unmasked again.
		expect(out).toMatch(/scrubPayload\(record\);\s*appendFileSync\(ACTIVITY_PATH/);
	});

	it("generated .mjs parses as valid JavaScript (end-to-end syntactic check)", () => {
		// Pipe the script into `node --check` with ESM input-type so a broken
		// chunk (extra `\\`, unterminated string, mis-escaped backtick)
		// surfaces here instead of blowing up on every user's machine when the
		// hook fires. The generated script is an ES module (top-level
		// `import` statements), so we must declare that explicitly when
		// feeding it via stdin.
		const script = buildHookScript("parse-check");
		const res = spawnSync(
			process.execPath,
			["--input-type=module", "--check", "-"],
			{ input: script, encoding: "utf-8" },
		);
		expect(res.status, `node --check rejected the hook script: ${res.stderr}`).toBe(0);
	});

	it("generated .mjs uses argv-form git invocations (no shell interpolation)", () => {
		// Security regression guard for Vuln 1: reconcileCommits must never
		// concatenate session_start_head or a commit hash into a shell string.
		// If these fragments disappear, the fix has regressed.
		const out = buildHookScript("v");
		expect(out).toContain("function isGitSha(v)");
		expect(out).toContain("/^[0-9a-fA-F]{7,40}$/");
		expect(out).toContain('["log", state.session_start_head + "..HEAD"');
		expect(out).toContain('["diff", hash + "~1", hash, "--name-only"]');
		expect(out).toContain('["diff", hash + "~1", hash, "--numstat"]');
		// The old shell form is gone.
		expect(out).not.toContain('execSync("git log " +');
		expect(out).not.toContain('execSync(\n                "git log " +');
	});
});
