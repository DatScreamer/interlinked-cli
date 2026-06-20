import { describe, expect, it } from "vitest";
import { nonNull } from "../../non-null.js";
import { buildCollectionRecord } from "../builder.js";
import type { CollectionRecord } from "../types.js";

// -------------------------------------------------------
// Fixture helpers
// -------------------------------------------------------

function claudePost(overrides: Record<string, unknown> = {}) {
	return {
		ts: "2026-05-19T12:00:00.000Z",
		agent: "test-agent",
		session: "sess-1",
		event_type: "tool_use",
		hook_event: "PostToolUse",
		...overrides,
	};
}

function claudePre(overrides: Record<string, unknown> = {}) {
	return {
		ts: "2026-05-19T12:00:00.000Z",
		agent: "test-agent",
		session: "sess-1",
		event_type: "tool_use_start",
		hook_event: "PreToolUse",
		...overrides,
	};
}

function codexPost(overrides: Record<string, unknown> = {}) {
	return claudePost({ client_runner: "codex", ...overrides });
}

function geminiPost(overrides: Record<string, unknown> = {}) {
	return claudePost({ hook_event: "AfterTool", ...overrides });
}

function cursorPost(overrides: Record<string, unknown> = {}) {
	return claudePost({ cursor_version: "1.0", conversation_id: "conv-1", ...overrides });
}

function assertCollectionShape(rec: CollectionRecord) {
	expect(rec.schema).toBe("collection.v1");
	expect(rec.kind).toBe("tool_event");
	expect(rec.ts).toBeTruthy();
	expect(rec.fidelity.record.source).toBe("provider_hook");
	expect(rec.privacy.allowed_for_training).toBe(false);
	expect(rec.privacy.allowed_for_cloud_upload).toBe(false);
}

// -------------------------------------------------------
// Claude Code — shell_exec
// -------------------------------------------------------

describe("Claude Code — shell_exec", () => {
	it("success with structured response", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_response: { stdout: "PASS", stderr: "", exitCode: 0 },
			tool_output_bytes: 100,
			cwd: "/repo",
		}))!;

		assertCollectionShape(rec);
		expect(rec.provider).toBe("claude-code");
		expect(rec.tool_class).toBe("shell_exec");
		expect(rec.phase).toBe("post");
		expect(rec.action).toEqual({ command: "npm test", cwd: "/repo" });
		expect(rec.observation).toMatchObject({ stdout: "PASS", exit_code: 0 });
	});

	it("failure with non-zero exit code", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Bash",
			tool_input: { command: "false" },
			tool_response: { stdout: "", stderr: "command failed", exitCode: 1 },
			tool_output_bytes: 20,
		}))!;

		expect(rec.observation).toMatchObject({ stderr: "command failed", exit_code: 1 });
	});

	it("pre-tool event has action but no observation", () => {
		const rec = buildCollectionRecord(claudePre({
			tool_name: "Bash",
			tool_input: { command: "npm test" },
		}))!;

		expect(rec.phase).toBe("pre");
		expect(rec.action).toEqual({ command: "npm test", cwd: null });
		expect(rec.observation).toBeNull();
	});
});

// -------------------------------------------------------
// Claude Code — file_read
// -------------------------------------------------------

describe("Claude Code — file_read", () => {
	it("structured file payload", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Read",
			tool_input: { file_path: "/src/main.ts", offset: 10, limit: 50 },
			tool_response: { type: "text", file: { filePath: "/src/main.ts", content: "const x = 1;\n" } },
		}))!;

		assertCollectionShape(rec);
		expect(rec.tool_class).toBe("file_read");
		expect(rec.action).toEqual({ path: "/src/main.ts", offset: 10, limit: 50 });
		expect(rec.observation).toMatchObject({ content: "const x = 1;\n", line_count: 2 });
	});

	it("string file content", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Read",
			tool_input: { file_path: "/readme.md" },
			tool_response: "# Hello",
		}))!;

		expect(rec.observation).toMatchObject({ content: "# Hello", line_count: 1 });
	});
});

// -------------------------------------------------------
// Claude Code — file_edit
// -------------------------------------------------------

describe("Claude Code — file_edit", () => {
	it("Edit with single hunk", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Edit",
			tool_input: { file_path: "/src/a.ts", old_string: "foo", new_string: "bar" },
			tool_response: "File edited successfully",
		}))!;

		assertCollectionShape(rec);
		expect(rec.tool_class).toBe("file_edit");
		expect(rec.action).toMatchObject({
			path: "/src/a.ts",
			diff: { hunks: [{ old: "foo", new: "bar" }] },
		});
		expect(rec.observation).toMatchObject({ applied: true });
	});

	it("MultiEdit with multiple hunks", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "MultiEdit",
			tool_input: {
				file_path: "/src/b.ts",
				edits: [
					{ old_string: "a", new_string: "b" },
					{ old_string: "c", new_string: "d" },
				],
			},
			tool_response: "File edited successfully",
		}))!;

		expect(rec.action).toMatchObject({
			diff: { hunks: [{ old: "a", new: "b" }, { old: "c", new: "d" }] },
		});
	});
});

// -------------------------------------------------------
// Claude Code — file_write
// -------------------------------------------------------

describe("Claude Code — file_write", () => {
	it("new file creation", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Write",
			tool_input: { file_path: "/new.ts", content: "export {};" },
			tool_response: "File created successfully at /new.ts",
			is_new_file: true,
		}))!;

		assertCollectionShape(rec);
		expect(rec.tool_class).toBe("file_write");
		expect(rec.action).toMatchObject({ path: "/new.ts", is_new_file: true });
		expect(rec.observation).toMatchObject({ applied: true });
	});
});

