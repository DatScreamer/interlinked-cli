// ===========================================
// graph-prediction parser — mutation-kill campaign (W6/PASS-1)
// ===========================================
// Targets the 61 survivors recorded for src/harness/graph-prediction-parser.ts
// in .interlinked/mutation-manifest.json as of 2026-08-11. Each case is
// grouped by the private helper it exercises (none of extractFences,
// isPredictionBlock, parseSection, applySubsection, attachListItem,
// tokenizeBody, finalize, extractFilePartial, failed, inferChildIndent, or
// walkSubsection are exported — every assertion reaches them through the
// two real entry points, parseGraphPredictionsFromText and
// parseBarePrediction, matching how the parser is actually invoked in
// production).
//
// A handful of survivors are structurally unreachable (suspected_equivalent)
// given the current call graph; each is documented as a plain comment next
// to the group it belongs to, rather than as a skipped test, since a skip
// marker reads as a masked regression instead of a reasoned equivalence
// claim. Full structural arguments and mutantIds live in
// scratch/fleet-r3/receipts/graph-prediction-parser.jsonl.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { parseBarePrediction, parseGraphPredictionsFromText } from "../graph-prediction-parser.js";

describe("extractFences — unclosed fence tolerance", () => {
	// test-contract: boundary — mutantIds 4d56eafd23e13fe0, 1a0a92bd9bfb19df
	// (both target the inner while's `i < lines.length` guard in extractFences).
	// Without the guard, scanning for a closing fence walks past the end of
	// `lines` and `nonNull(lines[i])` throws instead of the function
	// gracefully treating EOF as the fence's end.
	it("treats the remainder of the text as the fence body when no closing fence is ever found", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts"].join("\n");
		expect(() => parseGraphPredictionsFromText(text)).not.toThrow();
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/foo.ts");
	});

	// EQUIVALENT (suspected): mutantId c35cadbb2d3b7097 (ArrayDeclaration
	// `blocks: FenceBlock[] = []` -> `["Stryker was here"]`). The injected
	// junk element is a bare string, not a {body} object. isPredictionBlock
	// reads `fence.body` off it, which is `undefined` for a string
	// primitive, and `/^graph_prediction:\s*$/m.test(undefined)` coerces to
	// the literal string "undefined" and never matches — so the junk
	// element is always filtered out by
	// `if (!isPredictionBlock(fence.body)) continue;` before it can affect
	// `results`, for every possible input. parseBarePrediction never calls
	// extractFences at all. No observable difference exists.
});

describe("isPredictionBlock — header-line strictness", () => {
	// test-contract: boundary — mutantId 760e88dd542f2d47 (Regex drops the
	// `$` end-anchor from /^graph_prediction:\s*$/m). Without it, trailing
	// non-whitespace content on the header line would still match.
	it("does not treat `graph_prediction:` followed by trailing content on the same line as the section header", () => {
		const text = ["```yaml", "graph_prediction: not-a-real-header", "file: x", "```"].join("\n");
		expect(parseGraphPredictionsFromText(text)).toEqual([]);
	});

	// test-contract: boundary — mutantId 0d8f662f5da4879c (Regex changes the
	// trailing `\s*` to `\S*`, which can only match zero characters before
	// end-of-line — so trailing whitespace after the colon would wrongly
	// reject a header that should be accepted).
	it("tolerates trailing whitespace after the graph_prediction: header on its own line", () => {
		const text = ["```yaml", "graph_prediction:   ", "  file: src/foo.ts", "```"].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/foo.ts");
	});
});

describe("parseSection — bare unknown sentinel", () => {
	// test-contract: invariant — mutantId 9ad5e6f6a243092f (BooleanLiteral
	// flips the `formatViolation: false` on the bare-`unknown` early return
	// to `true`). A section whose value is literally the unknown sentinel is
	// a legitimate abstention, not a format violation.
	it("does not flag a format violation when a list-typed field is the bare `unknown` sentinel", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: unknown",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).deps?.imports).toBe("unknown");
	});

	// EQUIVALENT (suspected): mutantId dfa32c9e8899f925 (ConditionalExpression
	// forces `rest === UNKNOWN_SENTINEL` to `false`). parseInlineValue's OWN
	// first line is the textually identical check `if (rest ===
	// UNKNOWN_SENTINEL) return { value: UNKNOWN_SENTINEL, formatViolation:
	// false };` — so disabling parseSection's copy only routes control into
	// parseInlineValue, which recognizes the exact same condition and
	// returns the identical shape. No `rest` value can ever distinguish the
	// two versions.
});

