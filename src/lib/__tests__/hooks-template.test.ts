import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("embeds skip-paths chunk markers (Phase B.3 hook-side early skip)", () => {
		const out = buildHookScript("v");
		// Public surface from the chunk.
		expect(out).toContain("function loadSkipPaths(");
		expect(out).toContain("function globToRegex(");
		expect(out).toContain("function matchesSkipPath(");
		expect(out).toContain("SKIP_PATHS_CACHE");
		expect(out).toContain("if (skipPath && matchesSkipPath(skipPath))");
		expect(out).toContain("[interlinked:skip] path matched skip_paths");
	});

	it("PreToolUse is NOT short-circuited by skip_paths — guard rules must still run", () => {
		// Regression: an earlier wiring used `if (isPreTool || isPostTool)`
		// here, which let any path matching skip_paths bypass repo-confinement,
		// protected-file checks, lockfile-tamper, and other pre_block guards.
		// The hook-side early skip is meant to mute the noisy quality
		// pipeline, NOT to disable safety enforcement on those same paths.
		// Pin the gate so PostToolUse-only is never silently widened back.
		const out = buildHookScript("v");
		// The gate must be PostToolUse-only.
		expect(out).toContain("if (isPostTool) {");
		// And must NOT include PreToolUse in that gate.
		expect(out).not.toMatch(/if \(isPreTool\s*\|\|\s*isPostTool\)\s*\{[\s\S]{0,400}matchesSkipPath/);
		// The PreToolUse "decision:allow" stdout shortcut from the old
		// wiring must be gone (PostToolUse uses formatProviderResponse, so
		// the raw allow shape inside the skip block is unique to the bug).
		expect(out).not.toMatch(/if \(isPreTool\)[\s\S]{0,200}JSON\.stringify\(\{\s*decision:\s*"allow"\s*\}\)/);
	});

	it("extracts file paths from apply_patch payloads for Codex/Copilot edits", () => {
		const out = buildHookScript("v");
		expect(out).toContain('"apply_patch"');
		expect(out).toContain("Move to:");
		expect(out).toContain("(?:Update|Add|Delete) File:");
	});

	it("ships a shared inline PostToolUse strong-typing fallback for Claude and Codex", () => {
		const out = buildHookScript("v");
		expect(out).toContain("inlinePostToolFallback");
		expect(out).toContain("INLINE_STRONG_TYPING_PATTERNS");
		expect(out).toContain("inline strong_typing clean");
		expect(out).toContain("[interlinked:strong_typing]");
	});

	it("inline strong_typing fallback exempts .test.* and .spec.* files (parity with daemon)", () => {
		// Daemon-side strong_typing skips test files at quality-checks.ts:223–225;
		// the inline hook fallback used to fire on them anyway. The generated
		// hook must short-circuit before scanning test files.
		const out = buildHookScript("v");
		expect(out).toContain("/\\.(?:test|spec)\\.(?:tsx?|jsx?|mjs|cjs)$/");
	});

	it("separates advisory PostToolUse warnings from blocking ones in the generated hook", () => {
		const out = buildHookScript("v");
		expect(out).toContain('const responseType = isBlockingPostDecision ? "post_block" : "post_warn";');
		expect(out).toContain('isBlockingPostDecision ? "block" : "warn"');
		expect(out).toContain('Advisory findings:');
	});

	it("keeps the local activity.jsonl write 100% faithful (no scrub) while every egress path scrubs", () => {
		const out = buildHookScript("v");
		// Two-tier model (raw local / redacted egress): the LOCAL write is
		// full-fidelity — appendLocal must NOT run scrubPayload on the record
		// before appendFileSync (raw capture for replay / trajectory / training).
		// If a scrubPayload(record) reappears, local PII/secrets get masked again
		// and the corpus loses fidelity.
		expect(out).not.toMatch(/scrubPayload\(record\)/);
		// ...but EGRESS must still redact: the realtime payload and the batchSync
		// event both run scrubPayload before POSTing. If either regresses, raw
		// PII/secrets would leave the machine.
		expect(out).toContain("scrubPayload(realtimePayload)");
		expect(out).toContain("scrubPayload(ev)");
	});

	it("bounds legacy realtime network work on the hook hot path", () => {
		const out = buildHookScript("v");
		expect(out).toContain("const REALTIME_POST_TIMEOUT_MS = 500");
		expect(out).toContain("const REALTIME_RETRY_TIMEOUT_MS = 250");
		expect(out).toContain("const REALTIME_RETRY_MAX_PER_HOOK = 3");
		expect(out).toContain("fetchWithTimeout(serverUrl + \"/api/hooks/activity\"");
		expect(out).toContain("REALTIME_RETRY_MAX_PER_HOOK");
		expect(out).not.toContain("setTimeout(() => controller.abort(), 3000)");
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

	it("always overwrites hookEvent with the normalized canonical name (Cursor regression)", () => {
		// Regression: previously the resolution was
		//   if (!hookEvent && event.hook_event) { hookEvent = event.hook_event; }
		// which kept Cursor's raw `beforeShellExecution` in `hookEvent`. The
		// downstream `isPreTool/isPostTool/isUserPrompt` matchers and the
		// harness server only recognise canonical names ("PreToolUse" etc.),
		// so destructive Cursor shell/MCP calls bypassed every guard.
		const out = buildHookScript("v");
		expect(out).toMatch(/if \(event\.hook_event\) \{\s*hookEvent = event\.hook_event;\s*\}/);
		expect(out).not.toMatch(/if \(!hookEvent && event\.hook_event\)/);
	});

	it("formatCursorResponse gates on the raw Cursor event name (per-event capabilities)", () => {
		// formatCursorResponse switches on the raw native event (postToolUse
		// supports additional_context, beforeShellExecution / beforeMCPExecution
		// support ask, etc.) — not the canonical PreToolUse alias. Without this
		// the response would either silently skip the gate or misuse fields the
		// runner doesn't accept.
		const out = buildHookScript("v");
		expect(out).toContain('native === "beforeShellExecution"');
		expect(out).toContain('native === "beforeMCPExecution"');
		expect(out).toContain('native === "beforeMcpToolExecution"');
		expect(out).toContain('native === "subagentStart"');
		expect(out).toContain('native === "postToolUse"');
		// And the wiring captures the raw event before normalization rewrites
		// hookEvent to "PreToolUse".
		expect(out).toContain("const cursorNativeEvent = hookEvent;");
	});

	it("formatCursorResponse uses snake_case response fields (per Cursor docs)", () => {
		// Cursor's documented response contract uses snake_case: user_message,
		// agent_message, additional_context, updated_input. The previous
		// camelCase form was silently ignored by Cursor — denials reached the
		// runner with empty messages. This test pins the field naming so a
		// future refactor can't regress it.
		const out = buildHookScript("v");
		expect(out).toContain("agent_message: data.reason");
		expect(out).toContain("user_message: data.reason");
		expect(out).toContain("additional_context: data.summary");
		expect(out).toContain("additional_context: data.reason");
	});

	it("inline guard receives the normalized tool_input (Cursor / Copilot regression)", () => {
		// Regression: the inline fallback used to read `rawInput.tool_input`
		// directly. Cursor's beforeShellExecution carries the command at the
		// top level (rawInput.command), and Copilot wraps args under toolArgs;
		// neither client sets rawInput.tool_input, so the inline guard saw
		// undefined and let destructive commands through whenever the harness
		// was unavailable. The fix passes harnessEvent.tool_input (the
		// post-normalization shape).
		const out = buildHookScript("v");
		expect(out).toContain(
			"inlineGuardCheck(hookEvent, harnessEvent.tool_name, harnessEvent.tool_input)",
		);
		expect(out).not.toContain(
			"inlineGuardCheck(hookEvent, harnessEvent.tool_name, rawInput.tool_input)",
		);
	});

	it("blocks Cursor beforeShellExecution rm -rf via the inline fallback (end-to-end)", () => {
		// Wires the full .mjs runtime against a Cursor-shaped stdin payload to
		// confirm: (1) the Cursor normalizer fires (cursor_version field
		// detection), (2) hookEvent gets resolved to canonical "PreToolUse",
		// (3) isPreTool === true, (4) the inline guard receives a usable
		// tool_input via harnessEvent, (5) the block decision flows through
		// formatCursorResponse and emits Cursor's permission:"deny" stdout.
		// If any of those four bug-paths regress, this test fails.
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-cursor-e2e-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "cursor-test-agent" }),
		);
		// Pretend a harness is "alive" so tryHealHarness returns false (skips
		// the 1.5s retry spin) — we want the inline fallback to fire fast.
		writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
		writeFileSync(join(interlinkedDir, "harness.sock"), "");

		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("test"));

		const cursorPayload = {
			hook_event_name: "beforeShellExecution",
			session_id: "cursor-e2e-session",
			cwd: tempDir,
			command: "rm -rf /",
			cursor_version: "1.0.0",
			conversation_id: "conv-1",
			generation_id: "gen-1",
		};

		const res = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify(cursorPayload),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "cursor",
			},
			timeout: 10_000,
		});

		expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
		const stdout = (res.stdout || "").trim();
		expect(stdout, `expected non-empty stdout; stderr=${res.stderr}`).not.toBe("");
		const parsed = JSON.parse(stdout);
		expect(parsed.permission).toBe("deny");
		// Cursor's response contract is snake_case (user_message /
		// agent_message). The legacy camelCase keys were silently ignored,
		// causing denial messages to reach Cursor empty.
		expect(String(parsed.agent_message || parsed.user_message || "")).toMatch(
			/BLOCKED|recursive|rm -rf/i,
		);
	});

	it("embeds PII redaction scoped to prompt + thinking", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function redactPii");
		expect(out).toContain("[REDACTED:ssn]");
		expect(out).toContain("[REDACTED:email]");
		// PII masking must be scoped to natural-language fields, never tool I/O.
		expect(out).toContain('const PII_FIELDS = ["prompt", "thinking"]');
	});

	it("captures full thinking locally (no 4000-char cap) but bounds the server copy", () => {
		const out = buildHookScript("v");
		// The local capture path must no longer reference the retired cap constant.
		expect(out).not.toContain("THINKING_MAX_LEN");
		// The server-bound realtime payload stays bounded so full reasoning
		// traces do not leave the machine ("store locally for now").
		expect(out).toContain("truncate(event.thinking, 4000)");
	});

	it("stores raw prompt + thinking faithfully in activity.jsonl (local unredacted) + full untruncated thinking", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-pii-e2e-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "pii-test-agent" }),
		);
		// Pretend a harness is "alive" so the hook doesn't spin on retry — we
		// only care about the local write path here (mirrors the Cursor e2e).
		writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
		writeFileSync(join(interlinkedDir, "harness.sock"), "");

		// A transcript whose assistant thinking block exceeds the old 4000 cap
		// and carries PII — proves (a) no truncation, (b) the local write is RAW
		// (PII intact; redaction is egress-only, never applied to local capture).
		const longThinking =
			"reasoning step ".repeat(400) +
			" my ssn is 521-44-8190 and email jane.real@acme.com end";
		const transcriptPath = join(tempDir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: longThinking }] },
			})}\n`,
		);

		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("test"));

		const payload = {
			hook_event_name: "UserPromptSubmit",
			session_id: "pii-e2e-session",
			cwd: tempDir,
			transcript_path: transcriptPath,
			prompt: "reach me at 521-44-8190 or jane.real@acme.com",
		};

		const res = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify(payload),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "claude",
			},
			timeout: 10_000,
		});
		expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();

		const activityPath = join(interlinkedDir, "activity.jsonl");
		expect(existsSync(activityPath), `no activity.jsonl; stderr=${res.stderr}`).toBe(true);
		const records = readFileSync(activityPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));

		const withPrompt = records.find((r) => typeof r.prompt === "string");
		expect(withPrompt, `no prompt record; stderr=${res.stderr}; n=${records.length}`).toBeTruthy();
		// Local is 100% faithful: the prompt's PII is stored RAW, not redacted.
		expect(withPrompt.prompt).toContain("521-44-8190");
		expect(withPrompt.prompt).toContain("jane.real@acme.com");
		expect(withPrompt.prompt).not.toContain("[REDACTED");

		const withThinking = records.find((r) => typeof r.thinking === "string");
		expect(withThinking, `no thinking record; stderr=${res.stderr}; n=${records.length}`).toBeTruthy();
		// Full-fidelity: longer than the retired 4000-char cap, no truncation marker.
		expect(withThinking.thinking.length).toBeGreaterThan(4000);
		expect(withThinking.thinking).not.toContain("... [truncated]");
		// PII stored RAW inside the thinking trace too (egress-only redaction).
		expect(withThinking.thinking).toContain("521-44-8190");
		expect(withThinking.thinking).toContain("jane.real@acme.com");
		expect(withThinking.thinking).not.toContain("[REDACTED");
	});

	it("emits one unified activity schema_version for both record families", () => {
		const out = buildHookScript("v");
		// Single source of truth for the log-format version, used by BOTH writers:
		// appendLocal (activity events) + appendGuardDecision (guard telemetry).
		expect(out).toContain("const ACTIVITY_SCHEMA_VERSION = 5");
		expect(out).toContain("schema_version: ACTIVITY_SCHEMA_VERSION");
		// No stray hard-coded family versions remain (was activity=4 / guard=3).
		expect(out).not.toContain("schema_version: 3,");
		expect(out).not.toContain("schema_version: 4,");
		// Guard exclusion from collection.jsonl is keyed on record TYPE, not version.
		expect(out).toContain('eventType.startsWith("guard_")');
	});
});
