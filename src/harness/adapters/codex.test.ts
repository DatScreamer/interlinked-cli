import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { createCodexAdapter } from "./codex.js";

const adapter = createCodexAdapter();
const overriddenAdapter = createCodexAdapter({
	overrides: {
		tool_name_classes: { CustomTool: "side-effect" },
		command_substrings: [],
	},
});

describe("Codex adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("codex");
	});
	it("is no longer marked experimental", () => {
		// Codex shipped its hook contract in 2026-04 with PascalCase event
		// names that mirror Claude Code's vocabulary, so the adapter is
		// no longer experimental.
		expect(adapter.experimental).toBe(false);
	});
	it("lists native event names in PascalCase", () => {
		expect(adapter.nativeEventNames).toContain("PreToolUse");
		expect(adapter.nativeEventNames).toContain("PostToolUse");
		expect(adapter.nativeEventNames).toContain("PermissionRequest");
		expect(adapter.nativeEventNames).toContain("Stop");
	});
});

describe("Codex detectFromEnv", () => {
	it("detects CODEX_CLI env", () => {
		expect(adapter.detectFromEnv({ CODEX_CLI: "1" })).toBe(true);
	});
	it("detects INTERLINKED_CLIENT=codex", () => {
		expect(adapter.detectFromEnv({ INTERLINKED_CLIENT: "codex" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Codex parseHookInput — PreToolUse", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "cx-1",
			cwd: "/repo",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			turn_id: "turn-7",
		},
		"PreToolUse",
	);
	it("produces a tool_call action with the canonical tool name", () => {
		expect(event.action).toMatchObject({ kind: "tool_call", tool_name: "Bash" });
	});
	it("propagates Codex turn_id as parent_event_id", () => {
		expect(event.parent_event_id).toBe("turn-7");
	});
	it("uses the canonical pre-tool phase", () => {
		expect(event.phase).toBe("pre-tool");
	});
});

describe("Codex parseHookInput — PostToolUse", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "cx-1b",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			tool_response: "file1\nfile2",
		},
		"PostToolUse",
	);
	it("preserves the tool_response on the action", () => {
		expect(event.action).toMatchObject({
			kind: "tool_call",
			tool_name: "Bash",
			tool_response: "file1\nfile2",
		});
	});
	it("uses the canonical post-tool phase", () => {
		expect(event.phase).toBe("post-tool");
	});
});

describe("Codex parseHookInput — UserPromptSubmit", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cx-2", prompt: "make me a coffee" },
		"UserPromptSubmit",
	);
	it("produces a user_prompt action carrying the prompt text", () => {
		expect(event.action).toMatchObject({ kind: "user_prompt", text: "make me a coffee" });
	});
	it("uses the canonical user-prompt phase", () => {
		expect(event.phase).toBe("user-prompt");
	});
});

describe("Codex parseHookInput — SessionStart", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cx-3", source: "startup" },
		"SessionStart",
	);
	it("produces a session_lifecycle action with event=start", () => {
		expect(event.action).toMatchObject({ kind: "session_lifecycle", event: "start" });
	});
});

describe("Codex parseHookInput — Stop", () => {
	const event = adapter.parseHookInput({ session_id: "cx-4" }, "Stop");
	it("produces a session_lifecycle action with event=end", () => {
		expect(event.action).toMatchObject({ kind: "session_lifecycle", event: "end" });
	});
});

describe("Codex encodeDecision — PreToolUse path", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
		"PreToolUse",
	);
	it("allow exits 0 with no stdout", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeUndefined();
	});
	it("block emits legacy {decision:'block'} JSON on stdout", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeDefined();
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({ decision: "block", reason: "no" });
	});
	it("ask collapses to block on PreToolUse (no ask primitive)", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({ decision: "block", reason: "confirm?" });
	});
});

describe("Codex encodeDecision — PermissionRequest path", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: { command: "ls /etc" } },
		"PermissionRequest",
	);
	it("allow uses hookSpecificOutput.decision.behavior=allow", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "allow" },
			},
		});
	});
	it("block uses hookSpecificOutput.decision.behavior=deny + message", () => {
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "Blocked by repo policy" },
			event,
		);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "Blocked by repo policy" },
			},
		});
	});
});

describe("Codex renderSettingsFragment", () => {
	it("writes .codex/hooks.json at project scope", () => {
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		expect(fragment.path).toBe(".codex/hooks.json");
	});
	it("writes ~/.codex/hooks.json at user scope", () => {
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "user");
		expect(fragment.path).toBe("~/.codex/hooks.json");
	});
	it("includes Claude-shaped {matcher, hooks:[{type, command}]} entries", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = fragment.fragment as { hooks: Record<string, unknown[]> };
		const entries = root.hooks.PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string }>;
		}>;
		expect(nonNull(nonNull(entries[0]).hooks[0]).type).toBe("command");
		expect(nonNull(nonNull(entries[0]).hooks[0]).command).toContain("/bin/hook");
	});
	it("uses empty PostToolUse matcher (match all tools)", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = fragment.fragment as { hooks: Record<string, unknown[]> };
		const entries = root.hooks.PostToolUse as Array<{ matcher: string }>;
		expect(nonNull(entries[0]).matcher).toBe("");
	});

	it("uses empty matcher for all events", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = fragment.fragment as { hooks: Record<string, unknown[]> };
		for (const eventName of Object.keys(root.hooks)) {
			const entries = root.hooks[eventName] as Array<{ matcher: string }>;
			expect(nonNull(entries[0]).matcher).toBe("");
		}
	});
});

