import { describe, expect, it } from "vitest";
import { parseDurationMs, resolveSinceCutoff, updateSeenBounds } from "./recurrence-time.js";

describe("parseDurationMs", () => {
	it("parses s/m/h/d/w with whitespace and case tolerance", () => {
		expect(parseDurationMs("90s")).toBe(90 * 1000);
		expect(parseDurationMs("  7D  ")).toBe(7 * 24 * 60 * 60 * 1000);
	});
	it("returns null on malformed input or overflowing product (round-12 sol #3)", () => {
		expect(parseDurationMs("seven days")).toBeNull();
		expect(parseDurationMs("")).toBeNull();
		expect(parseDurationMs(`${"9".repeat(306)}s`)).toBeNull();
	});
});

describe("resolveSinceCutoff", () => {
	const NOW = new Date("2026-05-04T12:00:00.000Z");
	it("resolves relative and absolute forms", () => {
		expect(resolveSinceCutoff("1d", NOW)).toBe("2026-05-03T12:00:00.000Z");
		expect(resolveSinceCutoff("2026-04-01T00:00:00Z", NOW)).toBe("2026-04-01T00:00:00.000Z");
	});
	it("returns null (never throws) for empty, garbage, oversized, or invalid now", () => {
		expect(resolveSinceCutoff(undefined, NOW)).toBeNull();
		expect(resolveSinceCutoff("garbage", NOW)).toBeNull();
		expect(() => resolveSinceCutoff(`${"9".repeat(309)}w`, NOW)).not.toThrow();
		expect(resolveSinceCutoff(`${"9".repeat(309)}w`, NOW)).toBeNull();
		// round-18 sol #4 was a false positive — this already returns null:
		expect(resolveSinceCutoff("1d", new Date("invalid"))).toBeNull();
	});
});

describe("updateSeenBounds", () => {
	it("widens min/max with valid timestamps", () => {
		const row = { first_seen: "2026-05-02T00:00:00.000Z", last_seen: "2026-05-02T00:00:00.000Z" };
		updateSeenBounds(row, "2026-05-01T00:00:00.000Z");
		updateSeenBounds(row, "2026-05-03T00:00:00.000Z");
		expect(row.first_seen).toBe("2026-05-01T00:00:00.000Z");
		expect(row.last_seen).toBe("2026-05-03T00:00:00.000Z");
	});
	it("a valid timestamp replaces a malformed bound; a malformed one is ignored (round-17 sol #2)", () => {
		const row = { first_seen: "not-a-date", last_seen: "not-a-date" };
		updateSeenBounds(row, "bad-too"); // ignored — nothing valid to set
		expect(row.first_seen).toBe("not-a-date");
		updateSeenBounds(row, "2026-05-01T00:00:00.000Z"); // replaces both bad bounds
		expect(row.first_seen).toBe("2026-05-01T00:00:00.000Z");
		expect(row.last_seen).toBe("2026-05-01T00:00:00.000Z");
	});
});
