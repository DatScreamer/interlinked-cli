import { describe, expect, it } from "vitest";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
	formatBloatWarning,
	formatSilentFailureWarning,
	TOOL_RESULT_CHECK_DEFAULTS,
} from "../tool-result-checks.js";

// ===========================================
// Silent-failure lint
// ===========================================

describe("checkSilentFailure", () => {
	it("flags { success: false }", () => {
		const hit = checkSilentFailure({ success: false, reason: "timeout" });
		expect(hit?.pattern).toBe("success: false");
	});

	it("flags { ok: false }", () => {
		const hit = checkSilentFailure({ ok: false });
		expect(hit?.pattern).toBe("ok: false");
	});

	it("flags non-empty string error field", () => {
		const hit = checkSilentFailure({ error: "something broke" });
		expect(hit?.pattern).toBe("error: <string>");
		expect(hit?.detail).toBe("something broke");
	});

	it("flags non-empty object error field", () => {
		const hit = checkSilentFailure({ error: { code: "NOT_FOUND", msg: "..." } });
		expect(hit?.pattern).toBe("error: <object>");
	});

	it("flags error_code field", () => {
		const hit = checkSilentFailure({ error_code: "ERR_AUTH" });
		expect(hit?.pattern).toBe("error_code");
	});

	it("flags non-empty errors array", () => {
		const hit = checkSilentFailure({ errors: [{ field: "email", msg: "bad" }] });
		expect(hit?.pattern).toBe("errors: [...]");
	});

	it("does NOT flag error: null", () => {
		expect(checkSilentFailure({ error: null, data: "ok" })).toBeNull();
	});

	it("does NOT flag error: ''", () => {
		expect(checkSilentFailure({ error: "" })).toBeNull();
	});

	it("does NOT flag errors: []", () => {
		expect(checkSilentFailure({ errors: [] })).toBeNull();
	});

	it("does NOT flag empty error: {}", () => {
		expect(checkSilentFailure({ error: {} })).toBeNull();
	});

	it("does NOT flag plain success response", () => {
		expect(checkSilentFailure({ data: [1, 2, 3], count: 3 })).toBeNull();
	});

	it("handles MCP content-block wrapped responses", () => {
		const mcpResponse = {
			content: [{ type: "text", text: JSON.stringify({ success: false, error: "oops" }) }],
		};
		const hit = checkSilentFailure(mcpResponse);
		expect(hit).not.toBeNull();
	});

	it("parses JSON strings (e.g., Bash stdout)", () => {
		const hit = checkSilentFailure('{"success": false, "error": "timeout"}');
		expect(hit?.pattern).toBe("success: false");
	});

	it("ignores plaintext strings that mention 'error'", () => {
		expect(checkSilentFailure("This is a log line mentioning an error.")).toBeNull();
	});

	it("handles null / undefined safely", () => {
		expect(checkSilentFailure(null)).toBeNull();
		expect(checkSilentFailure(undefined)).toBeNull();
	});

	it("handles arrays without crashing", () => {
		expect(checkSilentFailure([1, 2, 3])).toBeNull();
	});
});

// ===========================================
// Context-bloat warning
// ===========================================

describe("checkContextBloat", () => {
	it("returns null for small responses", () => {
		expect(checkContextBloat("hello")).toBeNull();
		expect(checkContextBloat({ data: "small" })).toBeNull();
	});

	it("fires above the default threshold", () => {
		const big = "x".repeat(TOOL_RESULT_CHECK_DEFAULTS.bloat_char_threshold + 1);
		const hit = checkContextBloat(big);
		expect(hit).not.toBeNull();
		expect(hit?.chars).toBeGreaterThan(TOOL_RESULT_CHECK_DEFAULTS.bloat_char_threshold);
		expect(hit?.approx_tokens).toBeGreaterThan(0);
	});

	it("respects a custom threshold", () => {
		expect(checkContextBloat("hello world", 5)).not.toBeNull();
		expect(checkContextBloat("hello world", 100)).toBeNull();
	});

	it("handles objects by measuring JSON length", () => {
		const big = { data: "x".repeat(40_000) };
		expect(checkContextBloat(big)).not.toBeNull();
	});

	it("returns null for null/undefined", () => {
		expect(checkContextBloat(null)).toBeNull();
		expect(checkContextBloat(undefined)).toBeNull();
	});
});

// ===========================================
// Consecutive-error warning
// ===========================================

describe("consecutiveFailureWarning", () => {
	it("returns null below threshold", () => {
		expect(consecutiveFailureWarning(0, "Bash")).toBeNull();
		expect(consecutiveFailureWarning(1, "Bash")).toBeNull();
		expect(consecutiveFailureWarning(2, "Bash")).toBeNull();
	});

	it("fires at the default threshold of 3", () => {
		const msg = consecutiveFailureWarning(3, "Bash");
		expect(msg).toContain("Bash has failed 3 times");
	});

	it("keeps firing above threshold (every failure nudges the agent)", () => {
		expect(consecutiveFailureWarning(4, "Edit")).toContain("4 times");
		expect(consecutiveFailureWarning(10, "Edit")).toContain("10 times");
	});

	it("respects a custom threshold", () => {
		expect(consecutiveFailureWarning(1, "Bash", 2)).toBeNull();
		expect(consecutiveFailureWarning(2, "Bash", 2)).not.toBeNull();
	});
});

// ===========================================
// Message formatting
// ===========================================

describe("warning formatters", () => {
	it("formatSilentFailureWarning includes tool name and pattern", () => {
		const msg = formatSilentFailureWarning("mcp__chat__send_message", {
			pattern: "success: false",
			detail: "rate limit",
		});
		expect(msg).toContain("[interlinked:silent-failure]");
		expect(msg).toContain("mcp__chat__send_message");
		expect(msg).toContain("success: false");
		expect(msg).toContain("rate limit");
	});

	it("formatBloatWarning includes size and token estimate", () => {
		const msg = formatBloatWarning("Read", { chars: 50_000, approx_tokens: 12_500 });
		expect(msg).toContain("[interlinked:context-bloat]");
		expect(msg).toContain("Read");
		expect(msg).toContain("50,000");
		expect(msg).toContain("12,500");
	});
});
