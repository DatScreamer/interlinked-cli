// ===========================================
// streaming-output unit tests
// ===========================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getActiveSkipChecks,
	SPINNER_FRAMES,
	setActiveSkipChecks,
	streamAllCqSections,
	streamCqSection,
} from "./streaming-output.js";
import { emptyResults } from "./tool-results-types.js";

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

	it("respects an explicit skip id when the human label differs", () => {
		setActiveSkipChecks(new Set(["mock_only_test"]));
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "mock-only tests",
			skipId: "mock_only_test",
			issues: [{ check: "mock_only_test", file: "a.test.ts", line: 1, message: "m" }],
			noun: "x",
			passLabel: "pass",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderrChunks.join("")).toBe("");
		expect(allFlagged.size).toBe(0);
	});
});

describe("streamAllCqSections", () => {
	it("uses section skip ids instead of normalized labels", () => {
		setActiveSkipChecks(new Set(["mock_only_test", "happy_path_only_test"]));
		const cq = emptyResults();
		cq.mockOnlyTest = [
			{ check: "mock_only_test", file: "a.test.ts", line: 1, message: "mock only" },
		];
		cq.happyPathOnlyTest = [
			{
				check: "happy_path_only_test",
				file: "b.test.ts",
				line: 1,
				message: "happy path only",
			},
		];

		streamAllCqSections(cq, false, new Set<string>());

		const out = stderrChunks.join("");
		expect(out).not.toContain("mock-only tests");
		expect(out).not.toContain("happy-path-only test files");
	});
});