// -------------------------------------------------------
// Claude Code — search
// -------------------------------------------------------

describe("Claude Code — search", () => {
	it("Grep result", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Grep",
			tool_input: { pattern: "TODO", path: "/src" },
			tool_response: "src/a.ts:1:// TODO\nsrc/b.ts:5:// TODO",
		}))!;

		assertCollectionShape(rec);
		expect(rec.tool_class).toBe("search");
		expect(rec.action).toEqual({ pattern: "TODO", path: "/src", flags: null });
		expect(rec.observation).toMatchObject({ result_text: "src/a.ts:1:// TODO\nsrc/b.ts:5:// TODO" });
	});
});

// -------------------------------------------------------
// Claude Code — fetch
// -------------------------------------------------------

describe("Claude Code — fetch", () => {
	it("WebFetch with structured response", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "WebFetch",
			tool_input: { url: "https://example.com" },
			tool_response: { status: 200, result: "page content", bytes: 1200 },
		}))!;

		assertCollectionShape(rec);
		expect(rec.tool_class).toBe("fetch");
		expect(rec.action).toEqual({ url: "https://example.com", prompt: null });
		expect(rec.observation).toMatchObject({ status: 200, result: "page content", bytes: 1200 });
	});

	it("WebSearch maps to fetch class", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "WebSearch",
			tool_input: { query: "vitest docs" },
			tool_response: "Results...",
		}))!;

		expect(rec.tool_class).toBe("fetch");
		expect(rec.action).toEqual({ url: "vitest docs", prompt: null });
	});
});

// -------------------------------------------------------
// Codex — shell_exec (string response variant)
// -------------------------------------------------------

describe("Codex — shell_exec", () => {
	it("string tool_response maps to combined stdout", () => {
		const rec = buildCollectionRecord(codexPost({
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
			tool_response: "total 8\ndrwxr-xr-x",
			tool_output_bytes: 30,
		}))!;

		assertCollectionShape(rec);
		expect(rec.provider).toBe("codex");
		expect(rec.tool_class).toBe("shell_exec");
		expect(rec.observation).toMatchObject({
			stdout: "total 8\ndrwxr-xr-x",
			combined_output: true,
		});
	});
});

// -------------------------------------------------------
// Codex — apply_patch
// -------------------------------------------------------

describe("Codex — apply_patch", () => {
	it("parses file path from patch body", () => {
		const patch = "*** Update File: /src/main.ts\n--- old\n+++ new\n@@ -1 +1 @@\n-old\n+new";
		const rec = buildCollectionRecord(codexPost({
			tool_name: "apply_patch",
			tool_input: { command: patch },
			tool_response: "Patch applied",
		}))!;

		expect(rec.provider).toBe("codex");
		expect(rec.tool_class).toBe("file_edit");
		expect(rec.action).toMatchObject({ path: "/src/main.ts" });
	});
});

// -------------------------------------------------------
// Gemini CLI — shell + edit
// -------------------------------------------------------

describe("Gemini CLI — AfterTool", () => {
	it("detects gemini-cli provider from AfterTool hook event", () => {
		const rec = buildCollectionRecord(geminiPost({
			tool_name: "Bash",
			tool_input: { command: "echo hello" },
			tool_response: { stdout: "hello", exitCode: 0 },
		}))!;

		expect(rec.provider).toBe("gemini-cli");
		expect(rec.tool_class).toBe("shell_exec");
	});
});

// -------------------------------------------------------
// Cursor — provider detection
// -------------------------------------------------------

describe("Cursor — provider detection", () => {
	it("detects cursor from cursor_version field", () => {
		const rec = buildCollectionRecord(cursorPost({
			tool_name: "Bash",
			tool_input: { command: "echo test" },
			tool_response: { stdout: "test", exitCode: 0 },
		}))!;

		expect(rec.provider).toBe("cursor");
	});
});

// -------------------------------------------------------
// Interlinked-capped output
// -------------------------------------------------------

describe("interlinked-capped output fixture", () => {
	it("marks field fidelity as interlinked_capped", () => {
		const rec = buildCollectionRecord(claudePost({
			tool_name: "Bash",
			tool_input: { command: "find / -type f" },
			tool_response: {
				stdout: "[truncated middle]...",
				stderr: "",
				exitCode: 0,
				_interlinked_truncated_bytes: 5242880,
			},
			tool_output_bytes: 5242880,
		}))!;

		assertCollectionShape(rec);
		expect(rec.fidelity.record.completeness).toBe("interlinked_capped");
		const stdoutField = nonNull(rec.fidelity.fields["observation.stdout"]);
		expect(stdoutField.interlinked_capped).toBe(true);
		expect(stdoutField.completeness).toBe("interlinked_capped");
		expect(stdoutField.provider_truncated).toBe("unknown");
	});
});

// -------------------------------------------------------
// No guard telemetry in collection
// -------------------------------------------------------

describe("guard telemetry exclusion", () => {
	it("returns null for guard_block events (schema_version 3)", () => {
		expect(buildCollectionRecord({
			ts: "2026-05-19T12:00:00.000Z",
			agent: "test",
			event_type: "guard_block",
			schema_version: 3,
			tool_name: "Bash",
			tool_input: { command: "rm -rf /" },
		})).toBeNull();
	});

	it("returns null for guard_allow events", () => {
		expect(buildCollectionRecord({
			ts: "2026-05-19T12:00:00.000Z",
			agent: "test",
			event_type: "guard_allow",
			schema_version: 3,
			tool_name: "Bash",
		})).toBeNull();
	});
});
