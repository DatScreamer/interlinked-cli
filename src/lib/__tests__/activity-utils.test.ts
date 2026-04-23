import { describe, expect, it } from "vitest";
import { formatActivitySummary, parseDuration } from "../activity-utils.js";

describe("parseDuration", () => {
	it("parses a seconds duration", () => {
		expect(parseDuration("30s")).toBe(30_000);
	});

	it("parses a minutes duration", () => {
		expect(parseDuration("5m")).toBe(5 * 60_000);
	});

	it("parses a hours duration", () => {
		expect(parseDuration("2h")).toBe(2 * 3_600_000);
	});

	it("parses a days duration", () => {
		expect(parseDuration("1d")).toBe(86_400_000);
	});

	it("accepts whitespace and mixed case", () => {
		expect(parseDuration("  15M  ")).toBe(15 * 60_000);
	});

	it("throws on unrecognized format", () => {
		expect(() => parseDuration("nope")).toThrow(/Invalid duration/);
	});

	it("throws on negative sign (unit-only grammar)", () => {
		expect(() => parseDuration("-1h")).toThrow(/Invalid duration/);
	});
});

describe("formatActivitySummary", () => {
	it("renders session_start / session_end as lifecycle strings", () => {
		expect(formatActivitySummary({ event_type: "session_start" })).toBe("Session started");
		expect(formatActivitySummary({ type: "session_end" })).toBe("Session ended");
	});

	it("renders `Read` with target path", () => {
		expect(formatActivitySummary({ tool: "Read", summary: "src/foo.ts" })).toBe(
			"Read src/foo.ts",
		);
	});

	it("renders `Write` / `Edit` variants", () => {
		expect(formatActivitySummary({ tool_name: "Write", tool_input_summary: "a.ts" })).toBe(
			"Wrote a.ts",
		);
		expect(formatActivitySummary({ tool_name: "Edit", tool_input_summary: "b.ts" })).toBe(
			"Edited b.ts",
		);
	});

	it("renders Bash with truncated command", () => {
		const long = `echo ${"x".repeat(200)}`;
		const out = formatActivitySummary({ tool: "Bash", summary: long });
		expect(out.startsWith("Ran: echo")).toBe(true);
		expect(out.length).toBeLessThan(long.length);
	});

	it("renders unknown tool with truncated input", () => {
		expect(formatActivitySummary({ tool: "NovelTool", summary: "input text" })).toMatch(
			/^NovelTool: input text/,
		);
	});

	it("appends a `(N tok)` suffix when tokens are present", () => {
		const out = formatActivitySummary({
			tool: "Read",
			summary: "x.ts",
			tokens: { input: 200, output: 300 },
		});
		expect(out).toMatch(/\(500 tok\)$/);
	});

	it("uses `k tok` form at >= 1000 tokens", () => {
		const out = formatActivitySummary({
			tool: "Read",
			summary: "x.ts",
			tokens: { input: 2000, output: 500 },
		});
		expect(out).toMatch(/\(2\.5k tok\)$/);
	});

	it("omits the token suffix when both input/output are zero", () => {
		const out = formatActivitySummary({
			tool: "Read",
			summary: "x.ts",
			tokens: { input: 0, output: 0 },
		});
		expect(out).toBe("Read x.ts");
	});

	it("falls back to `Used <tool>` when no input/summary is present", () => {
		expect(formatActivitySummary({ tool: "Custom" })).toBe("Used Custom");
	});
});
