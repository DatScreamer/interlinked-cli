import { afterEach, describe, expect, it, vi } from "vitest";
import * as cyclomaticAst from "./cyclomatic-ast.js";
import { cognitiveComplexityCheck, computeCognitiveAst } from "./cognitive-ast.js";

function entryFor(content: string, name: string) {
	const entries = computeCognitiveAst(content, "probe.ts");
	if (!entries) throw new Error("expected AST entries (typescript dep must be present in test env)");
	const entry = entries.find((e) => e.name === name);
	if (!entry) throw new Error(`no entry named ${name} in ${JSON.stringify(entries)}`);
	return entry;
}

describe("cognitive-ast.ts — mutation-kill w50", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// isLoop: ts.isForStatement(node) || ts.isForInStatement(node) — mutants
	// 390f35cea18eacd4 (-> false) and 9bd5427e61e0019b (-> &&). Both collapse
	// a plain `for` loop's contribution to 0 (neither is-for-of/while/do).
	it("counts a bare `for` loop as one nested increment", () => {
		const entry = entryFor(`function f() { for (let i=0;i<10;i++) { doThing(); } }`, "f");
		expect(entry.cognitive).toBe(1);
	});

	it("counts a bare `for-in` loop as one nested increment", () => {
		const entry = entryFor(`function f(o) { for (const k in o) { doThing(k); } }`, "f");
		expect(entry.cognitive).toBe(1);
	});

	// unwrapParens: ts.isParenthesizedExpression(cur) -> false (3cf8d22810740260).
	// Without unwrapping, a parenthesized left operand of a logical-op run is
	// treated as a new run (an extra +1) instead of continuing the run.
	it("treats a parenthesized left operand as continuing the same && run", () => {
		const entry = entryFor(`function f(a,b,c) { return (a && b) && c; }`, "f");
		expect(entry.cognitive).toBe(1);
	});

	// scoreUnit's `recursable` gate for constructor/callback names — mutants
	// c69fb3af17d89e6c, b0e239a282536b89, 4a0acc49bed9e9bb, b0ef723d48d7f08f,
	// 08faf8e1eaf1cd09 all make a constructor's self-call count as recursion.
	it("does not count a same-named outer call from inside a constructor as recursion", () => {
		const code = `
class C {
  constructor() {
    constructor();
  }
}
function constructor() {}
`;
		const entries = computeCognitiveAst(code, "probe.ts");
		if (!entries) throw new Error("expected AST entries");
		const ctor = entries.find((e) => e.line === 3);
		if (!ctor) throw new Error(`no constructor entry in ${JSON.stringify(entries)}`);
		expect(ctor.cognitive).toBe(0);
	});

	// f3836e421629cee8: `nesting > maxNesting` — mutant b4087ed92daf3ab0
	// (-> true) unconditionally overwrites maxNesting with the LAST nesting
	// seen, corrupting it once a shallower construct follows a deeper one.
	it("keeps maxNesting at the deepest level even after a later shallower construct", () => {
		const entry = entryFor(
			`function f(a,b,c,d) {
  if (a) {
    if (b) {
      if (c) { doThing(); }
    }
  }
  if (d) { doOther(); }
}`,
			"f",
		);
		expect(entry.maxNesting).toBe(2);
	});

	// cd7139ffb404e903 visitIf: isElseIf mutants (09b56811269d3d3f -> false,
	// faad229823e64bcc BooleanLiteral true->false at the recursive call site)
	// route an `else if` through addNested(nesting) instead of the flat +1,
	// which only diverges numerically once nesting > 0.
	it("scores a nested `else if` chain as flat +1 per link, not a nested increment", () => {
		const entry = entryFor(
			`function f(a,b,c,d) {
  if (a) {
    if (b) {
      doB();
    } else if (c) {
      doC();
    } else {
      doD();
    }
  }
}`,
			"f",
		);
		expect(entry.cognitive).toBe(5);
		expect(entry.maxNesting).toBe(1);
	});

	// cd7139ffb404e903: `nesting + 1` -> `nesting - 1`, three call sites
	// (condition, then-branch, plain-else branch). One test per site.
	it("propagates nesting+1 into the if condition (ternary inside condition)", () => {
		const entry = entryFor(
			`function f(a,b,c,d) {
  if (a ? (b ? c : d) : false) {
    doThing();
  }
}`,
			"f",
		);
		expect(entry.cognitive).toBe(6);
		expect(entry.maxNesting).toBe(2);
	});

	it("propagates nesting+1 into a nested if inside a plain else block", () => {
		const entry = entryFor(
			`function f(a,b,c) {
  if (a) {
    doA();
  } else {
    if (b) { doThing(); }
  }
}`,
			"f",
		);
		expect(entry.cognitive).toBe(4);
		expect(entry.maxNesting).toBe(1);
	});

	it("propagates nesting+1 into deeply nested if bodies", () => {
		const entry = entryFor(
			`function f(a,b,c) { if (a) { if (b) { if (c) { doThing(); } } } }`,
			"f",
		);
		expect(entry.cognitive).toBe(6);
		expect(entry.maxNesting).toBe(2);
	});

	// 502a9ffc131fd467: `node.expression.text === unitName` -> true. A call to
	// a DIFFERENT identifier must not be mistaken for recursion.
	it("does not count a call to a different-named function as recursion", () => {
		const entry = entryFor(`function foo() { bar(); }`, "foo");
		expect(entry.cognitive).toBe(0);
	});

	it("does count a genuine self-recursive call", () => {
		const entry = entryFor(`function foo() { foo(); }`, "foo");
		expect(entry.cognitive).toBe(1);
	});

	// 0db5c83fc28f4eaa: `!parsed` -> false. When parseTsSource reports failure,
	// computeCognitiveAst must return null rather than dereferencing it.
	it("returns null (not a throw) when the underlying parser reports failure", () => {
		const spy = vi.spyOn(cyclomaticAst, "parseTsSource").mockReturnValueOnce(null);
		expect(computeCognitiveAst("function f(){}", "f.ts")).toBeNull();
		spy.mockRestore();
	});

	// 98320d77c72a0a5b: endLine's `+ 1` -> `- 1`, and the "js_ts" literal -> "".
	it("computes endLine as the 1-based end line, distinct from and >= line", () => {
		const entry = entryFor(`function f() {\n  doThing();\n}`, "f");
		expect(entry.line).toBe(1);
		expect(entry.endLine).toBe(3);
		expect(entry.language).toBe("js_ts");
	});

	// 2f257b784b53d941 / 7ba62181ab11957e: entries.sort((a,b)=>a.line-b.line).
	// AST preorder traversal already yields non-decreasing `line`, so this is
	// asserted as an explicit invariant on multi-entry output.
	it("returns entries in non-decreasing line order", () => {
		const real = computeCognitiveAst(
			`function outer() {\n  function nested() {}\n}\nfunction later() {}\n`,
			"probe.ts",
		);
		if (!real) throw new Error("expected AST entries");
		const lines = real.map((e) => e.line);
		const sortedLines = [...lines].sort((a, b) => a - b);
		expect(lines).toEqual(sortedLines);
		expect(real.map((e) => e.name)).toEqual(["outer", "nested", "later"]);
	});

	// 68e2b61d9d4ceb55: `!JS_TS_RE.test(filePath)` -> false. A non-JS/TS
	// filePath must short-circuit to [] regardless of content.
	it("returns [] for a non-JS/TS file path even with over-threshold content", () => {
		const overThreshold = `function f(a,b,c,d,e,f2) { if(a){if(b){if(c){if(d){if(e){if(f2){}}}}}} }`;
		expect(cognitiveComplexityCheck(overThreshold, "notes.py")).toEqual([]);
	});

	// 68e2b61d9d4ceb55: `!entries` -> false. When the AST is unavailable the
	// check must return [] rather than iterating over null.
	it("returns [] (does not throw) when the AST is unavailable", () => {
		const spy = vi.spyOn(cyclomaticAst, "parseTsSource").mockReturnValueOnce(null);
		const result = cognitiveComplexityCheck(
			`function f(a,b,c,d,e,f2) { if(a){if(b){if(c){if(d){if(e){if(f2){}}}}}} }`,
			"f.ts",
		);
		expect(result).toEqual([]);
		spy.mockRestore();
	});

	// 68e2b61d9d4ceb55: snippet .trim().slice(0, 90) — mutants remove the
	// slice (5c10be3476e73b5d) or the trim (c88c73de8135c031).
	it("truncates a long function-declaration line to 90 chars in the snippet", () => {
		const longName =
			"reallyLongFunctionNameThatMakesTheLineExceedNinetyCharactersForSureYesItDoesIndeed";
		const code = `function ${longName}(a,b,c,d,e,f2) {\n  if(a){if(b){if(c){if(d){if(e){if(f2){}}}}}}\n}`;
		const matches = cognitiveComplexityCheck(code, "f.ts");
		expect(matches.length).toBe(1);
		const matchText = matches[0]?.text ?? "";
		const snippet = matchText.split(" — cognitive ")[0] ?? "";
		expect(snippet.length).toBeLessThanOrEqual(90);
		// the full un-truncated line is much longer than 90 chars
		const firstLine = code.split("\n")[0] ?? "";
		expect(firstLine.length).toBeGreaterThan(90);
	});

	it("trims leading indentation out of the snippet", () => {
		const code = `function outer() {\n\tfunction inner(a,b,c,d,e,f2) {\n\t\tif(a){if(b){if(c){if(d){if(e){if(f2){}}}}}}\n\t}\n}`;
		const matches = cognitiveComplexityCheck(code, "f.ts");
		const innerMatch = matches.find((m) => m.text.startsWith("function inner"));
		expect(innerMatch).toBeDefined();
		expect(innerMatch?.text.startsWith("\t")).toBe(false);
		expect(innerMatch?.text.startsWith(" ")).toBe(false);
	});

	// a61ea6576d7c6dad: JS_TS_RE regex — mutants negate the [cm] character
	// class (8f14225a97e648d1) and drop the trailing $ anchor (3fe8406a0fc12d10).
	it("matches a .cjs extension (the [cm] character class)", () => {
		const overThreshold = `function f(a,b,c,d,e,f2) { if(a){if(b){if(c){if(d){if(e){if(f2){}}}}}} }`;
		expect(cognitiveComplexityCheck(overThreshold, "foo.cjs").length).toBe(1);
	});

	it("does not match a path merely containing .tsx mid-string (requires the $ anchor)", () => {
		const overThreshold = `function f(a,b,c,d,e,f2) { if(a){if(b){if(c){if(d){if(e){if(f2){}}}}}} }`;
		expect(cognitiveComplexityCheck(overThreshold, "notes.tsx.md")).toEqual([]);
	});
});
