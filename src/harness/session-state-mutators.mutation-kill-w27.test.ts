import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureGitBaselineMock } = vi.hoisted(() => ({
	captureGitBaselineMock: vi.fn(() => ({
		modified: new Set<string>(),
		staged: new Set<string>(),
		untracked: new Set<string>(),
		head_sha: "",
	})),
}));

vi.mock("./session-git-baseline.js", () => ({
	captureGitBaseline: captureGitBaselineMock,
}));

import {
	appendStubsCapped,
	createFreshSession,
	trackCommand,
	trackFileOperations,
	trackToolCall,
} from "./session-state-mutators.js";
import type { HarnessEvent } from "./types.js";

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "session-1",
		agent_source: "claude",
		timestamp: "2026-08-20T00:00:00.000Z",
		cwd: "/repo",
		...overrides,
	};
}

describe("session state mutators — wave 27 survivor kills", () => {
	beforeEach(() => {
		captureGitBaselineMock.mockClear();
	});

	describe("appendStubsCapped", () => {
		// test-contract: an empty (but defined) source list must not allocate the destination array.
		it("leaves an unset destination array unset for an empty (defined) source list", () => {
			const from = createFreshSession(event(), "from");
			from.stubs_introduced = [];
			const to = createFreshSession(event(), "to");
			delete to.stubs_introduced;

			appendStubsCapped(from, to);

			expect(to.stubs_introduced).toBeUndefined();
		});
	});

	describe("createFreshSession", () => {
		// test-contract: absent agent_name falls back to the session id truncated to its first 8 characters.
		it("truncates a long session id to 8 characters in the fallback agent name", () => {
			const session = createFreshSession(event(), "abcdefghijklmnop");
			expect(session.agent_name).toBe("session-abcdefgh");
		});

		// test-contract: a fresh session starts at the documented "Public" sensitivity level.
		it("defaults sensitivity_level to Public", () => {
			const session = createFreshSession(event(), "session-1");
			expect(session.sensitivity_level).toBe("Public");
		});

		// test-contract: a fresh session starts with an empty injection-detection step list.
		it("defaults injection_detected_steps to an empty array", () => {
			const session = createFreshSession(event(), "session-1");
			expect(session.injection_detected_steps).toEqual([]);
		});

		// test-contract: a fresh session starts with an empty PII-detection step list.
		it("defaults pii_detected_steps to an empty array", () => {
			const session = createFreshSession(event(), "session-1");
			expect(session.pii_detected_steps).toEqual([]);
		});

		// test-contract: a fresh session starts with mid_session_nudge_emitted false, not true.
		it("defaults mid_session_nudge_emitted to false", () => {
			const session = createFreshSession(event(), "session-1");
			expect(session.mid_session_nudge_emitted).toBe(false);
		});

		// test-contract: a fresh session starts with stop_nudge_emitted false, not true.
		it("defaults stop_nudge_emitted to false", () => {
			const session = createFreshSession(event(), "session-1");
			expect(session.stop_nudge_emitted).toBe(false);
		});

		// test-contract: an explicit event.cwd is passed through as-is to the git baseline
		// capture (?? semantics), not replaced by process.cwd() (&& semantics would
		// evaluate process.cwd() whenever event.cwd is truthy).
		it("passes the event's own cwd to captureGitBaseline unchanged", () => {
			const session = createFreshSession(event({ cwd: "/custom/repo/path" }), "session-1");
			expect(captureGitBaselineMock).toHaveBeenCalledWith("/custom/repo/path");
			expect(session.git_session_baseline).toBe(captureGitBaselineMock.mock.results[0]?.value);
		});
	});

	describe("trackToolCall", () => {
		// test-contract: an already-populated verification_observed set is unioned into,
		// not replaced, when a browser-MCP tool fires again.
		it("unions a browser signal into an already-populated verification_observed set", () => {
			const session = createFreshSession(event(), "session-1");
			session.verification_observed = new Set(["typecheck"]);
			trackToolCall(
				session,
				event({ tool_name: "mcp__chrome-devtools__click", tool_input: {} }),
			);
			expect(session.verification_observed).toEqual(new Set(["typecheck", "browser"]));
		});

		// test-contract: tool_sequence is never reassigned to a new array while its length
		// stays at or below the 20-entry cap (the trim only fires once the cap is exceeded).
		it("never reassigns tool_sequence while at or under the 20-entry cap", () => {
			const session = createFreshSession(event(), "session-1");
			const originalRef = session.tool_sequence;
			for (let index = 0; index < 20; index++) {
				trackToolCall(
					session,
					event({ tool_name: "Read", tool_input: { file_path: `f${index}.ts` } }),
				);
			}
			expect(session.tool_sequence).toHaveLength(20);
			expect(session.tool_sequence).toBe(originalRef);
		});
	});

	describe("trackFileOperations — trackReadWrite branches", () => {
		// test-contract: when the resolved absolute path already equals the raw path, the
		// read branch must add to files_read exactly once (no redundant second add call)
		// while still leaving files_read holding exactly that one path.
		it("adds to files_read exactly once for an already-absolute read path", () => {
			const session = createFreshSession(event(), "session-1");
			const addSpy = vi.spyOn(session.files_read, "add");
			trackFileOperations(
				session,
				event({ tool_name: "Read", tool_input: { file_path: "/abs/same.ts" }, cwd: "/abs" }),
			);
			expect(addSpy).toHaveBeenCalledTimes(1);
			expect(session.files_read).toEqual(new Set(["/abs/same.ts"]));
		});

		// test-contract: a plain Edit is not classified as a read operation, regardless of
		// whether isReadOperation's guard is bypassed.
		it("does not populate files_read for a non-read tool", () => {
			const session = createFreshSession(event(), "session-1");
			trackFileOperations(
				session,
				event({
					tool_name: "Edit",
					tool_outcome: "success",
					tool_input: { file_path: "src/edited.ts" },
				}),
			);
			expect(session.files_read.size).toBe(0);
		});

		// test-contract: a relative read path records BOTH the raw form and its
		// cwd-resolved absolute form in files_read.
		it("records both the raw and resolved-absolute form of a relative read path", () => {
			const session = createFreshSession(event(), "session-1");
			trackFileOperations(
				session,
				event({ tool_name: "Read", tool_input: { file_path: "src/file.ts" }, cwd: "/repo" }),
			);
			expect(session.files_read.has("src/file.ts")).toBe(true);
			expect(session.files_read.has("/repo/src/file.ts")).toBe(true);
		});

		// test-contract: when the resolved absolute path already equals the raw path, the
		// write branch must add to files_written exactly once (no redundant second add)
		// while still leaving files_written holding exactly that one path.
		it("adds to files_written exactly once for an already-absolute write path", () => {
			const session = createFreshSession(event(), "session-1");
			const addSpy = vi.spyOn(session.files_written, "add");
			trackFileOperations(
				session,
				event({
					tool_name: "Edit",
					tool_outcome: "success",
					tool_input: { file_path: "/abs/written.ts" },
					cwd: "/abs",
				}),
			);
			expect(addSpy).toHaveBeenCalledTimes(1);
			expect(session.files_written).toEqual(new Set(["/abs/written.ts"]));
		});

		// test-contract: a second successful edit of the same file increments its
		// file_edit_counts entry to 2, not resets it back to 1.
		it("increments file_edit_counts across repeated edits of the same file", () => {
			const session = createFreshSession(event(), "session-1");
			const write = () =>
				trackFileOperations(
					session,
					event({
						tool_name: "Edit",
						tool_outcome: "success",
						tool_input: { file_path: "/abs/repeat.ts" },
						cwd: "/abs",
					}),
				);
			write();
			write();
			expect(session.file_edit_counts.get("/abs/repeat.ts")).toBe(2);
		});
	});

	describe("trackCommand", () => {
		// test-contract: commands_run is never reassigned to a new array while its length
		// stays at or below the 100-entry cap (the trim only fires once exceeded).
		it("never reassigns commands_run while at or under the 100-entry cap", () => {
			const session = createFreshSession(event(), "session-1");
			const originalRef = session.commands_run;
			for (let index = 0; index < 100; index++) {
				trackCommand(session, event({ tool_name: "Bash", tool_input: { command: `echo ${index}` } }));
			}
			expect(session.commands_run).toHaveLength(100);
			expect(session.commands_run).toBe(originalRef);
		});
	});

	describe("extractToolTarget (via trackToolCall)", () => {
		// test-contract: the whitespace-run split treats a double space as one separator,
		// not two, so the npm-subcommand branch still sees the true second token.
		it("collapses a double space between the command and its subcommand", () => {
			const session = createFreshSession(event(), "session-1");
			trackToolCall(session, event({ tool_name: "Bash", tool_input: { command: "npm  run build" } }));
			expect(session.tool_sequence).toEqual(["Bash:npm run"]);
		});

		// test-contract: an unrecognized single-word command base is truncated to 30 chars.
		it("truncates a long unrecognized command base to 30 characters", () => {
			const session = createFreshSession(event(), "session-1");
			const longWord = "y".repeat(50);
			trackToolCall(session, event({ tool_name: "Bash", tool_input: { command: longWord } }));
			expect(session.tool_sequence).toEqual([`Bash:${"y".repeat(30)}`]);
		});
	});

	describe("shortenPath (via trackToolCall path input)", () => {
		// test-contract: leading/trailing slashes produce empty split segments that must be
		// filtered out before the 2-segment check, not counted toward path length.
		it("filters empty segments from leading/trailing slashes before shortening", () => {
			const session = createFreshSession(event(), "session-1");
			trackToolCall(session, event({ tool_name: "Ls", tool_input: { path: "/a/b/" } }));
			expect(session.tool_sequence).toEqual(["Ls:a/b"]);
		});

		// test-contract: a path with more than 2 segments keeps its LAST 2, not its first 2.
		it("keeps the last 2 segments of a deep path, not the first 2", () => {
			const session = createFreshSession(event(), "session-1");
			trackToolCall(session, event({ tool_name: "Ls", tool_input: { path: "a/b/c/d/e.ts" } }));
			expect(session.tool_sequence).toEqual(["Ls:d/e.ts"]);
		});

		// test-contract: a 2-segment path is rejoined with "/", not concatenated bare.
		it("rejoins a 2-segment path with a slash separator", () => {
			const session = createFreshSession(event(), "session-1");
			trackToolCall(session, event({ tool_name: "Ls", tool_input: { path: "src/file.ts" } }));
			expect(session.tool_sequence).toEqual(["Ls:src/file.ts"]);
		});
	});

	describe("isReadOperation (via trackFileOperations)", () => {
		it.each(["ReadFile", "read_file", "Glob", "Grep", "grep", "ListFiles"])(
			// test-contract: %s is recognized as a read operation and populates files_read.
			"recognizes %s as a read operation",
			(toolName) => {
				const session = createFreshSession(event(), "session-1");
				trackFileOperations(
					session,
					event({ tool_name: toolName, tool_input: { file_path: "src/target.ts" } }),
				);
				expect(session.files_read.has("src/target.ts")).toBe(true);
			},
		);
	});

	describe("isWriteOperation (via trackFileOperations)", () => {
		it.each(["WriteFile", "EditFile", "write_file", "edit_file", "NotebookEdit"])(
			// test-contract: %s is recognized as a write operation and populates files_written
			// on a successful outcome.
			"recognizes %s as a write operation",
			(toolName) => {
				const session = createFreshSession(event(), "session-1");
				trackFileOperations(
					session,
					event({
						tool_name: toolName,
						tool_outcome: "success",
						tool_input: { file_path: "src/target.ts" },
					}),
				);
				expect(session.files_written.has("src/target.ts")).toBe(true);
			},
		);
	});

	describe("isBashTool (via trackCommand)", () => {
		it.each(["Shell", "shell", "run_command"])(
			// test-contract: %s is recognized as a Bash-family tool and records its command.
			"recognizes %s as a Bash-family tool",
			(toolName) => {
				const session = createFreshSession(event(), "session-1");
				trackCommand(session, event({ tool_name: toolName, tool_input: { command: "echo hi" } }));
				expect(session.commands_run).toEqual(["echo hi"]);
			},
		);
	});
});
