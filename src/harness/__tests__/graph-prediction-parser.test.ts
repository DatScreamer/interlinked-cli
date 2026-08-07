// ===========================================
// graph-prediction parser — fenced YAML extraction
// ===========================================
// Extracts `graph_prediction:` blocks from agent response text. The
// design (§6) says fenced ```yaml blocks; we accept the bare `yaml` /
// `yml` fence-language and the language-less ``` fence (because some
// agents drop the language tag).
//
// Format-validation cap: predictions exceeding 50 entries per section
// are format violations (§6.3).

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	parseBarePrediction,
	parseGraphPredictionsFromText,
} from "../graph-prediction-parser.js";

describe("parseGraphPredictionsFromText — extraction", () => {
	it("returns [] on text with no fenced blocks", () => {
		expect(parseGraphPredictionsFromText("just prose, no code blocks here.")).toEqual([]);
	});

	it("returns [] on fenced blocks that do not contain `graph_prediction:`", () => {
		const text = ["here is some yaml:", "```yaml", "key: value", "```"].join("\n");
		expect(parseGraphPredictionsFromText(text)).toEqual([]);
	});

	it("extracts a single prediction from a ```yaml fenced block", () => {
		const text = [
			"My take:",
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: [\"node:net\"]",
			"    imported_by: [\"src/index.ts\"]",
			"  calls:",
			"    callers: []",
			"    callees: []",
			"  impact:",
			"    risk: low",
			"    domains: [\"Server\"]",
			"    direct: 1",
			"    transitive: 5",
			"    affects: [\"src/index.ts\"]",
			"```",
		].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/foo.ts");
		expect(nonNull(results[0]).deps?.imports).toEqual(["node:net"]);
		expect(nonNull(results[0]).impact?.risk).toBe("low");
		expect(nonNull(results[0]).impact?.direct).toBe(1);
	});

	it("extracts multiple predictions emitted in one response", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/a.ts",
			"  deps:",
			"    imports: []",
			"    imported_by: []",
			"```",
			"And the second:",
			"```yaml",
			"graph_prediction:",
			"  file: src/b.ts",
			"  deps:",
			"    imports: []",
			"    imported_by: []",
			"```",
		].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results.map((r) => r.file)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("accepts the language-less ``` fence (some agents drop the tag)", () => {
		const text = ["```", "graph_prediction:", "  file: src/foo.ts", "```"].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/foo.ts");
	});

	it("ignores fences that contain `graph_prediction` only as part of prose", () => {
		const text = [
			"```yaml",
			"# Discussion of graph_prediction:",
			"some_other_key: 1",
			"```",
		].join("\n");
		expect(parseGraphPredictionsFromText(text)).toEqual([]);
	});
});

describe("parseGraphPredictionsFromText — block-style YAML lists", () => {
	// The protocol doc's §6 example uses block-style lists. Agents reach for
	// that form because it matches the spec verbatim. The parser must
	// accept it alongside flow-style.

	it("parses block-style imports list", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports:",
			"      - node:net",
			"      - ./evaluator",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).deps?.imports).toEqual(["node:net", "./evaluator"]);
	});

	it("parses block-style imported_by + flow-style imports in the same prediction", () => {
		// Mixed forms in one block — neither is privileged.
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			'    imports: ["node:net"]',
			"    imported_by:",
			"      - src/index.ts",
			"      - src/runner.ts",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps?.imports).toEqual(["node:net"]);
		expect(nonNull(pred).deps?.imported_by).toEqual(["src/index.ts", "src/runner.ts"]);
	});

	it("parses block-style callers/callees with arrow notation", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  calls:",
			"    callers:",
			"      - Run ← init",
			"    callees:",
			"      - Run → getGraph",
			"      - Run → extract",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).calls?.callers).toEqual(["Run ← init"]);
		expect(nonNull(pred).calls?.callees).toEqual(["Run → getGraph", "Run → extract"]);
	});

	it("parses block-style domains/affects under impact", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  impact:",
			"    risk: medium",
			"    domains:",
			"      - Server",
			"      - Lifecycle",
			"    direct: 5",
			"    transitive: 12",
			"    affects:",
			"      - src/index.ts",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).impact?.domains).toEqual(["Server", "Lifecycle"]);
		expect(nonNull(pred).impact?.affects).toEqual(["src/index.ts"]);
		expect(nonNull(pred).impact?.direct).toBe(5);
	});

	it("returns parse_failed on an orphan list item (no parent key with empty value)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  - orphan_item",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toMatch(/orphan|no parent|list item/i);
	});

	it("returns parse_failed when block-style item indent doesn't exceed parent indent", () => {
		// `imports:` at indent 4, `- a` at indent 4 — at same level, not a child.
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports:",
			"    - a",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
	});
});

describe("parseGraphPredictionsFromText — section semantics", () => {
	it("treats whole-section omission as null for that section", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: [\"a.ts\"]",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps).not.toBeNull();
		expect(nonNull(pred).calls).toBeNull();
		expect(nonNull(pred).impact).toBeNull();
	});

	it("preserves the `unknown` sentinel inside lists (abstention)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: [\"a.ts\", unknown]",
			"    imported_by: unknown",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps?.imports).toEqual(["a.ts", "unknown"]);
		expect(nonNull(pred).deps?.imported_by).toBe("unknown");
	});

	it("distinguishes empty list (`[]` = explicit absence) from `unknown`", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: []",
			"    imported_by: unknown",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps?.imports).toEqual([]);
		expect(nonNull(pred).deps?.imported_by).toBe("unknown");
	});

	it("accepts integer counts and `unknown` for impact.direct/transitive", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  impact:",
			"    risk: medium",
			"    domains: [\"Server\"]",
			"    direct: 8",
			"    transitive: unknown",
			"    affects: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).impact?.direct).toBe(8);
		expect(nonNull(pred).impact?.transitive).toBe("unknown");
	});
});