describe("impact.transitive — handler wiring", () => {
	// test-contract: public-api — mutantIds aa6eb365e6d484f4 (BlockStatement
	// empties the "transitive" handler body so it never assigns and never
	// returns false), 19725bc50b230d78 (ArrayDeclaration removes the whole
	// ["transitive", handler] tuple from IMPACT_SUBFIELDS), and
	// cded91f1a5e60acb (StringLiteral renames the map key "transitive" to
	// ""). All three have the same observable effect: a `transitive:` value
	// in the input never reaches PredictionImpact.transitive, which stays at
	// its "unknown" default instead.
	it("sets impact.transitive from the parsed count (not left at the unknown default)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  impact:",
			"    risk: low",
			"    domains: []",
			"    direct: 1",
			"    transitive: 42",
			"    affects: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).impact?.transitive).toBe(42);
	});
});

describe("applySubsection — equivalent mutants", () => {
	// EQUIVALENT (suspected x6): mutantIds a6b998ef043afebe, 90980d95fc8dfb84,
	// a2724abf8af2702e (LogicalOperator: each row's `field === FIELD_X &&
	// FIELD_X in parsed` -> `||`) and 281e58d56591591e, 71c3ebb638530e1d,
	// f8a2f929289bbe13 (ConditionalExpression: each row's `field ===
	// FIELD_X` -> `true`). applySubsection is not exported, and its only 3
	// call sites (in TOP_LEVEL_FIELD_PARSERS) always pass a `field` literal
	// paired with the matching parser's own result — parseDeps always
	// returns an object with a `deps` key, parseCalls always returns one
	// with `calls`, parseImpact always returns one with `impact`, and never
	// any other key. So for every real call, `field === FIELD_X` and
	// `FIELD_X in parsed` are perfectly correlated (both true together only
	// when field genuinely is X, both false together otherwise) — `&&`,
	// `||`, and dropping the `field===` check entirely all evaluate
	// identically across all 3 call sites. No input can reach a mismatched
	// (field, parsed-shape) pair to break the correlation.
	//
	// test-contract: invariant — each of deps/calls/impact must reach the
	// output under its own section header, independent of the equivalence
	// argument above (documents the field/parsed-shape pairing that
	// argument relies on).
	it("wires deps/calls/impact through their matching field label only (documents the invariant the equivalence relies on)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: []",
			"    imported_by: []",
			"  calls:",
			"    callers: []",
			"    callees: []",
			"  impact:",
			"    risk: low",
			"    domains: []",
			"    direct: 0",
			"    transitive: 0",
			"    affects: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps).not.toBeNull();
		expect(nonNull(pred).calls).not.toBeNull();
		expect(nonNull(pred).impact).not.toBeNull();
	});
});

describe("attachListItem — backward-scan correctness", () => {
	// test-contract: boundary — mutantId 86eefa70d4efb135 (EqualityOperator
	// `i >= 0` -> `i > 0`). Index 0 is always the graph_prediction header
	// token; skipping it as a candidate means a list item whose only
	// possible parent is the header itself is wrongly reported as an
	// orphan instead of successfully (if uselessly) attaching, which
	// changes parse_error downstream.
	it("checks token index 0 (the header itself) as a candidate parent for a list item", () => {
		const text = ["```yaml", "graph_prediction:", "  - orphan_ish", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		// Original: attachListItem succeeds against the header (index 0),
		// so tokenizeBody reports no error; the parse still fails later
		// because inferChildIndent finds no other token, giving a DIFFERENT
		// error than the mutant's premature "orphan" report.
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe("no fields under graph_prediction");
	});

	// test-contract: boundary — mutantId b1c4b89fbb139515 (ObjectLiteral
	// empties the same-indent-collision return value, dropping its specific
	// `error` string so the caller's `?? "list item attach failed"`
	// fallback fires instead).
	it("reports the specific same-indent-as-key error for a list item that collides with a preceding key's indent", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports: []",
			"  - stray",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe('list item "stray" at same indent as preceding key "deps"');
	});

	// test-contract: boundary — mutantId 8fb7ee39318eca46 (ConditionalExpression
	// forces `nonNull(candidate).indent < item.indent` to `true`). A deeper
	// intervening key (indent > the list item's own indent) must be SKIPPED
	// while scanning backward for the real, shallower parent; forcing the
	// check to true instead attaches the item to the first non-equal-indent
	// candidate encountered, even a deeper, unrelated one.
	it("skips a deeper-indented key between a list's parent and its items (does not misattribute to the deeper key)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    imports:",
			"        overdeep: 1",
			"      - node:net",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).deps?.imports).toEqual(["node:net"]);
	});

	// EQUIVALENT (suspected): mutantId 2661f39e0679a249 (EqualityOperator
	// `nonNull(candidate).indent < item.indent` -> `<=`). Control only
	// reaches this second `if` after the FIRST `if (candidate.indent ===
	// item.indent)` has already returned early when equal. So by the time
	// the `<` vs `<=` comparison runs, `candidate.indent !== item.indent` is
	// already guaranteed — equality is impossible here, so `<` and `<=` are
	// the same boolean for every reachable candidate.
});

