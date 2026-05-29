import { describe, expect, it } from "vitest";
import { buildCollectionRecord } from "../builder.js";
import type { CollectionRecord } from "../types.js";

// Helper: minimal activity event with required fields
function baseEvent(overrides: Record<string, unknown> = {}) {
	return {
		ts: "2026-05-19T12:00:00.000Z",
		agent: "test-agent",
		session: "sess-1",
		type: "tool_use",
		event_type: "tool_use",
		hook_event: "PostToolUse",
		...overrides,
	};
}

function preEvent(overrides: Record<string, unknown> = {}) {
	return baseEvent({
		type: "tool_use_start",
		event_type: "tool_use_start",
		hook_event: "PreToolUse",
		...overrides,
	});
}

// -------------------------------------------------------
// Tool class detection
// -------------------------------------------------------
describe("buildCollectionRecord — tool class detection", () => {
	it("returns null for non-tool events", () => {
		expect(buildCollectionRecord(baseEvent({ event_type: "session_start" }))).toBeNull();
		expect(buildCollectionRecord(baseEvent({ event_type: "session_end" }))).toBeNull();
		expect(buildCollectionRecord(baseEvent({ event_type: "user_prompt" }))).toBeNull();
		expect(buildCollectionRecord(baseEvent({ event_type: "notification" }))).toBeNull();
	});

	it("returns null for guard telemetry regardless of schema_version (type-based, not version-based)", () => {
		// Guard exclusion is keyed on record TYPE (guard_*), not the version
		// number. After the schema unification, guard records carry version 5
		// (was 3); the exclusion must hold across every historical version.
		for (const schema_version of [3, 4, 5, undefined]) {
			for (const event_type of ["guard_block", "guard_warn", "guard_allow"]) {
				expect(
					buildCollectionRecord(baseEvent({ event_type, schema_version })),
					`event_type=${event_type} schema_version=${schema_version}`,
				).toBeNull();
			}
		}
	});

	it("collects tool events regardless of schema_version (version = format, family = type)", () => {
		for (const schema_version of [3, 4, 5]) {
			const rec = buildCollectionRecord(
				baseEvent({ tool_name: "Bash", tool_input: { command: "ls" }, schema_version }),
			);
			expect(rec, `schema_version=${schema_version}`).not.toBeNull();
		}
	});

	it.each([
		["Bash", "shell_exec"],
		["Shell", "shell_exec"],
		["shell", "shell_exec"],
		["run_command", "shell_exec"],
		["Read", "file_read"],
		["ReadFile", "file_read"],
		["read_file", "file_read"],
		["Edit", "file_edit"],
		["EditFile", "file_edit"],
		["edit_file", "file_edit"],
		["MultiEdit", "file_edit"],
		["str_replace", "file_edit"],
		["Write", "file_write"],
		["WriteFile", "file_write"],
		["write_file", "file_write"],
		["CreateFile", "file_write"],
		["create_file", "file_write"],
		["apply_patch", "file_edit"],
		["Grep", "search"],
		["grep", "search"],
		["SearchFiles", "search"],
		["search_files", "search"],
		["Glob", "search"],
		["WebFetch", "fetch"],
		["web_fetch", "fetch"],
		["WebSearch", "fetch"],
		["web_search", "fetch"],
		["NotebookEdit", "notebook_edit"],
		["TaskCreate", "task"],
		["SomeMcpTool", "other"],
	])("maps %s → %s", (toolName, expectedClass) => {
		const rec = buildCollectionRecord(baseEvent({ tool: toolName, tool_name: toolName }));
		expect(rec).not.toBeNull();
		expect(rec!.tool_class).toBe(expectedClass);
	});
});

