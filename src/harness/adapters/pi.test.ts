import { describe, expect, it } from "vitest";
import { renderPiBridgeSource, createPiAdapter } from "./pi.js";
import { PROVIDER_BRIDGE_MARKER } from "./provider-bridge-source.js";

const adapter = createPiAdapter();

describe("Pi adapter", () => {
	it("exposes tool, direct-shell, prompt, compaction, and lifecycle events", () => {
		expect(adapter.id).toBe("pi");
		expect(adapter.nativeEventNames).toContain("tool_call");
		expect(adapter.nativeEventNames).toContain("tool_result");
		expect(adapter.nativeEventNames).toContain("user_bash");
		expect(adapter.nativeEventNames).toContain("input");
		expect(adapter.nativeEventNames).toContain("session_before_compact");
		expect(adapter.nativeEventNames).toContain("agent_settled");
	});

	it("detects explicit Pi process markers only", () => {
		expect(adapter.detectFromEnv({ PI_CODING_AGENT: "1" })).toBe(true);
		expect(adapter.detectFromEnv({ INTERLINKED_CLIENT: "pi" })).toBe(true);
		expect(adapter.detectFromEnv({})).toBe(false);
	});

	it("normalizes Pi tool_call and tool_result payloads", () => {
		const pre = adapter.parseHookInput(
			{
				sessionId: "pi-1",
				toolCallId: "call-1",
				cwd: "/repo",
				toolName: "bash",
				input: { command: "git status" },
			},
			"tool_call",
		);
		expect(pre).toMatchObject({
			runner: "pi",
			session_id: "pi-1",
			tool_use_id: "call-1",
			phase: "pre-tool",
		});
		expect(pre.action).toMatchObject({
			kind: "tool_call",
			tool_name: "bash",
			tool_class: "read",
		});

		const post = adapter.parseHookInput(
			{
				session_id: "pi-1",
				tool_use_id: "call-1",
				tool_name: "write",
				tool_input: { path: "a.ts" },
				tool_response: [{ type: "text", text: "done" }],
			},
			"tool_result",
		);
		expect(post.phase).toBe("post-tool");
		expect(post.action).toMatchObject({ kind: "tool_call", tool_class: "modify" });
	});

	it("normalizes direct ! shell execution as a pre-tool call", () => {
		const event = adapter.parseHookInput(
			{
				session_id: "pi",
				cwd: "/repo",
				tool_name: "Bash",
				tool_input: { command: "rm output.txt" },
			},
			"user_bash",
		);
		expect(event.phase).toBe("pre-tool");
		expect(event.action).toMatchObject({ kind: "tool_call", tool_class: "modify" });
	});
});

describe("Pi managed extension", () => {
	it("routes every installed capability through a generated callback", () => {
		expect(adapter.nativeEventNames).toEqual([
			"session_start",
			"session_shutdown",
			"input",
			"tool_call",
			"tool_result",
			"user_bash",
			"before_agent_start",
			"agent_start",
			"agent_end",
			"agent_settled",
			"session_before_compact",
			"session_compact",
			"session_compact_failed",
		]);
		const source = renderPiBridgeSource("/bin/hook");
		for (const eventName of adapter.nativeEventNames) {
			expect(source, eventName).toContain(`"${eventName}"`);
		}
	});

	it("uses provider-native project and user locations", () => {
		expect(adapter.renderSettingsFragment("/bin/hook", "project").path).toBe(
			".pi/extensions/interlinked.js",
		);
		expect(adapter.renderSettingsFragment("/bin/hook", "local").path).toBe(
			".pi/extensions/interlinked.js",
		);
		expect(adapter.renderSettingsFragment("/bin/hook", "user").path).toBe(
			"~/.pi/agent/extensions/interlinked.js",
		);
	});

	it("renders a self-contained bounded extension with headless fail-closed ask", () => {
		const binaryPath = "/tmp/pi hook/hook-entry.mjs";
		const fragment = adapter.renderSettingsFragment(binaryPath, "project");
		expect(fragment.fileContent).toBe(renderPiBridgeSource(binaryPath));
		expect(fragment.fileContent?.startsWith(PROVIDER_BRIDGE_MARKER)).toBe(true);
		expect(fragment.fileContent).toContain(JSON.stringify(binaryPath));
		expect(fragment.fileContent).toContain('pi.on("tool_call"');
		expect(fragment.fileContent).toContain('pi.on("user_bash"');
		expect(fragment.fileContent).toContain('ctx.ui.confirm("Interlinked approval required"');
		expect(fragment.fileContent).toContain('if (!ctx.hasUI) return false');
		expect(fragment.fileContent).toContain('hook_event_name: interlinkedLegacyHookEvent(eventName)');
		expect(fragment.fileContent).toContain(
			'import { createLocalBashOperations } from "@earendil-works/pi-coding-agent"',
		);
		expect(fragment.fileContent).toContain("local.exec(rewrittenCommand, cwd, options)");
		expect(fragment.fileContent).not.toContain("event.command = decision.updated_input.command");
	});

	it("carries rewrites and warnings through the provider-neutral bridge envelope", () => {
		const event = adapter.parseHookInput(
			{ session_id: "pi", tool_name: "bash", tool_input: { command: "rm x" } },
			"tool_call",
		);
		const output = adapter.encodeDecision(
			{
				decision: "allow",
				warnings: ["rewritten safely"],
				updated_input: { command: "trash x" },
			},
			event,
		);
		expect(output.exit_code).toBe(0);
		expect(output.stderr).toBe("rewritten safely");
		expect(JSON.parse(output.stdout ?? "{}")).toEqual({
			decision: "allow",
			warnings: ["rewritten safely"],
			updated_input: { command: "trash x" },
		});
	});
});