describe("tokenizeBody — blank/comment line handling", () => {
	// test-contract: boundary — mutantId cb88d670b9d0d77c (MethodExpression
	// `raw.trim() === ""` -> `raw === ""`, the blank-line check). A
	// whitespace-only line (no content, but not literally "") must still be
	// treated as blank; both tokenizeKeyValue and tokenizeListItem also
	// reject it, so under the mutant it falls all the way to the
	// malformed-line error instead of being silently skipped.
	it("treats a whitespace-only line as blank (not malformed)", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "   ", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).file).toBe("src/foo.ts");
	});

	// test-contract: boundary — mutantId bedcba47d082ebc5 (MethodExpression
	// `raw.trim().startsWith("#")` -> `raw.trim().endsWith("#")`). A comment
	// line that starts with # but doesn't happen to end with # must still be
	// recognized as a comment.
	it("skips a comment line that doesn't happen to end with #", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "# comment text", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
	});

	// test-contract: boundary — mutantId e90249357d0723b0 (MethodExpression
	// removes the `.trim()` inside `raw.trim().startsWith("#")`, leaving
	// `raw.startsWith("#")`). An INDENTED comment line has leading
	// whitespace before the #, so checking the raw (untrimmed) line misses
	// it — it must check the trimmed content.
	it("skips an indented comment line (not just a comment starting at column 0)", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "  # a comment", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).file).toBe("src/foo.ts");
	});
});

describe("tokenizeBody — malformed-line error message shape", () => {
	// test-contract: boundary — mutantId 577efc8eb8b52fc9 (MethodExpression
	// removes the `.slice(0, 80)` truncation from the malformed-line error
	// message, leaving the full untruncated line no matter how long).
	it("truncates an overlong malformed line to 80 characters in the error message", () => {
		const longMalformed = "x".repeat(120);
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", longMalformed, "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe(`malformed line: ${"x".repeat(80)}`);
	});

	// test-contract: boundary — mutantId fc01ed764abaa0ba (MethodExpression
	// removes the `.trim()` inside `raw.trim().slice(0, 80)`, leaving
	// `raw.slice(0, 80)` — leading whitespace on the offending line would
	// then leak into the error message instead of being stripped first).
	it("trims leading whitespace before including a malformed line in the error message", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "   this is { not valid", "```"].join(
			"\n",
		);
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe("malformed line: this is { not valid");
	});

	// EQUIVALENT (suspected): mutantId b0f9a0111c2930a5 (ConditionalExpression
	// forces `tok.rest === ""` to `true` in the post-process blockItems-to-
	// flow-list synthesis). `blockItems` is only ever populated by
	// attachListItem, and attachListItem only attaches to a candidate AFTER
	// verifying `candidate.rest !== ""` returns early (i.e. only when rest
	// IS empty). `rest` is never reassigned anywhere else in the module, so
	// `tok.blockItems` truthy already implies `tok.rest === ""` for every
	// token, unconditionally — the forced-true condition changes nothing.
});

describe("finalize — file-field-missing message", () => {
	// test-contract: public-api — mutantId 30990adf39bbe768 (StringLiteral
	// "file field missing" -> ""). This is the exact literal surfaced when
	// the `file:` key never appears in the token stream at all (distinct
	// from the FIELD_FILE parser's own "file field missing or non-string").
	it("uses the exact literal error message when the file key never appears at all", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  deps:",
			"    imports: []",
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).parse_error).toBe("file field missing");
	});
});