// -------------------------------------------------------
// shell_exec records
// -------------------------------------------------------
describe("buildCollectionRecord — shell_exec", () => {
	const shellPostEvent = baseEvent({
		tool_name: "Bash",
		tool_input: { command: "npm test" },
		tool_response: { stdout: "ok", stderr: "", exitCode: 0 },
		tool_output_bytes: 42,
		cwd: "/repo",
		git_head: "abc123",
		git_branch: "main",
	});

	it("sets schema and kind on post record", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.schema).toBe("collection.v1");
		expect(rec.kind).toBe("tool_event");
	});

	it("sets phase and tool_class on post record", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.phase).toBe("post");
		expect(rec.tool_class).toBe("shell_exec");
		expect(rec.provider_tool).toBe("Bash");
	});

	it("extracts shell action from tool_input", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.action).toEqual({ command: "npm test", cwd: "/repo" });
	});

	it("extracts shell observation from structured response", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.observation).toMatchObject({ stdout: "ok", stderr: "", exit_code: 0 });
	});

	it("carries git context", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.git).toEqual({ head: "abc123", branch: "main" });
	});

	it("builds post record with string response (Codex-style)", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_response: "file1.ts\nfile2.ts",
				tool_output_bytes: 20,
			}),
		)!;

		expect(rec.observation).toMatchObject({
			stdout: "file1.ts\nfile2.ts",
			combined_output: true,
		});
	});

	it("builds pre record with action only", () => {
		const rec = buildCollectionRecord(
			preEvent({
				tool_name: "Bash",
				tool_input: { command: "npm test" },
				cwd: "/repo",
			}),
		)!;

		expect(rec.phase).toBe("pre");
		expect(rec.action).toEqual({ command: "npm test", cwd: "/repo" });
		expect(rec.observation).toBeNull();
	});
});

// -------------------------------------------------------
// file_read records
// -------------------------------------------------------
describe("buildCollectionRecord — file_read", () => {
	it("builds post record with structured file response", () => {
		const content = "line1\nline2\nline3";
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/src/main.ts", offset: 0, limit: 100 },
				tool_response: { type: "text", file: { filePath: "/src/main.ts", content } },
			}),
		)!;

		expect(rec.tool_class).toBe("file_read");
		expect(rec.action).toEqual({ path: "/src/main.ts", offset: 0, limit: 100 });
		expect(rec.observation).toMatchObject({
			content,
			line_count: 3,
		});
	});

	it("builds post record with string response", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/src/main.ts" },
				tool_response: "the file content",
			}),
		)!;

		expect(rec.observation).toMatchObject({ content: "the file content" });
	});
});

// -------------------------------------------------------
// file_edit records
// -------------------------------------------------------
describe("buildCollectionRecord — file_edit", () => {
	it("maps Edit with old_string/new_string to single hunk", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/src/main.ts",
					old_string: "foo",
					new_string: "bar",
				},
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.tool_class).toBe("file_edit");
		expect(rec.action).toMatchObject({
			path: "/src/main.ts",
			diff: { hunks: [{ old: "foo", new: "bar" }] },
		});
		expect(rec.observation).toMatchObject({ applied: true });
	});

	it("maps MultiEdit to multiple hunks", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "MultiEdit",
				tool_input: {
					file_path: "/src/main.ts",
					edits: [
						{ old_string: "a", new_string: "b" },
						{ old_string: "c", new_string: "d" },
					],
				},
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.action).toMatchObject({
			path: "/src/main.ts",
			diff: {
				hunks: [
					{ old: "a", new: "b" },
					{ old: "c", new: "d" },
				],
			},
		});
	});

	it("maps apply_patch to file_edit", () => {
		const patchBody = "*** Update File: /src/main.ts\n--- old\n+++ new\n-foo\n+bar";
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: patchBody },
				tool_response: "Patch applied",
			}),
		)!;

		expect(rec.tool_class).toBe("file_edit");
		expect(rec.action).toMatchObject({ path: "/src/main.ts" });
	});
});

// -------------------------------------------------------
// file_write records
// -------------------------------------------------------
describe("buildCollectionRecord — file_write", () => {
	it("maps Write to file_write", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Write",
				tool_input: { file_path: "/new.ts", content: "export const x = 1;" },
				tool_response: "File created successfully at /new.ts",
				is_new_file: true,
			}),
		)!;

		expect(rec.tool_class).toBe("file_write");
		expect(rec.action).toMatchObject({
			path: "/new.ts",
			is_new_file: true,
		});
		expect(rec.observation).toMatchObject({ applied: true });
	});
});

// -------------------------------------------------------
// search records
// -------------------------------------------------------
describe("buildCollectionRecord — search", () => {
	it("maps Grep to search", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Grep",
				tool_input: { pattern: "TODO", path: "/src" },
				tool_response: "src/main.ts:5:// TODO fix",
			}),
		)!;

		expect(rec.tool_class).toBe("search");
		expect(rec.action).toEqual({ pattern: "TODO", path: "/src", flags: null });
		expect(rec.observation).toMatchObject({ result_text: "src/main.ts:5:// TODO fix" });
	});
});

