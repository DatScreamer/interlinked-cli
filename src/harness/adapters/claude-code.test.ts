import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code.js";

const adapter = createClaudeCodeAdapter();

describe("Claude Code adapter identity", () => {
	it("has the expected id and label", () => {
		expect(adapter.id).toBe("claude-code");
		expect(adapter.label).toBe("Claude Code");
	});
	it("covers all known native events", () => {
		expect(adapter.nativeEventNames).toContain("PreToolUse");
		expect(adapter.nativeEventNames).toContain("PostToolUse");
		expect(adapter.nativeEventNames).toContain("SessionStart");
	});
});

describe("Claude Code detectFromEnv", () => {
	it("detects CLAUDE_CODE env", () => {
		expect(adapter.detectFromEnv({ CLAUDE_CODE: "1" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Claude Code parseHookInput — PreToolUse Edit", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "s-1",
			cwd: "/repo",
			hook_event_name: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
		},
		"PreToolUse",
	);

	it("has schema_version 1", () => {
		expect(event.schema_version).toBe("1");
	});
	it("has phase pre-tool", () => {
		expect(event.phase).toBe("pre-tool");
	});
	it("classifies Edit as modify", () => {
		expect(event.action.kind).toBe("tool_call");
		if (event.action.kind === "tool_call") {
			expect(event.action.tool_class).toBe("modify");
			expect(event.action.tool_name).toBe("edit");
		}
	});
	it("preserves session id and cwd", () => {
		expect(event.session_id).toBe("s-1");
		expect(event.context.cwd).toBe("/repo");
	});
});

describe("Claude Code parseHookInput — PreToolUse Bash", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "s-2",
			cwd: "/repo",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /tmp/out" },
		},
		"PreToolUse",
	);
	it("routes Bash through command classifier", () => {
		if (event.action.kind === "tool_call") {
			expect(event.action.tool_class).toBe("side-effect");
		} else {
			throw new Error("expected tool_call action");
		}
	});
});

describe("Claude Code parseHookInput — SessionStart", () => {
	const event = adapter.parseHookInput({ session_id: "s-3", cwd: "/repo" }, "SessionStart");
	it("produces a session_lifecycle action", () => {
		expect(event.action.kind).toBe("session_lifecycle");
	});
	it("sets phase to session-start", () => {
		expect(event.phase).toBe("session-start");
	});
});

describe("Claude Code classifyToolClass", () => {
	it("Edit → modify", () => {
		expect(adapter.classifyToolClass("Edit", {})).toBe("modify");
	});
	it("Bash routes to command classifier", () => {
		expect(adapter.classifyToolClass("Bash", { command: "git status" })).toBe("read");
	});
});

describe("Claude Code renderSettingsFragment", () => {
	const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
	it("writes to the project settings path", () => {
		expect(frag.path).toBe(".claude/settings.json");
	});
	it("uses array-append for hook merge", () => {
		expect(frag.mergeStrategy).toBe("array-append");
	});
	it("includes PostToolUse with a scoped matcher", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
		};
		expect(fragment.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit");
		expect(fragment.hooks.PostToolUse[0].hooks[0].command).toContain("--runner 'claude-code'");
		expect(fragment.hooks.PostToolUse[0].hooks[0].command).toContain("--event 'PostToolUse'");
		expect(fragment.hooks.PostToolUse[0].hooks[0].command).toContain("if test -f");
		expect(fragment.hooks.PostToolUse[0].hooks[0].command).not.toContain("|| true");
	});
});

describe("Claude Code encodeDecision", () => {
	const baseEvent = adapter.parseHookInput(
		{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
		"PreToolUse",
	);
	it("allow — exit 0 with no stdout by default", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, baseEvent);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeUndefined();
	});
	it("allow with additional_context — emits hookSpecificOutput", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi" },
			baseEvent,
		);
		expect(out.stdout).toBeDefined();
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { additionalContext: "fyi" },
		});
	});
	it("block — emits decision: deny", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, baseEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({ decision: "deny", reason: "no" });
	});
	it("ask — emits decision: ask", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, baseEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({ decision: "ask", reason: "confirm?" });
	});
	it("routes warnings to stderr", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1", "w2"] },
			baseEvent,
		);
		expect(out.stderr).toBe("w1\nw2");
	});
});