describe("extractFilePartial — recovery-path key/value filtering", () => {
	// test-contract: boundary — mutantIds 4569a1124759467d (ConditionalExpression
	// `tok.key !== FIELD_FILE` -> `false`, so every token is treated as a
	// "file" candidate) and e826d5907909d633 (StringLiteral final fallback
	// `""` -> "Stryker was here!"). Both are observable through the same
	// input: a malformed body with no `file:` key at all, but another key
	// with a valid-looking string value.
	it("only reads the file: key when recovering a partial file attribution (ignores other fields' values)", () => {
		const text = ["```yaml", "graph_prediction:", "  note: something", "  this is { not valid", "```"].join(
			"\n",
		);
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).file).toBe("");
	});

	// test-contract: boundary — mutantIds 3fd0bf9c6be43e8d (ConditionalExpression
	// forces the whole `typeof value === "string" && value !== ""` check to
	// `true`), e64a847cb792ab84 (LogicalOperator `&&` -> `||`), and
	// 70e936752b0e2866 (ConditionalExpression forces just `typeof value ===
	// "string"` to `true`). All three would let a NUMERIC file: value (from
	// parseScalar's numeric fast path) through as if it were a valid string
	// recovery result.
	it("does not recover a numeric file: value as the partial file attribution (must be a real string)", () => {
		const text = ["```yaml", "graph_prediction:", "  file: 123", "  this is { not valid", "```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).file).toBe("");
	});

	// test-contract: boundary — mutantId a5f588e32867859a (ConditionalExpression
	// forces `value !== ""` to `true`). An earlier `file:` token whose value
	// is genuinely the empty string must be skipped in favor of scanning on
	// to a LATER `file:` token with a real value, not returned immediately.
	it("keeps scanning past an empty file: value to find a later non-empty one during partial recovery", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file:",
			"  file: src/real.ts",
			"  this is { not valid",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
		expect(nonNull(pred).file).toBe("src/real.ts");
	});
});

describe("parseSinglePrediction — guard against operating on an empty token stream", () => {
	// test-contract: boundary — mutantIds 738b36c04ed5b2cf (ConditionalExpression
	// forces the whole `tokens.length === 0 || tokens[0].key !== TOP_LEVEL_KEY`
	// check to `false`), 51d3b52f855df209 (LogicalOperator `||` -> `&&`), and
	// 491924095ac1a885 (ConditionalExpression forces just `tokens.length ===
	// 0` to `false`). All three defeat the short-circuit that protects
	// `nonNull(tokens[0])` from running against a genuinely empty token
	// array (an all-comment/all-blank bare body), which otherwise throws.
	it("does not crash when a bare prediction body is entirely blank/comments (produces zero tokens)", () => {
		expect(() => parseBarePrediction("# just a comment, no content\n")).not.toThrow();
		const pred = parseBarePrediction("# just a comment, no content\n");
		expect(pred.parse_status).toBe("parse_failed");
		expect(pred.parse_error).toBe("missing graph_prediction: header");
	});
});

describe("parseSinglePrediction — top-level key must be graph_prediction", () => {
	// test-contract: public-api — mutantIds 823cd92171ac4714 (BlockStatement
	// empties the "missing header" return block, so a wrong top-level key
	// falls through into normal field-parsing instead of failing),
	// 50d196cdfd058491 (StringLiteral empties the error message template),
	// and 5a08966823c8f45b (ConditionalExpression forces `tokens[0].key !==
	// TOP_LEVEL_KEY` to `false`, same fall-through effect as the block-body
	// mutant). A document whose top-level key isn't literally
	// "graph_prediction" must be rejected even if its children happen to
	// look like valid fields.
	it("rejects a document whose top-level key is not graph_prediction (even with a valid-looking file: child)", () => {
		const yaml = ["other_key:", "  file: src/foo.ts"].join("\n");
		const pred = parseBarePrediction(yaml);
		expect(pred.parse_status).toBe("parse_failed");
		expect(pred.parse_error).toBe("missing graph_prediction: header");
	});
});

