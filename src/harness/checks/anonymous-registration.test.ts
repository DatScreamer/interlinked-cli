// `anonymous_registration` — a registry entry whose implementation has no name.
//
// Motivating incident (2026-08-09, this repo): four check registrations passed
// an inline arrow as `fn`, so `fn.name` was empty and the Check Evidence
// Contract's name-based resolver could not find a detector file for them. They
// were the last four ids nobody could satisfy — not because the checks were
// bad, but because nothing could LOOK THEM UP. Retrieval hostility bit our own
// tooling before it ever met a small model.
//
// The shape is general: an object literal carries a string `id` (the lookup
// key everything else references) and an anonymous function as its
// implementation. The key is greppable; the implementation is not reachable
// from it in one hop, by grep, by an embedding search, or by an agent asking
// "where is X implemented". Naming the function costs one word and restores
// the edge.

import { describe, expect, it } from "vitest";
import { checkAnonymousRegistration } from "./anonymous-registration.js";

const FILE = "src/harness/check-registry/entries-warnings/example.ts";

describe("checkAnonymousRegistration — positive (must fire)", () => {
	it("P1: an entry with a string id and an inline arrow implementation", () => {
		const code = [
			"export const ENTRIES = [",
			"\t{",
			'\t\tid: "some_check",',
			"\t\tfn: (content, filePath) => scan(content, filePath),",
			"\t},",
			"];",
		].join("\n");
		const hits = checkAnonymousRegistration(code, FILE);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(4);
	});

	it("P2: an anonymous function expression is equally unreachable", () => {
		const code = ['{ id: "x", fn: function (c) { return scan(c); } }'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toHaveLength(1);
	});

	it("P3: a handler-style key is the same hazard under a different name", () => {
		const code = ['{ id: "x", handler: (e) => run(e) }'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toHaveLength(1);
	});

	it("P4: `name` serves as the lookup key just as `id` does", () => {
		const code = ['{ name: "x", detector: (c) => scan(c) }'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toHaveLength(1);
	});
});

describe("checkAnonymousRegistration — negative (must NOT fire)", () => {
	it("N1: a NAMED function reference is one hop from its id", () => {
		const code = ['{ id: "x", fn: checkSomething }'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toEqual([]);
	});

	it("N2: a named function with a qualified path is still resolvable", () => {
		const code = ['{ id: "x", fn: checks.someDetector }'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toEqual([]);
	});

	it("N3: an anonymous callback with NO id nearby is ordinary code", () => {
		const code = ["items.map((x) => x * 2);", "run((e) => handle(e));"].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toEqual([]);
	});

	it("N4: an id beside a non-function value is not a registration hazard", () => {
		const code = ['{ id: "x", label: "Some Check", tier: 2 }'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toEqual([]);
	});

	it("N5: a test file may register throwaway handlers freely", () => {
		const code = ['{ id: "x", fn: (c) => scan(c) }'].join("\n");
		expect(checkAnonymousRegistration(code, "src/harness/checks/example.test.ts")).toEqual([]);
	});

	it("N6: a non-JS/TS file is out of scope", () => {
		const code = ['{ id: "x", fn: (c) => scan(c) }'].join("\n");
		expect(checkAnonymousRegistration(code, "config/example.json")).toEqual([]);
	});

	it("N7: the anonymous fn appearing only inside a comment is not code", () => {
		const code = ['// { id: "x", fn: (c) => scan(c) } is the shape to avoid'].join("\n");
		expect(checkAnonymousRegistration(code, FILE)).toEqual([]);
	});
});
