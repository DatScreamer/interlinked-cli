import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTERLINKED_DIR, interlinkedPath } from "./interlinked-path.js";

describe("INTERLINKED_DIR", () => {
	it("is the literal data-directory name", () => {
		expect(INTERLINKED_DIR).toBe(".interlinked");
	});
});

describe("interlinkedPath", () => {
	it("returns the data directory itself when no segments are given", () => {
		expect(interlinkedPath("/repo")).toBe(join("/repo", ".interlinked"));
	});

	it("appends a single segment", () => {
		expect(interlinkedPath("/repo", "config.json")).toBe(join("/repo", ".interlinked", "config.json"));
	});

	it("appends multiple segments in order", () => {
		expect(interlinkedPath("/repo", "plans", "a.jsonl")).toBe(
			join("/repo", ".interlinked", "plans", "a.jsonl"),
		);
	});

	it("normalizes traversal segments the same way node:path does", () => {
		expect(interlinkedPath("/repo", "plans", "..", "x.json")).toBe(join("/repo", ".interlinked", "x.json"));
	});

	it("accepts a relative project root", () => {
		expect(interlinkedPath(".", "activity.jsonl")).toBe(join(".", ".interlinked", "activity.jsonl"));
	});

	it("is a pure function — repeated calls agree", () => {
		expect(interlinkedPath("/repo", "a")).toBe(interlinkedPath("/repo", "a"));
	});
});
