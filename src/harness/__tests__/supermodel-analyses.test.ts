import { describe, expect, it } from "vitest";

import {
	type DeadCodeCandidate,
	formatDeadCodeFindings,
	isSupermodelCliAvailable,
	parseDeadCodeJson,
	runSupermodelDeadCode,
} from "../supermodel-analyses.js";

// A representative `supermodel dead-code --output json` payload, matching
// the api.DeadCodeResult schema in
// reference-repos/supermodel-cli/internal/api/types.go.
const SAMPLE_JSON = JSON.stringify({
	metadata: {
		totalDeclarations: 412,
		deadCodeCandidates: 2,
		analysisMethod: "call-graph-reachability",
	},
	deadCodeCandidates: [
		{
			file: "src/legacy/util.ts",
			name: "formatLegacy",
			line: 88,
			type: "function",
			confidence: "high",
			reason: "no callers; not an entry point",
		},
		{
			file: "src/api/old.ts",
			name: "oldHandler",
			line: 12,
			type: "function",
			confidence: "low",
			reason: "only reachable from a test file",
		},
	],
	aliveCode: [],
	entryPoints: [],
});

describe("parseDeadCodeJson", () => {
	it("parses a well-formed dead-code result", () => {
		const result = parseDeadCodeJson(SAMPLE_JSON);
		expect(result).not.toBeNull();
		expect(result!.totalDeclarations).toBe(412);
		expect(result!.candidates).toHaveLength(2);
		expect(result!.candidates[0]).toEqual({
			file: "src/legacy/util.ts",
			name: "formatLegacy",
			line: 88,
			confidence: "high",
			reason: "no callers; not an entry point",
		});
	});

	it("returns null on empty input", () => {
		expect(parseDeadCodeJson("")).toBeNull();
		expect(parseDeadCodeJson("   ")).toBeNull();
	});

	it("returns null on invalid JSON", () => {
		expect(parseDeadCodeJson("{not json")).toBeNull();
	});

	it("returns null on a non-object payload", () => {
		expect(parseDeadCodeJson("[1,2,3]")).toBeNull();
		expect(parseDeadCodeJson('"a string"')).toBeNull();
	});

	it("returns null when deadCodeCandidates is missing", () => {
		expect(parseDeadCodeJson(JSON.stringify({ metadata: {} }))).toBeNull();
	});

	it("skips malformed candidates but keeps valid ones", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [
				{ file: "a.ts", name: "good", line: 1, confidence: "high", reason: "r" },
				{ name: "noFile" },
				{ file: "b.ts" },
				42,
				null,
			],
		});
		const result = parseDeadCodeJson(json);
		expect(result!.candidates).toHaveLength(1);
		expect(result!.candidates[0].name).toBe("good");
	});

	it("defaults confidence to low, line to 0, reason to empty when absent or invalid", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [{ file: "a.ts", name: "x", confidence: "bogus" }],
		});
		const result = parseDeadCodeJson(json);
		expect(result!.candidates[0].confidence).toBe("low");
		expect(result!.candidates[0].line).toBe(0);
		expect(result!.candidates[0].reason).toBe("");
	});

	it("defaults totalDeclarations to 0 when metadata is absent", () => {
		const json = JSON.stringify({ deadCodeCandidates: [] });
		expect(parseDeadCodeJson(json)!.totalDeclarations).toBe(0);
	});
});

describe("formatDeadCodeFindings", () => {
	it("returns an empty array when there are no candidates", () => {
		expect(formatDeadCodeFindings({ candidates: [], totalDeclarations: 5 })).toEqual([]);
	});

	it("orders candidates by confidence, highest first", () => {
		const analysis = parseDeadCodeJson(SAMPLE_JSON);
		const lines = formatDeadCodeFindings(analysis!);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("formatLegacy");
		expect(lines[0]).toContain("high confidence");
		expect(lines[1]).toContain("oldHandler");
	});

	it("tags each line and includes file:line and the reason", () => {
		const lines = formatDeadCodeFindings(parseDeadCodeJson(SAMPLE_JSON)!);
		expect(lines[0]).toContain("[interlinked:supermodel-dead-code]");
		expect(lines[0]).toContain("src/legacy/util.ts:88");
		expect(lines[0]).toContain("no callers");
	});

	it("caps the list and notes the overflow", () => {
		const candidates: DeadCodeCandidate[] = Array.from({ length: 25 }, (_, i) => ({
			file: `f${i}.ts`,
			name: `fn${i}`,
			line: i,
			confidence: "medium",
			reason: "unreferenced",
		}));
		const lines = formatDeadCodeFindings({ candidates, totalDeclarations: 100 }, { max: 20 });
		expect(lines).toHaveLength(21); // 20 shown + 1 overflow line
		expect(lines[20]).toContain("5 more");
	});
});

describe("isSupermodelCliAvailable", () => {
	it("returns a boolean without throwing", () => {
		expect(typeof isSupermodelCliAvailable()).toBe("boolean");
	});

	it("returns false for a binary that does not exist", () => {
		expect(isSupermodelCliAvailable("supermodel-nonexistent-binary-xyz")).toBe(false);
	});
});

describe("runSupermodelDeadCode", () => {
	it("returns null when the CLI binary is not found (graceful skip)", () => {
		const result = runSupermodelDeadCode(process.cwd(), {
			binary: "supermodel-nonexistent-binary-xyz",
		});
		expect(result).toBeNull();
	});
});
