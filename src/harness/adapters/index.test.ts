import { describe, expect, it } from "vitest";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import { buildAllAdapters, detectAdapter, getAdapter } from "./index.js";
import { nonNull } from "../../lib/non-null.js";

describe("buildAllAdapters", () => {
	const adapters = buildAllAdapters();
	it("returns all five runner adapters", () => {
		expect(adapters.length).toBe(5);
		const ids = adapters.map((a) => a.id).sort();
		expect(ids).toEqual(["claude-code", "codex", "copilot-cli", "cursor", "gemini-cli"]);
	});
	it("every adapter conforms to the basic interface", () => {
		for (const a of adapters) {
			expect(typeof a.parseHookInput).toBe("function");
			expect(typeof a.classifyToolClass).toBe("function");
			expect(typeof a.renderSettingsFragment).toBe("function");
			expect(typeof a.encodeDecision).toBe("function");
			expect(typeof a.detectFromEnv).toBe("function");
			expect(a.nativeEventNames.length).toBeGreaterThan(0);
		}
	});
});

describe("detectAdapter", () => {
	it("returns null for a plain env", () => {
		expect(detectAdapter({})).toBeNull();
	});
	it("prefers claude-code when CLAUDE_CODE env is set", () => {
		const a = detectAdapter({ CLAUDE_CODE: "1" });
		expect(a?.id).toBe("claude-code");
	});
	it("detects cursor via CURSOR_SESSION_ID", () => {
		const a = detectAdapter({ CURSOR_SESSION_ID: "c-1" });
		expect(a?.id).toBe("cursor");
	});
	it("detects copilot-cli via GH_COPILOT_CLI", () => {
		const a = detectAdapter({ GH_COPILOT_CLI: "1" });
		expect(a?.id).toBe("copilot-cli");
	});
	it("detects gemini-cli via GEMINI_API_KEY", () => {
		const a = detectAdapter({ GEMINI_API_KEY: "k" });
		expect(a?.id).toBe("gemini-cli");
	});
	it("detects codex via CODEX_CLI", () => {
		const a = detectAdapter({ CODEX_CLI: "1" });
		expect(a?.id).toBe("codex");
	});
});

describe("getAdapter", () => {
	it("returns the adapter with a matching id", () => {
		expect(getAdapter("claude-code")?.id).toBe("claude-code");
		expect(getAdapter("copilot-cli")?.id).toBe("copilot-cli");
		expect(getAdapter("cursor")?.id).toBe("cursor");
	});
	it("returns null for unknown ids", () => {
		expect(getAdapter("unknown")).toBeNull();
	});
});

describe("cross-runner equivalence — semantically identical Edit events", () => {
	// Same file edit coming from different runners should produce the same
	// tool_class. We do not assert identical HarnessDecision here since the
	// evaluator layer is not yet wired; this test checks the envelope is
	// consistent enough to be evaluated by the same check set.
	const runners: Array<[string, UnifiedHookEvent]> = [
		[
			"claude",
			nonNull(buildAllAdapters()[0]).parseHookInput(
				{
					session_id: "s",
					cwd: "/r",
					tool_name: "Edit",
					tool_input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" },
				},
				"PreToolUse",
			),
		],
		[
			"copilot",
			nonNull(buildAllAdapters()[1]).parseHookInput(
				{
					sessionId: "s",
					cwd: "/r",
					toolName: "edit_file",
					toolInput: { path: "/r/a.ts" },
				},
				"preToolUse",
			),
		],
	];
	for (const [name, event] of runners) {
		it(`${name} Edit → modify tool_class`, () => {
			if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
			expect(event.action.tool_class).toBe("modify");
		});
	}
});

describe("encodeDecision maps the same allow across adapters", () => {
	const adapters = buildAllAdapters();
	const decision: HarnessDecision = { decision: "allow" };
	for (const a of adapters) {
		it(`${a.id} allow → exit 0`, () => {
			const event = a.parseHookInput(
				{ session_id: "s", tool_name: "Read", cwd: "/r" },
				nonNull(a.nativeEventNames[0]),
			);
			const out = a.encodeDecision(decision, event);
			expect(out.exit_code).toBe(0);
		});
	}
});
