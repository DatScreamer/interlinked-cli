import { describe, expect, it } from "vitest";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
	formatBloatWarning,
} from "./tool-result-checks.js";

describe("tool-result-checks — mutation kill w43", () => {
	// --- 7931bb5234ecef3b: s.trim() -> s (tryParse must trim before startsWith) ---
	// test-contract: public-api — checkSilentFailure must parse a whitespace-padded
	// JSON object string (tryParse trims before the "{" startsWith check).
	it("parses a JSON object string with surrounding whitespace (trim matters for startsWith)", () => {
		const hit = checkSilentFailure('  {"error":"boom"}  ');
		expect(hit).not.toBeNull();
		expect(hit?.detail).toBe("boom");
	});

	// --- 13f1ecb33a32daef: typeof toolResponse !== "object" -> false ---
	// test-contract: public-api — checkSilentFailure(toolResponse) must ignore a
	// non-object, non-string value even if it carries a truthy .error property.
	it("skips non-object, non-string tool responses (a function value) entirely", () => {
		const fn: any = () => {};
		fn.error = "boom";
		expect(checkSilentFailure(fn)).toBeNull();
	});

	// --- 6b378399f7540223: !Array.isArray(toolResponse) -> true ---
	// test-contract: public-api — checkSilentFailure must never treat a raw array
	// toolResponse as inspectable, even when the array has extra string keys.
	it("does not inspect a bare array toolResponse even if it carries extra props", () => {
		const arr: any = [1, 2, 3];
		arr.success = false;
		expect(checkSilentFailure(arr)).toBeNull();
	});

	// --- cc016e181f0b278a / e3434a4bab812d24: block && typeof block === "object" guard ---
	// test-contract: public-api — checkSilentFailure(MCP content array) must never
	// throw on a null content block and must not report a spurious failure.
	it("skips a null content block instead of throwing when accessing .text", () => {
		const resp = { content: [null] };
		expect(() => checkSilentFailure(resp)).not.toThrow();
		expect(checkSilentFailure(resp)).toBeNull();
	});

	// --- a4cab844c45db899: typeof block === "object" -> true ---
	// test-contract: public-api — checkSilentFailure must not read .text off a
	// content block that is not a plain object (a function value here).
	it("does not treat a non-object (function) content block as having text", () => {
		const block: any = () => {};
		block.text = '{"error":"boom"}';
		const resp = { content: [block] };
		expect(checkSilentFailure(resp)).toBeNull();
	});

	// --- 517265b38dbac00f: typeof text === "string" -> true ---
	// test-contract: public-api — checkSilentFailure must not call tryParse on a
	// non-string .text field (would throw calling .trim() on a number).
	it("does not attempt to parse a non-string .text field on a content block", () => {
		const resp = { content: [{ text: 42 }] };
		expect(() => checkSilentFailure(resp)).not.toThrow();
		expect(checkSilentFailure(resp)).toBeNull();
	});

	// --- ff14ff426e10dce4: obj.error.slice(0, 200) -> obj.error ---
	// test-contract: public-api — inspectObject must truncate a string .error to
	// 200 chars in SilentFailureHit.detail (documented in formatSilentFailureWarning).
	it("truncates a long string error to 200 chars", () => {
		const hit = checkSilentFailure({ error: "e".repeat(300) });
		expect(hit?.detail.length).toBe(200);
	});

	// --- d6a1e80d073f5268: typeof obj.error === "object" -> true ---
	// test-contract: public-api — inspectObject must not classify a non-object
	// (function) .error value as an "error: <object>" hit.
	it("does not treat a non-object (function) error value as an object error", () => {
		const fn: any = () => {};
		fn.x = 1;
		expect(checkSilentFailure({ error: fn })).toBeNull();
	});

	// --- 4f62147930366a06 / dd116555e99b2830: error_code.length > 0 (vs true / >=0) ---
	// test-contract: public-api — inspectObject's doc comment says `error_code: ""`
	// is an explicit-success shape and must not produce a SilentFailureHit.
	it("does not fire on an empty error_code string", () => {
		expect(checkSilentFailure({ error_code: "" })).toBeNull();
	});

	// --- b7d376621776879f: obj.error_code.slice(0, 200) -> obj.error_code ---
	// test-contract: public-api — inspectObject must truncate error_code detail to
	// 200 chars, matching the string-error truncation contract above.
	it("truncates a long error_code to 200 chars", () => {
		const hit = checkSilentFailure({ error_code: "c".repeat(300) });
		expect(hit?.detail.length).toBe(200);
	});

	// --- 35008b4c5d6ecb58 / 246122f2c5968c6e: stringifyShort body replaced with {} ---
	// test-contract: public-api — stringifyShort (reached via inspectObject's
	// "error: <object>" branch) must return the JSON.stringify text, not undefined.
	it("stringifies an object error detail via JSON.stringify (not undefined)", () => {
		const hit = checkSilentFailure({ error: { code: "boom" } });
		expect(hit?.detail).toBe(JSON.stringify({ code: "boom" }));
	});

	// --- 2d845300471d76b6: JSON.stringify(v).slice(0, 200) -> JSON.stringify(v) ---
	// test-contract: public-api — stringifyShort must cap its return value at 200
	// chars even for a large object, matching the ".slice(0, 200)" contract.
	it("truncates a long object-error detail to 200 chars", () => {
		const bigObj: Record<string, string> = {};
		for (let i = 0; i < 50; i++) bigObj[`k${i}`] = `value_padding_${i}`;
		const hit = checkSilentFailure({ error: bigObj });
		expect(hit?.detail.length).toBe(200);
	});

	// --- 4a261f6564867e59 / 1281175e69ac784a: typeof toolResponse === "string" ---
	// test-contract: public-api — checkContextBloat must count a string response's
	// own length, not JSON.stringify-wrap it (which would add quote chars).
	it("computes bloat chars directly from string length, not via JSON.stringify wrapping", () => {
		const s = "x".repeat(100);
		const hit = checkContextBloat(s, 100);
		expect(hit?.chars).toBe(100);
	});

	// --- 6dcf90c65b63f1b4: toolResponse == null -> false ---
	// test-contract: public-api — checkContextBloat(null, ...) must short-circuit
	// to null and not fall through to JSON.stringify(null).length.
	it("returns null for a null tool response instead of stringifying it", () => {
		expect(checkContextBloat(null, 3)).toBeNull();
	});

	// --- c6012cb36cfcb27e: chars < thresholdChars vs <= ---
	// test-contract: boundary — checkContextBloat's own null-return condition is
	// `chars < thresholdChars`, so chars === thresholdChars must still be a hit.
	it("treats chars exactly at threshold as over budget (boundary)", () => {
		const hit = checkContextBloat("x".repeat(50), 50);
		expect(hit).not.toBeNull();
		expect(hit?.chars).toBe(50);
	});

	// --- 5b61cfb3b414dead: chars / 4 vs chars * 4 ---
	// test-contract: public-api — checkContextBloat's approx_tokens is documented
	// (module header comment) as "~4 chars/token", i.e. chars / 4.
	it("computes approx_tokens as chars / 4", () => {
		const hit = checkContextBloat("x".repeat(40000));
		expect(hit?.approx_tokens).toBe(10000);
	});

	// --- 1b486dfddd58816e / 6277183d5a6e05d2: consecutiveFailureWarning literal text ---
	// test-contract: public-api — consecutiveFailureWarning's user-facing message
	// text is the exported contract; both literal fragments must be present.
	it("includes the full consecutive-failure guidance text", () => {
		const msg = consecutiveFailureWarning(3, "Bash", 3);
		expect(msg).toContain(
			"Try a different approach: read upstream context, verify your assumptions, or",
		);
		expect(msg).toContain("escalate rather than retrying the same call.");
	});

	// --- 489845595b888d17: formatBloatWarning literal text ---
	// test-contract: public-api — formatBloatWarning's user-facing message text is
	// the exported contract; the closing guidance fragment must be present.
	it("includes the full bloat-warning guidance text", () => {
		const msg = formatBloatWarning("Read", { chars: 50000, approx_tokens: 12500 });
		expect(msg).toContain("or summarizing before further work to avoid burning context.");
	});
});
