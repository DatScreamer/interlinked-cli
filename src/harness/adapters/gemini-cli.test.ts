import { describe, expect, it } from "vitest";
import { createGeminiCliAdapter } from "./gemini-cli.js";

const adapter = createGeminiCliAdapter();

describe("Gemini CLI adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("gemini-cli");
	});
	it("is marked experimental", () => {
		expect(adapter.experimental).toBe(true);
	});
	it("lists native event names", () => {
		expect(adapter.nativeEventNames).toContain("BeforeTool");
		expect(adapter.nativeEventNames).toContain("PreCompress");
	});
});

describe("Gemini CLI detectFromEnv", () => {
	it("detects GEMINI_API_KEY env", () => {
		expect(adapter.detectFromEnv({ GEMINI_API_KEY: "x" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Gemini CLI parseHookInput — BeforeTool", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "gem-1",
			cwd: "/repo",
			tool_name: "edit_file",
			tool_input: { path: "/repo/a.ts" },
		},
		"BeforeTool",
	);
	it("has phase pre-tool", () => {
		expect(event.phase).toBe("pre-tool");
	});
	it("classifies as modify", () => {
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("modify");
	});
});

describe("Gemini CLI parseHookInput — PreCompress", () => {
	const event = adapter.parseHookInput({ session_id: "x" }, "PreCompress");
	it("maps to pre-compact phase", () => {
		expect(event.phase).toBe("pre-compact");
	});
});

describe("Gemini CLI encodeDecision", () => {
	const event = adapter.parseHookInput(
		{ session_id: "g", tool_name: "read_file", tool_input: {} },
		"BeforeTool",
	);
	it("allow emits allow:true on stdout", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(JSON.parse(out.stdout as string)).toEqual({ allow: true });
	});
	it("block emits allow:false with exit 2", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "bad" }, event);
		expect(out.exit_code).toBe(2);
		expect(JSON.parse(out.stdout as string)).toEqual({ allow: false, reason: "bad" });
	});
});
