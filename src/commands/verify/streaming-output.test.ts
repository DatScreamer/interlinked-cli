// ===========================================
// streaming-output unit tests
// ===========================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getActiveSkipChecks,
	SPINNER_FRAMES,
	setActiveSkipChecks,
	streamCqSection,
} from "./streaming-output.js";

let stderrChunks: string[];
let origErr: typeof process.stderr.write;

beforeEach(() => {
	stderrChunks = [];
	origErr = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		stderrChunks.push(chunk);
		return true;
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stderr.write = origErr;
	setActiveSkipChecks(new Set());
});

describe("SPINNER_FRAMES", () => {
	it("has a non-empty frame list", () => {
		expect(SPINNER_FRAMES.length).toBeGreaterThan(0);
	});
});

describe("activeSkipChecks", () => {
	it("setActiveSkipChecks round-trips via getActiveSkipChecks", () => {
		setActiveSkipChecks(new Set(["strong_typing"]));
		expect(getActiveSkipChecks().has("strong_typing")).toBe(true);
	});

	it("defaults to an empty set once cleared", () => {
		setActiveSkipChecks(new Set());
		expect(getActiveSkipChecks().size).toBe(0);
	});
});

describe("streamCqSection", () => {
	it("writes the pass-label when there are no issues", () => {
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "test section",
			issues: [],
			noun: "issues",
			passLabel: "all clear",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		const out = stderrChunks.join("");
		expect(out).toContain("test section");
		expect(out).toContain("all clear");
		expect(allFlagged.size).toBe(0);
	});

	it("adds flagged files to the allFlaggedFiles set", () => {
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "bad thing",
			issues: [{ check: "x", file: "a.ts", line: 1, message: "m" }],
			noun: "bad things",
			passLabel: "no bad things",
			details: false,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		expect(allFlagged.has("a.ts")).toBe(true);
	});

	it("respects the skip set", () => {
		setActiveSkipChecks(new Set(["skip_me"]));
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "skip me",
			issues: [{ check: "x", file: "a.ts", line: 1, message: "m" }],
			noun: "x",
			passLabel: "pass",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderrChunks.join("")).toBe("");
	});
});