describe("parseSinglePrediction — main dispatch loop bounds", () => {
	// test-contract: boundary — mutantId 6418b8b07529d237 (BlockStatement
	// empties the `{ i++; continue; }` skip body for a token whose indent
	// doesn't match childIndent). Killed by the EXISTING companion test
	// below (already shipped, not new): under the mutant, `i` never
	// advances for the stray deeper-indented "child: 1" token and the main
	// while loop never terminates. This existing case is the one that
	// exercises exactly that branch (T3 at indent 4 vs childIndent 2).
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

	// test-contract: boundary — mutantId b880edc35b5b322f (ConditionalExpression
	// forces `nonNull(tok).indent !== childIndent` to `false`, so the loop
	// never skips a deeper-nested token — instead it dispatches EVERY token
	// to TOP_LEVEL_FIELD_PARSERS by key, even ones nested inside an
	// unrecognized section). A deeper "file:" residue under an unrelated
	// section must not overwrite the real top-level file value.
	it("does not let a deeper-nested key that happens to share a top-level field name overwrite the real value", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  extra:",
			"    file: src/wrong.ts",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).file).toBe("src/foo.ts");
	});
});

describe("failed() — default file value on a direct return", () => {
	// test-contract: invariant — mutantId d5ddd678e43cbeec (StringLiteral
	// `""` -> "Stryker was here!" inside failed()'s object literal). Most
	// callers spread `{...failed(reason), file: X}`, overriding the default,
	// but the `childIndent === null` branch in parseSinglePrediction returns
	// `failed(...)` directly with no override, so the internal default
	// surfaces as-is.
	it("uses an empty string for file when returning the direct failed() result (no fields under header)", () => {
		const pred = parseBarePrediction("graph_prediction:\n");
		expect(pred.parse_status).toBe("parse_failed");
		expect(pred.parse_error).toBe("no fields under graph_prediction");
		expect(pred.file).toBe("");
	});
});

describe("inferChildIndent — skips same-or-shallower siblings", () => {
	// test-contract: boundary — mutantIds 7cabbf6125350df1 (ConditionalExpression
	// forces `tokens[i].indent > topIndent` to `true` starting at i=1) and
	// 645a5271b6a0920b (EqualityOperator `>` -> `>=`). Both would accept a
	// same-indent sibling of the graph_prediction header as the child
	// indent, instead of continuing to scan for the true, deeper child.
	it("keeps scanning past a same-indent sibling to find the true deeper child indent", () => {
		const yaml = ["graph_prediction:", "sibling: x", "  file: src/foo.ts"].join("\n");
		const pred = parseBarePrediction(yaml);
		expect(pred.parse_status).toBe("ok");
		expect(pred.file).toBe("src/foo.ts");
	});
});

describe("walkSubsection — exact child-depth dispatch", () => {
	// test-contract: boundary — mutantId d6de4dd9ad9cba77 (ConditionalExpression
	// forces `nonNull(tok).indent === childIndent` to `true`). A deeper
	// token nested under an unrecognized subfield key must not be dispatched
	// just because its key name happens to collide with a real subfield
	// name at the WRONG depth.
	it("does not apply a deeper-nested token that happens to share a subfield name (only exact child-depth tokens count)", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			"    weird:",
			'      imports: ["nested_wrongly"]',
			"    imported_by: []",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps?.imports).toEqual([]);
	});
});

describe("parseDeps / parseCalls / parseImpact — per-field defaults", () => {
	// test-contract: invariant — mutantIds fa73b2e7afd4007a (ObjectLiteral
	// empties the whole `{imports:[],imported_by:[]}` initial state) and
	// 23538b2402ab93d5 (ArrayDeclaration, imported_by's own `[]` default ->
	// junk array). Omitting `imported_by:` entirely must still default it to
	// an empty list, not leave it undefined or junk.
	it("defaults deps.imported_by to an empty list when the field is entirely absent from input", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			'    imports: ["a.ts"]',
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps).toEqual({ imports: ["a.ts"], imported_by: [] });
	});

	// test-contract: invariant — mutantId 411fa40a06abacc7 (ArrayDeclaration,
	// imports' own `[]` default -> junk array).
	it("defaults deps.imports to an empty list when the field is entirely absent from input", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  deps:",
			'    imported_by: ["b.ts"]',
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).deps).toEqual({ imports: [], imported_by: ["b.ts"] });
	});

	// test-contract: invariant — mutantIds 8272044d48e8bd17 (ObjectLiteral
	// empties the whole `{callers:[],callees:[]}` initial state) and
	// 60681ccaacafc54c (ArrayDeclaration, callees' own `[]` default -> junk).
	it("defaults calls.callees to an empty list when the field is entirely absent from input", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "  calls:", '    callers: ["a"]', "```"].join(
			"\n",
		);
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).calls).toEqual({ callers: ["a"], callees: [] });
	});

	// test-contract: invariant — mutantId 662f4be2dfedb95a (ArrayDeclaration,
	// callers' own `[]` default -> junk array).
	it("defaults calls.callers to an empty list when the field is entirely absent from input", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "  calls:", '    callees: ["b"]', "```"].join(
			"\n",
		);
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).calls).toEqual({ callers: [], callees: ["b"] });
	});

	// test-contract: invariant — mutantIds e47a91a5778109d7 (ObjectLiteral
	// empties the whole 5-key impact initial state), ad5f2e3bd8736262
	// (ArrayDeclaration, domains' own `[]` default -> junk), and
	// d77213ec2e57dcf9 (ArrayDeclaration, affects' own `[]` default -> junk).
	// Omitting domains/affects/transitive must default them, not leave
	// undefined/junk, while risk/direct (which ARE specified) still parse.
	it("defaults impact.domains and impact.affects to empty lists (and transitive to unknown) when absent from input", () => {
		const text = [
			"```yaml",
			"graph_prediction:",
			"  file: src/foo.ts",
			"  impact:",
			"    risk: low",
			"    direct: 1",
			"```",
		].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).impact).toEqual({
			risk: "low",
			domains: [],
			direct: 1,
			transitive: "unknown",
			affects: [],
		});
	});
});

