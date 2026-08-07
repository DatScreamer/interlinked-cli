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

	it("registers SessionEnd as a detached fire-and-forget command", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		const sessionEnd = nonNull(nonNull(fragment.hooks.SessionEnd)[0]);
		const command = nonNull(sessionEnd.hooks[0]).command;
		// Backgrounded subshell + discarded output: `claude update` fires
		// SessionEnd and exits immediately, cancelling any foreground hook that
		// is still booting ("Hook cancelled"). Detached, the shell returns in
		// milliseconds and there is nothing left to cancel.
		expect(command).toContain("( node");
		expect(command).toContain(">/dev/null 2>&1 & )");
		expect(command).toContain("--event 'SessionEnd'");
	});

	it("keeps every other event foreground (their output is consumed)", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		for (const [eventName, entries] of Object.entries(fragment.hooks)) {
			if (eventName === "SessionEnd") continue;
			expect(nonNull(nonNull(entries[0]).hooks[0]).command).not.toContain("& )");
		}
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

	// This previously asserted stderr-only, on the belief that the runtime echoes
	// PostToolUse stderr to the model. It does not: Claude Code feeds hook stderr
	// to the model on exit code 2 (a block), NOT on exit 0. Measured directly —
	// a PostToolUse warning the daemon composed and logged to activity.jsonl never
	// reached the agent, which is why advisory findings only ever appeared
	// alongside some OTHER blocking error. Every non-blocking PostToolUse finding
	// the harness produced was invisible.
	it("PostToolUse: routes warnings into additionalContext so the agent sees them", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1"] },
			postEvent,
		);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "w1" },
		});
		expect(out.stderr).toBe("w1");
	});

	it("PostToolUse with no warnings: still no stdout", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		expect(adapter.encodeDecision({ decision: "allow" }, postEvent).stdout).toBeUndefined();
	});

	it("PreToolUse with no warnings + no additional_context: no stdout", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, baseEvent);
		expect(out.stdout).toBeUndefined();
	});

	it("block with no reason falls back to the generic harness-bug message", () => {
		const out = adapter.encodeDecision({ decision: "block" }, baseEvent);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: { permissionDecisionReason: string };
		};
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(
			"Blocked by the interlinked harness, but no reason was attached — likely a harness " +
				"bug; re-run, or run `interlinked harness restart`, then report it.",
		);
	});

	it("ask reason includes resolved_targets via formatAskReasonWithTargets", () => {
		const out = adapter.encodeDecision(
			{
				decision: "ask",
				reason: "Confirm push?",
				resolved_targets: [{ kind: "branch", value: "origin/main" }],
			},
			baseEvent,
		);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: { permissionDecisionReason: string };
		};
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Confirm push?");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("origin/main");
	});

	it("falls back to hookEventName by phase when no event is supplied (PostToolUse default)", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, undefined as never);
		expect(JSON.parse(out.stdout as string)).toEqual({ decision: "block", reason: "no" });
	});

	it("falls back to hookEventName 'PreToolUse' when event.phase is pre-tool but native event name is absent", () => {
		const fakeEvent = { ...baseEvent, runner_native_event: undefined };
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, fakeEvent as never);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});
	});
});

describe("Claude Code detectFromEnv — remaining env var branches", () => {
	it("detects CLAUDE_WORKING_DIR", () => {
		expect(adapter.detectFromEnv({ CLAUDE_WORKING_DIR: "/repo" })).toBe(true);
	});
	it("detects CLAUDECODE", () => {
		expect(adapter.detectFromEnv({ CLAUDECODE: "1" })).toBe(true);
	});
	it("detects CLAUDE_CODE_VERSION", () => {
		expect(adapter.detectFromEnv({ CLAUDE_CODE_VERSION: "1.0.0" })).toBe(true);
	});
});

describe("Claude Code parseHookInput — agent_name context", () => {
	it("sets context.agent when agent_name is present", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", agent_name: "reviewer" },
			"SessionStart",
		);
		expect(event.context.agent).toEqual({ id: "reviewer" });
	});
	it("leaves context.agent undefined when agent_name is absent", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionStart");
		expect(event.context.agent).toBeUndefined();
	});
});

