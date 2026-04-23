import { describe, expect, it } from "vitest";
import { createCopilotCliAdapter } from "./copilot-cli.js";

const adapter = createCopilotCliAdapter();

describe("Copilot CLI adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("copilot-cli");
	});
	it("lists camelCase native events", () => {
		expect(adapter.nativeEventNames).toContain("preToolUse");
		expect(adapter.nativeEventNames).toContain("sessionStart");
	});
});

describe("Copilot CLI detectFromEnv", () => {
	it("detects GH_COPILOT_CLI env", () => {
		expect(adapter.detectFromEnv({ GH_COPILOT_CLI: "1" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Copilot CLI parseHookInput — preToolUse", () => {
	const event = adapter.parseHookInput(
		{
			sessionId: "cs-1",
			cwd: "/repo",
			toolName: "edit_file",
			toolInput: { path: "/repo/a.ts" },
		},
		"preToolUse",
	);
	it("has phase pre-tool", () => {
		expect(event.phase).toBe("pre-tool");
	});
	it("maps edit_file to modify", () => {
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("modify");
	});
	it("preserves sessionId", () => {
		expect(event.session_id).toBe("cs-1");
	});
});

describe("Copilot CLI parseHookInput — shell via command classifier", () => {
	const event = adapter.parseHookInput(
		{ sessionId: "cs-2", toolName: "shell", toolInput: { command: "git push" } },
		"preToolUse",
	);
	it("classifies shell git push as side-effect", () => {
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("side-effect");
	});
});

describe("Copilot CLI renderSettingsFragment", () => {
	const frag = adapter.renderSettingsFragment("/bin/hook", "project");
	it("writes to .github/hooks/hooks.json", () => {
		expect(frag.path).toBe(".github/hooks/hooks.json");
	});
	it("includes version: 1", () => {
		const f = frag.fragment as { version: number };
		expect(f.version).toBe(1);
	});
	it("passes runner and event to the shared hook entry", () => {
		const f = frag.fragment as {
			hooks: Record<string, Array<{ bash: string }>>;
		};
		expect(f.hooks.preToolUse[0].bash).toContain("--runner 'copilot-cli'");
		expect(f.hooks.preToolUse[0].bash).toContain("--event 'preToolUse'");
		expect(f.hooks.preToolUse[0].bash).toContain("if test -f");
		expect(f.hooks.preToolUse[0].bash).not.toContain("|| true");
	});
});

describe("Copilot CLI encodeDecision", () => {
	const event = adapter.parseHookInput(
		{ sessionId: "x", toolName: "shell", toolInput: { command: "ls" } },
		"preToolUse",
	);
	it("allow exits 0", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.exit_code).toBe(0);
	});
	it("block exits 2 and emits reason on stderr", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "nope" }, event);
		expect(out.exit_code).toBe(2);
		expect(out.stderr).toContain("nope");
	});
	it("ask degrades to allow with stderr note", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toContain("confirm?");
	});
});
