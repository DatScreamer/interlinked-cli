import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../types.js";
import { extractScannableContent } from "../extractor.js";
import type { ContentScannerConfig } from "../types.js";

// ===========================================
// Fixtures
// ===========================================

function makeConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "/tmp/opf-sidecar.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: { model: "openai/gpt-oss-safeguard-20b", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Write",
		tool_input: {},
		timestamp: "2026-04-24T00:00:00Z",
		...overrides,
	};
}

// ===========================================
// Write / Edit family
// ===========================================

describe("extractScannableContent — write/edit", () => {
	it("extracts the full content for a Write", () => {
		const req = extractScannableContent(
			makeEvent({ tool_name: "Write", tool_input: { file_path: "/x.ts", content: "hello" } }),
			makeConfig(),
		);
		expect(req?.hook).toBe("pre_write_edit");
		expect(req?.parts).toEqual([{ source: "Write.content", text: "hello" }]);
	});

	it("resolves the post-patch content for an Edit even without a file on disk", () => {
		// `resolveProposedContent` falls back to `new_string` when `file_path` is missing.
		const req = extractScannableContent(
			makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/does/not/exist.ts",
					old_string: "foo",
					new_string: "email: alice@example.com",
				},
			}),
			makeConfig(),
		);
		expect(req?.hook).toBe("pre_write_edit");
		expect(req?.parts[0].source).toBe("Edit.content");
		expect(req?.parts[0].text).toBe("email: alice@example.com");
	});

	it("also covers the Copilot-style Write aliases", () => {
		for (const toolName of ["write_file", "create", "str_replace", "apply_patch"]) {
			const req = extractScannableContent(
				makeEvent({
					tool_name: toolName,
					tool_input: { file_path: "/x.ts", content: "payload" },
				}),
				makeConfig(),
			);
			expect(req?.hook).toBe("pre_write_edit");
		}
	});

	it("returns undefined when content resolves to empty string", () => {
		const req = extractScannableContent(
			makeEvent({ tool_name: "Write", tool_input: { file_path: "/x.ts", content: "" } }),
			makeConfig(),
		);
		expect(req).toBeUndefined();
	});

	it("is skipped when write_edit scan point is off", () => {
		const cfg = makeConfig();
		cfg.scan_points.write_edit = false;
		const req = extractScannableContent(
			makeEvent({ tool_name: "Write", tool_input: { file_path: "/x.ts", content: "hello" } }),
			cfg,
		);
		expect(req).toBeUndefined();
	});
});

// ===========================================
// Bash
// ===========================================

describe("extractScannableContent — bash", () => {
	it("extracts the full command for a Bash call", () => {
		const req = extractScannableContent(
			makeEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
			makeConfig(),
		);
		expect(req?.hook).toBe("pre_bash_command");
		expect(req?.parts).toEqual([{ source: "Bash.command", text: "echo hi" }]);
	});

	it("covers shell aliases (Shell, shell, bash, run_command)", () => {
		for (const toolName of ["Shell", "shell", "bash", "run_command"]) {
			const req = extractScannableContent(
				makeEvent({ tool_name: toolName, tool_input: { command: "ls" } }),
				makeConfig(),
			);
			expect(req?.hook).toBe("pre_bash_command");
		}
	});

	it("returns undefined when command is missing", () => {
		const req = extractScannableContent(
			makeEvent({ tool_name: "Bash", tool_input: {} }),
			makeConfig(),
		);
		expect(req).toBeUndefined();
	});

	it("is skipped when bash_command scan point is off", () => {
		const cfg = makeConfig();
		cfg.scan_points.bash_command = false;
		const req = extractScannableContent(
			makeEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
			cfg,
		);
		expect(req).toBeUndefined();
	});
});

// ===========================================
// External egress — WebFetch / WebSearch
// ===========================================

describe("extractScannableContent — WebFetch/WebSearch", () => {
	it("extracts url + prompt for WebFetch", () => {
		const req = extractScannableContent(
			makeEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com/?k=v", prompt: "summarize" },
			}),
			makeConfig(),
		);
		expect(req?.hook).toBe("pre_external_egress");
		expect(req?.parts).toEqual([
			{ source: "WebFetch.url", text: "https://example.com/?k=v" },
			{ source: "WebFetch.prompt", text: "summarize" },
		]);
	});

	it("extracts the query for WebSearch", () => {
		const req = extractScannableContent(
			makeEvent({
				tool_name: "WebSearch",
				tool_input: { query: "alice@example.com contact info" },
			}),
			makeConfig(),
		);
		expect(req?.hook).toBe("pre_external_egress");
		expect(req?.parts).toEqual([
			{ source: "WebSearch.query", text: "alice@example.com contact info" },
		]);
	});

	it("is skipped when external_egress scan point is off", () => {
		const cfg = makeConfig();
		cfg.scan_points.external_egress = false;
		const req = extractScannableContent(
			makeEvent({ tool_name: "WebFetch", tool_input: { url: "https://x.com" } }),
			cfg,
		);
		expect(req).toBeUndefined();
	});
});

// ===========================================
// External MCP
// ===========================================

describe("extractScannableContent — external MCP", () => {
	it("walks top-level string fields for mcp__ tools", () => {
		const req = extractScannableContent(
			makeEvent({
				tool_name: "mcp__gmail__send",
				tool_input: {
					to: "alice@example.com",
					subject: "hi",
					body: "here is a token: sk_live_abc",
					attachments: 3, // non-string — skipped
				},
			}),
			makeConfig(),
		);
		expect(req?.hook).toBe("pre_external_egress");
		expect(req?.parts.map((p) => p.source).sort()).toEqual([
			"mcp__gmail__send.body",
			"mcp__gmail__send.subject",
			"mcp__gmail__send.to",
		]);
	});

	it("returns undefined when mcp tool has no string fields", () => {
		const req = extractScannableContent(
			makeEvent({
				tool_name: "mcp__server__tool",
				tool_input: { count: 3, enabled: true },
			}),
			makeConfig(),
		);
		expect(req).toBeUndefined();
	});

	it("is skipped when external_egress scan point is off", () => {
		const cfg = makeConfig();
		cfg.scan_points.external_egress = false;
		const req = extractScannableContent(
			makeEvent({ tool_name: "mcp__x__y", tool_input: { field: "text" } }),
			cfg,
		);
		expect(req).toBeUndefined();
	});
});

// ===========================================
// Non-matching tools
// ===========================================

describe("extractScannableContent — non-matching", () => {
	it("returns undefined for Read/Grep (handled at PostToolUse, not here)", () => {
		for (const toolName of ["Read", "Grep", "Glob", "ReadFile"]) {
			const req = extractScannableContent(
				makeEvent({ tool_name: toolName, tool_input: { file_path: "/x.ts" } }),
				makeConfig(),
			);
			expect(req).toBeUndefined();
		}
	});

	it("returns undefined for unknown tool names", () => {
		const req = extractScannableContent(
			makeEvent({ tool_name: "CustomTool", tool_input: { anything: "x" } }),
			makeConfig(),
		);
		expect(req).toBeUndefined();
	});

	it("returns undefined when tool_name is empty", () => {
		const req = extractScannableContent(makeEvent({ tool_name: "" }), makeConfig());
		expect(req).toBeUndefined();
	});
});