describe("parseGraphPredictionsFromText — format-cap enforcement", () => {
	it("rejects a prediction whose section exceeds 50 entries (returns parse_failed marker)", () => {
		const items = Array.from({ length: 51 }, (_, i) => `\"file${i}.ts\"`).join(", ");
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			`    imports: [${items}]`,
			"    imported_by: []",
			"```",
		].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).parse_status).toBe("format_violation");
	});

	it("accepts a section at exactly 50 entries", () => {
		const items = Array.from({ length: 50 }, (_, i) => `\"file${i}.ts\"`).join(", ");
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			`    imports: [${items}]`,
			"    imported_by: []",
			"```",
		].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(nonNull(results[0]).parse_status).toBe("ok");
	});

	it("returns parse_failed marker on malformed YAML inside the block", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  this is { not: ] valid yaml",
			"```",
		].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results[0]?.parse_status).toBe("parse_failed");
	});

	it("returns parse_failed when `file:` field is missing or non-string", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  deps:",
			"    imports: []",
			"    imported_by: []",
			"```",
		].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results[0]?.parse_status).toBe("parse_failed");
	});
});

describe("parseGraphPredictionsFromText — quoted/plain scalar edge cases in list fields", () => {
	it("treats a quoted \"unknown\" string as the unknown sentinel (not the bare-word fast path)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			'    imports: "unknown"',
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).deps?.imports).toBe("unknown");
	});

	it("treats a bare non-list, non-unknown scalar under a list field as an empty list", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: banana",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).deps?.imports).toEqual([]);
	});
});

describe("parseGraphPredictionsFromText — malformed structural shapes", () => {
	it("fails when `file:` holds a non-string value", () => {
		const text = ["```yaml", "graph_prediction:", "  file: 123", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe("file field missing or non-string");
	});

	it("fails when `file:` has an empty value", () => {
		const text = ["```yaml", "graph_prediction:", "  file:", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe("file field missing or non-string");
	});

	it("returns parse_failed for a list item that precedes any key (true orphan, no tokens at all)", () => {
		const text = ["```yaml", "- orphan", "graph_prediction:", "  file: src/foo.ts", "```"].join(
			"\n",
		);
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe('orphan list item "orphan" — no parent key found');
	});

	it("returns parse_failed for a list item nested under a key that already has a scalar value", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  bogus: value",
			"    - x",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe(
			'list item "x" under "bogus" which already has a scalar value',
		);
	});

	it("returns parse_failed with empty file attribution when `file:` itself is empty and a later line is malformed", () => {
		const yaml = ["graph_prediction:", "  file:", "  this is { broken yaml"].join("\n");
		const pred = parseBarePrediction(yaml);
		expect(pred.parse_status).toBe("parse_failed");
		expect(pred.file).toBe("");
	});

	it("returns parse_failed when graph_prediction has no fields at all", () => {
		const pred = parseBarePrediction("graph_prediction:\n");
		expect(pred.parse_status).toBe("parse_failed");
		expect(pred.parse_error).toBe("no fields under graph_prediction");
	});

	it("skips an unrecognized top-level field and its deeper-indented children without failing the parse", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  extra:",
			"    child: 1",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).file).toBe("src/foo.ts");
		expect(nonNull(pred).deps).toBeNull();
	});

	it("skips an unrecognized subfield key and a stray deeper-nested token inside a known section", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: []",
			"    weird:",
			"      nested: x",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).deps?.imports).toEqual([]);
		expect(nonNull(pred).deps?.imported_by).toEqual([]);
	});
});

describe("parseBarePrediction — sentinel-path entry point", () => {
	// `parseBarePrediction` is the no-fence form. Sentinel-path
	// prediction submissions write bare YAML to a `.yaml` file; fences
	// would just be syntactic noise.

	it("parses a valid bare YAML prediction", () => {
		const yaml = [
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports:",
			"      - node:fs",
			"      - ./helper",
			"    imported_by:",
			"      - src/index.ts",
			"  impact:",
			"    risk: medium",
			"    direct: 3",
			"    transitive: 8",
		].join("\n");
		const pred = parseBarePrediction(yaml);
		expect(pred.parse_status).toBe("ok");
		expect(pred.file).toBe("src/foo.ts");
		expect(pred.deps?.imports).toEqual(["node:fs", "./helper"]);
		expect(pred.impact?.risk).toBe("medium");
		expect(pred.impact?.direct).toBe(3);
	});

	it("returns parse_failed on missing graph_prediction header", () => {
		const yaml = "some_other_key: value\n";
		expect(parseBarePrediction(yaml).parse_status).toBe("parse_failed");
	});

	it("returns parse_failed with the original file: preserved when YAML is malformed", () => {
		const yaml = [
			"graph_prediction:",
			"  file: src/recoverable.ts",
			"  this is { broken yaml at line 3",
		].join("\n");
		const pred = parseBarePrediction(yaml);
		expect(pred.parse_status).toBe("parse_failed");
		// File attribution should survive the parse error so the sentinel-
		// path handler can match the submission to the right target.
		expect(pred.file).toBe("src/recoverable.ts");
	});

	it("returns format_violation when a section exceeds the 50-entry cap", () => {
		const items = Array.from({ length: 51 }, (_, i) => `      - file${i}.ts`).join("\n");
		const yaml = [
			"graph_prediction:",
			"  file: src/big.ts",
			"  deps:",
			"    imports:",
			items,
			"    imported_by: []",
		].join("\n");
		expect(parseBarePrediction(yaml).parse_status).toBe("format_violation");
	});
});