describe("Codex classifyToolClass", () => {
	it("routes Bash through the command classifier", () => {
		expect(adapter.classifyToolClass("Bash", { command: "git status" })).toBe("read");
	});
	it("uses a supplied tool_name_classes override", () => {
		expect(overriddenAdapter.classifyToolClass("CustomTool", {})).toBe("side-effect");
	});
});

describe("Codex parseHookInput — non-object native payload falls back to {}", () => {
	it("treats a null payload as an empty object (session_id -> 'unknown')", () => {
		const event = adapter.parseHookInput(null, "SessionStart");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
	});
	it("treats a string payload as an empty object", () => {
		const event = adapter.parseHookInput("not-an-object", "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("Codex parseHookInput — unmapped native event falls back to phase 'other'", () => {
	it("uses phase 'other' for an event name not in PHASE_MAP", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "TeammateIdle");
		expect(event.phase).toBe("other");
	});
});

describe("Codex parseHookInput — missing session_id falls back to 'unknown'", () => {
	it("defaults session_id when absent from the payload", () => {
		const event = adapter.parseHookInput({ cwd: "/repo" }, "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("Codex parseHookInput — UserPromptSubmit missing prompt falls back to ''", () => {
	it("defaults text to an empty string when raw.prompt is absent", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "UserPromptSubmit");
		expect(event.action).toMatchObject({ kind: "user_prompt", text: "" });
	});
});

describe("Codex parseHookInput — unrecognized event name falls through to 'other' action", () => {
	it("produces an 'other' action carrying the raw payload", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", foo: "bar" },
			"TeammateIdle",
		);
		expect(event.action).toEqual({
			kind: "other",
			subkind: "TeammateIdle",
			data: { session_id: "s", foo: "bar" },
		});
	});
});

describe("Codex parseHookInput — tool_input edge cases (readToolInput)", () => {
	it("defaults tool_input to {} when absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", tool_name: "Bash" },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
	it("defaults tool_input to {} when it is an array (not a plain object)", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", tool_name: "Bash", tool_input: ["not", "an", "object"] },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
	it("defaults tool_input to {} when it is a primitive", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", tool_name: "Bash", tool_input: "oops" },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
});

describe("Codex parseHookInput — classifier overrides propagate through tool_call actions", () => {
	it("applies a tool_name_classes override on PreToolUse", () => {
		const event = overriddenAdapter.parseHookInput(
			{ session_id: "s", tool_name: "CustomTool", tool_input: {} },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_class: "side-effect" });
	});
});

describe("Codex encodeDecision — block with no reason falls back to the generic message", () => {
	it("uses the generic harness-bug message when reason is absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Bash", tool_input: {} },
			"PreToolUse",
		);
		const out = adapter.encodeDecision({ decision: "block" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed.reason).toBe(
			"Blocked by the interlinked harness, but no reason was attached — likely a harness bug; " +
				"re-run, or run `interlinked harness restart`, then report it.",
		);
	});
});

describe("Codex postInstall", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "interlinked-codex-postinstall-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("dry-run: logs to stderr and does not write config.toml", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(adapter.postInstall).toBeDefined();
			adapter.postInstall?.({ cwd: workdir, scope: "project", dryRun: true });
			expect(spy).toHaveBeenCalledWith(
				expect.stringContaining(
					`[interlinked] codex postInstall (dry-run): would ensure ${workdir}/.codex/config.toml has [features] hooks = true`,
				),
			);
			expect(existsSync(join(workdir, ".codex", "config.toml"))).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("non-dry-run: writes the [features] hooks = true flag to config.toml", () => {
		adapter.postInstall?.({ cwd: workdir, scope: "project", dryRun: false });
		const configPath = join(workdir, ".codex", "config.toml");
		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("hooks = true");
	});
});

describe("Codex encodeDecision — allow with additional_context (non-PermissionRequest)", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: {} },
		"PreToolUse",
	);
	it("uses additional_context alone as stderr when there are no warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi only" },
			event,
		);
		expect(out.stderr).toBe("fyi only");
	});
	it("joins warnings and additional_context with a newline when both are present", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1"], additional_context: "fyi" },
			event,
		);
		expect(out.stderr).toBe("w1\nfyi");
	});
});
