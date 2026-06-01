import { describe, expect, it } from "vitest";
import { parseProtocolMode, resolveIdleTimeoutMs, stringArg } from "../cli-args.js";

describe("stringArg", () => {
	it("returns the string value unchanged", () => {
		expect(stringArg("path/to/sock")).toBe("path/to/sock");
		expect(stringArg("")).toBe("");
	});

	it("maps a bare boolean flag (parseArgs `true`) to undefined", () => {
		// `--socket` with no `=value` yields `true` from parseArgs; treat as absent.
		expect(stringArg(true)).toBeUndefined();
	});

	it("maps undefined to undefined", () => {
		expect(stringArg(undefined)).toBeUndefined();
	});

	it("does not coerce false to a string", () => {
		expect(stringArg(false)).toBeUndefined();
	});
});

describe("parseProtocolMode", () => {
	it("passes through each known mode", () => {
		expect(parseProtocolMode("raw")).toBe("raw");
		expect(parseProtocolMode("framed")).toBe("framed");
		expect(parseProtocolMode("dual")).toBe("dual");
	});

	it("defaults to dual for undefined", () => {
		expect(parseProtocolMode(undefined)).toBe("dual");
	});

	it("defaults to dual for an unrecognized value", () => {
		expect(parseProtocolMode("bogus")).toBe("dual");
		expect(parseProtocolMode("")).toBe("dual");
		expect(parseProtocolMode("RAW")).toBe("dual");
	});
});

describe("resolveIdleTimeoutMs", () => {
	it("returns the default when the flag is absent", () => {
		expect(resolveIdleTimeoutMs(undefined, 0)).toBe(0);
		expect(resolveIdleTimeoutMs(undefined, 60_000)).toBe(60_000);
	});

	it("parses a numeric string", () => {
		expect(resolveIdleTimeoutMs("5000", 0)).toBe(5000);
		expect(resolveIdleTimeoutMs("0", 60_000)).toBe(0);
	});

	it("yields NaN for an unparseable value (caller treats falsy as disabled)", () => {
		expect(Number.isNaN(resolveIdleTimeoutMs("abc", 0))).toBe(true);
	});

	it("treats an explicit zero as provided, not as the default", () => {
		// A present "0" disables the timer; the default branch must not run.
		expect(resolveIdleTimeoutMs("0", 99)).toBe(0);
	});
});