describe("Claude Code classifyToolClass with overrides", () => {
	it("uses a supplied tool_name_classes override", () => {
		const overriddenAdapter = createClaudeCodeAdapter({
			overrides: {
				tool_name_classes: { CustomTool: "side-effect" },
				command_substrings: [],
			},
		});
		expect(overriddenAdapter.classifyToolClass("CustomTool", {})).toBe("side-effect");
	});
});

describe("Claude Code parseHookInput — UserPromptSubmit action", () => {
	it("uses raw.prompt as the text when present", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", prompt: "hello there" },
			"UserPromptSubmit",
		);
		expect(event.action).toEqual({ kind: "user_prompt", text: "hello there" });
	});
	it("falls back to raw.message when prompt is absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", message: "fallback text" },
			"UserPromptSubmit",
		);
		expect(event.action).toEqual({ kind: "user_prompt", text: "fallback text" });
	});
	it("falls back to an empty string when neither prompt nor message is present", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "UserPromptSubmit");
		expect(event.action).toEqual({ kind: "user_prompt", text: "" });
	});
});

describe("Claude Code parseHookInput — SessionEnd and PostToolUseFailure", () => {
	it("produces a session_lifecycle 'end' action for SessionEnd", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionEnd");
		expect(event.action).toEqual({ kind: "session_lifecycle", event: "end" });
	});
	it("routes PostToolUseFailure through buildToolCallAction as a post action", () => {
		const event = adapter.parseHookInput(
			{
				session_id: "s",
				cwd: "/repo",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_error: "boom",
			},
			"PostToolUseFailure",
		);
		expect(event.action.kind).toBe("tool_call");
		if (event.action.kind === "tool_call") {
			expect(event.action.tool_error).toBe("boom");
		}
	});
});

describe("Claude Code parseHookInput — non-object native payload falls back to {}", () => {
	it("treats a null payload as an empty object", () => {
		const event = adapter.parseHookInput(null, "SessionStart");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
	});
	it("treats an array payload as an empty object (not a plain object)", () => {
		const event = adapter.parseHookInput(["not", "an", "object"], "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("Claude Code parseHookInput — unmapped native event uses phase 'other'", () => {
	it("falls back to phase 'other' for an event not in PHASE_MAP", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "TeammateIdle");
		expect(event.phase).toBe("other");
	});
});

describe("Claude Code parseHookInput — session_id and cwd fallbacks", () => {
	it("defaults session_id to 'unknown' when absent", () => {
		const event = adapter.parseHookInput({ cwd: "/repo" }, "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
	it("defaults cwd to process.cwd() when absent", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "SessionStart");
		expect(event.context.cwd).toBe(process.cwd());
	});
});

describe("Claude Code renderSettingsFragment — user scope", () => {
	it("writes to the user settings path", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "user");
		expect(frag.path).toBe("~/.claude/settings.json");
	});
});

describe("Claude Code encodeDecision — ask with no reason falls back to 'Confirmation required'", () => {
	it("uses the default confirmation reason when decision.reason is absent", () => {
		const preEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
			"PreToolUse",
		);
		const out = adapter.encodeDecision({ decision: "ask" }, preEvent);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: { permissionDecisionReason: string };
		};
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("Confirmation required");
	});
});

describe("Claude Code parseHookInput — buildToolCallAction fallbacks", () => {
	it("defaults tool_name to 'unknown' when absent", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "PreToolUse");
		expect(event.action).toMatchObject({ kind: "tool_call", tool_name: "unknown" });
	});
	it("defaults tool_input to {} when absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read" },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
	it("applies classifier overrides through parseHookInput (PreToolUse)", () => {
		const overriddenAdapter = createClaudeCodeAdapter({
			overrides: {
				tool_name_classes: { CustomTool: "side-effect" },
				command_substrings: [],
			},
		});
		const event = overriddenAdapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "CustomTool", tool_input: {} },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_class: "side-effect" });
	});
});

describe("Claude Code parseHookInput — unrecognized native event falls through to 'other'", () => {
	it("produces an 'other' action carrying the raw payload", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", foo: "bar" },
			"Notification",
		);
		expect(event.action).toEqual({
			kind: "other",
			subkind: "Notification",
			data: { session_id: "s", cwd: "/repo", foo: "bar" },
		});
	});
});