describe("module-level fence regexes — anchor and character-class strictness", () => {
	// test-contract: boundary — mutantId c209623932a7c1f4 (Regex drops the
	// trailing `$` from FENCE_RE). Trailing prose after the language tag on
	// an opening-fence-shaped line must not be accepted as a real opener.
	it("does not treat an opening fence with trailing prose after the language tag as valid", () => {
		const text = ["```yaml extra stuff", "graph_prediction:", "  file: src/foo.ts", "```"].join("\n");
		expect(parseGraphPredictionsFromText(text)).toEqual([]);
	});

	// test-contract: boundary — mutantId f1a3da26be360ceb (Regex drops the
	// leading `^` from FENCE_RE). A fence marker preceded by other text on
	// the same line must not be accepted as a real opener.
	it("does not treat a fence marker preceded by other text on the same line as a valid opener", () => {
		const text = ["prose ```yaml", "graph_prediction:", "  file: src/foo.ts", "```"].join("\n");
		expect(parseGraphPredictionsFromText(text)).toEqual([]);
	});

	// test-contract: boundary — mutantId d526a357d4460cda (Regex changes
	// `(?:ya?ml)?` to `(?:yaml)?`, requiring the literal "yaml" instead of
	// tolerating the "yml" short form).
	it("accepts the short `yml` fence language tag (not just `yaml`)", () => {
		const text = ["```yml", "graph_prediction:", "  file: src/foo.ts", "```"].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/foo.ts");
	});

	// test-contract: boundary — mutantId 55b74726bbc6664e (Regex changes the
	// trailing `\s*` to `\S*` in FENCE_RE, which can only match zero
	// characters before end-of-line).
	it("tolerates trailing whitespace after the fence language tag", () => {
		const text = ["```yaml   ", "graph_prediction:", "  file: src/foo.ts", "```"].join("\n");
		const results = parseGraphPredictionsFromText(text);
		expect(results).toHaveLength(1);
	});

	// test-contract: boundary — mutantId c7424b4b24726d95 (Regex drops the
	// leading `^` from FENCE_END_RE). A closing marker preceded by other
	// text on its line must not be accepted as a real closer — under the
	// mutant it wrongly IS accepted, so the following genuinely-malformed
	// line never gets swallowed into the fence body and the parse succeeds
	// instead of failing.
	it("does not treat a line with a fence marker preceded by other text as a valid closer", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "prose ```"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
	});

	// test-contract: boundary — mutantId 8326860bdfcfc323 (Regex drops the
	// trailing `$` from FENCE_END_RE). A closing marker with trailing
	// content on its line must not be accepted as a real closer.
	it("does not treat a line with trailing content after the fence marker as a valid closer", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "``` extra"].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("parse_failed");
	});

	// test-contract: boundary — mutantId ee1bbde758f7a136 (Regex changes the
	// trailing `\s*` to `\S*` in FENCE_END_RE).
	it("tolerates trailing whitespace after the closing fence marker", () => {
		const text = ["```yaml", "graph_prediction:", "  file: src/foo.ts", "```   "].join("\n");
		const [pred] = parseGraphPredictionsFromText(text);
		expect(nonNull(pred).parse_status).toBe("ok");
		expect(nonNull(pred).file).toBe("src/foo.ts");
	});
});
