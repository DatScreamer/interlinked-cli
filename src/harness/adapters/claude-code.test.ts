import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
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
	it("includes PostToolUse with an empty matcher (match all tools)", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
		};
		const post = nonNull(nonNull(fragment.hooks.PostToolUse)[0]);
		expect(post.matcher).toBe("");
		expect(nonNull(post.hooks[0]).command).toContain("--runner 'claude-code'");
		expect(nonNull(post.hooks[0]).command).toContain("--event 'PostToolUse'");
		expect(nonNull(post.hooks[0]).command).toContain("if test -f");
		expect(nonNull(post.hooks[0]).command).not.toContain("|| true");
	});

	it("uses empty matcher for PreToolUse as well", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string }>>;
		};
		expect(nonNull(nonNull(fragment.hooks.PreToolUse)[0]).matcher).toBe("");
	});

	it("uses empty matcher for all events", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string }>>;
		};
		for (const eventName of Object.keys(fragment.hooks)) {
			expect(nonNull(nonNull(fragment.hooks[eventName])[0]).matcher).toBe("");
		}
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
	it("allow with additional_context — emits hookSpecificOutput with hookEventName", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi" },
			baseEvent,
		);
		expect(out.stdout).toBeDefined();
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "fyi" },
		});
	});
	it("PreToolUse block — emits permissionDecision: deny in hookSpecificOutput (NOT root decision:deny)", () => {
		// Root {decision:"deny"} is invalid for PreToolUse ("(root): Invalid
		// input") and silently fails to block — deny must live in
		// hookSpecificOutput.permissionDecision.
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, baseEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});
	});
	it("PostToolUse block — emits root decision: block (valid for PostToolUse)", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
			"PostToolUse",
		);
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, postEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({ decision: "block", reason: "no" });
	});
	it("PreToolUse ask — emits permissionDecision: ask in hookSpecificOutput", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, baseEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: "confirm?",
			},
		});
	});
	it("routes warnings to stderr", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1", "w2"] },
			baseEvent,
		);
		expect(out.stderr).toBe("w1\nw2");
	});

	// PreToolUse stderr is dropped from the model's view by Claude Code's
	// runtime (only PostToolUse stderr surfaces as additional context). Without
	// this fan-out, every PreToolUse advisory the harness emits — including
	// supermodel-graph blast-radius warnings — is invisible to the agent.
	it("PreToolUse: also routes warnings into hookSpecificOutput.additionalContext", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1", "w2"] },
			baseEvent,
		);
		expect(out.stdout).toBeDefined();
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "w1\nw2" },
		});
		expect(out.stderr).toBe("w1\nw2");
	});

	it("PreToolUse: combines explicit additional_context with warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi", warnings: ["w1"] },
			baseEvent,
		);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "fyi\nw1" },
		});
	});

	it("PostToolUse: warnings stay stderr-only — runtime already echoes them", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1"] },
			postEvent,
		);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toBe("w1");
	});

	it("PreToolUse with no warnings + no additional_context: no stdout", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, baseEvent);
		expect(out.stdout).toBeUndefined();
	});
});