// -------------------------------------------------------
// fetch records
// -------------------------------------------------------
describe("buildCollectionRecord — fetch", () => {
	it("maps WebFetch to fetch", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com", prompt: "get data" },
				tool_response: { status: 200, result: "page content" },
			}),
		)!;

		expect(rec.tool_class).toBe("fetch");
		expect(rec.action).toEqual({ url: "https://example.com", prompt: "get data" });
		expect(rec.observation).toMatchObject({ status: 200, result: "page content" });
	});
});

// -------------------------------------------------------
// Fidelity
// -------------------------------------------------------
describe("buildCollectionRecord — fidelity", () => {
	it("marks interlinked_capped when _interlinked_truncated_bytes present", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "find /" },
				tool_response: {
					stdout: "truncated...",
					_interlinked_truncated_bytes: 1048576,
				},
				tool_output_bytes: 1048576,
			}),
		)!;

		const stdoutFidelity = rec.fidelity.fields["observation.stdout"];
		expect(stdoutFidelity).toBeDefined();
		expect(stdoutFidelity.interlinked_capped).toBe(true);
		expect(stdoutFidelity.completeness).toBe("interlinked_capped");
	});

	it("marks complete when no truncation signals", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_response: { stdout: "hi", stderr: "", exitCode: 0 },
				tool_output_bytes: 5,
			}),
		)!;

		const stdoutFidelity = rec.fidelity.fields["observation.stdout"];
		expect(stdoutFidelity.interlinked_capped).toBe(false);
		expect(stdoutFidelity.completeness).toBe("complete");
	});

	it("marks absent when observation field is missing", () => {
		const rec = buildCollectionRecord(
			preEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
			}),
		)!;

		expect(rec.fidelity.record.completeness).toBe("complete");
		expect(Object.keys(rec.fidelity.fields)).toHaveLength(0);
	});
});

// -------------------------------------------------------
// Privacy defaults
// -------------------------------------------------------
describe("buildCollectionRecord — privacy", () => {
	it("sets unscanned for post events with observation", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_response: { stdout: "hi", stderr: "", exitCode: 0 },
			}),
		)!;

		expect(rec.privacy.redaction_status).toBe("unscanned");
		expect(rec.privacy.allowed_for_training).toBe(false);
		expect(rec.privacy.allowed_for_cloud_upload).toBe(false);
	});

	it("sets not_required for post events with no observation", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
			}),
		)!;

		expect(rec.privacy.redaction_status).toBe("not_required");
	});

	it("sets not_required for pre events", () => {
		const rec = buildCollectionRecord(
			preEvent({ tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;

		expect(rec.privacy.redaction_status).toBe("not_required");
	});
});

// -------------------------------------------------------
// Provider metadata
// -------------------------------------------------------
describe("buildCollectionRecord — provider_raw", () => {
	it("carries tool_response_sha256 from activity event", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				tool_response: "hi",
				tool_response_sha256: "abcd1234",
			}),
		)!;

		expect(rec.provider_raw.tool_response_sha256).toBe("abcd1234");
	});
});

// -------------------------------------------------------
// Provider detection
// -------------------------------------------------------
describe("buildCollectionRecord — provider", () => {
	it("detects claude-code from hook_event PascalCase", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;
		expect(rec.provider).toBe("claude-code");
	});

	it("detects codex from client_runner field", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				client_runner: "codex",
			}),
		)!;
		expect(rec.provider).toBe("codex");
	});
});

// -------------------------------------------------------
// Edge cases
// -------------------------------------------------------
describe("buildCollectionRecord — edge cases", () => {
	it("handles null tool_response gracefully", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: null }),
		)!;

		expect(rec.observation).toBeNull();
	});

	it("handles missing tool_input gracefully", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", event_type: "tool_use" }),
		)!;

		expect(rec).not.toBeNull();
		expect(rec.action).toMatchObject({ command: "" });
	});

	it("carries session_id and tool_use_id", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				session: "sess-42",
				tool_use_id: "tu-7",
				turn_id: "turn-3",
			}),
		)!;

		expect(rec.session_id).toBe("sess-42");
		expect(rec.tool_use_id).toBe("tu-7");
		expect(rec.turn_id).toBe("turn-3");
	});
});
