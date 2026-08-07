import { describe, expect, it } from "vitest";
import {
	collectElapsedTimeAnchors,
	findEnclosingScope,
	isElapsedTimeLine,
	isTypeOnlyModule,
} from "./shared-scan.js";

describe("isTypeOnlyModule", () => {
	it("returns false for a non-TS extension even with type-only-looking content", () => {
		expect(isTypeOnlyModule("shape.js", "type X = string;\n")).toBe(false);
	});

	it("returns false for a file with no type/interface declaration at all", () => {
		expect(isTypeOnlyModule("empty.ts", "export const x = 1;\n")).toBe(false);
	});

	it("returns false when the module has an `export default` expression", () => {
		expect(
			isTypeOnlyModule("d.ts", "type X = string;\nexport default 42;\n"),
		).toBe(false);
	});

	it("returns true for a single `type` alias terminated by a semicolon", () => {
		expect(isTypeOnlyModule("a.ts", "type X = string;\n")).toBe(true);
	});

	it("returns true for an `interface` declaration with a body", () => {
		expect(isTypeOnlyModule("b.ts", "interface Foo {\n  a: string;\n}\n")).toBe(true);
	});

	it("returns true for `export interface` with an inline empty body", () => {
		expect(isTypeOnlyModule("c.ts", "export interface Foo {}\n")).toBe(true);
	});

	it("returns true for `import type` followed by a `type` alias", () => {
		expect(
			isTypeOnlyModule("e.ts", 'import type { A } from "a";\ntype X = A;\n'),
		).toBe(true);
	});

	it("handles a bracketed type alias (array type) — exercises bracket depth tracking", () => {
		expect(isTypeOnlyModule("f.ts", "type X = string[];\n")).toBe(true);
	});

	it("handles a parenthesized function-type alias — exercises paren depth tracking", () => {
		expect(isTypeOnlyModule("f2.ts", "type Fn = (a: string) => void;\n")).toBe(true);
	});

	it("returns true when the sole type alias's terminating newline is the last character (EOF right after the newline)", () => {
		expect(isTypeOnlyModule("f3.ts", "type X = string\n")).toBe(true);
	});

	it("returns false when a runtime statement follows a type declaration", () => {
		expect(
			isTypeOnlyModule("g.ts", "type X = string;\nexport const y = 1;\n"),
		).toBe(false);
	});

	it("returns true for a type alias with no trailing semicolon or newline (EOF terminates it)", () => {
		expect(isTypeOnlyModule("h.ts", "type X = string")).toBe(true);
	});

	it("returns true when a type alias is followed by a blank line before the next statement", () => {
		expect(isTypeOnlyModule("i.ts", "type X = string\n\ntype Y = number;\n")).toBe(true);
	});

	it("returns false for an interface with no opening brace at all (never sees a body)", () => {
		expect(isTypeOnlyModule("j.ts", "interface Foo")).toBe(false);
	});

	it("returns false for an unterminated type alias body (brace never closes)", () => {
		expect(isTypeOnlyModule("k.ts", "type X = {\n  a: string,\n")).toBe(false);
	});

	it("returns true for an interface whose closing brace is followed by whitespace then a semicolon", () => {
		expect(isTypeOnlyModule("l.ts", "interface Foo {}   ;\n")).toBe(true);
	});

	it("returns true for a multi-line `import type` where the next line is the `from` clause", () => {
		expect(
			isTypeOnlyModule("m.ts", 'import type Foo\nfrom "foo";\ntype X = Foo;\n'),
		).toBe(true);
	});

	it("returns true for a multi-line union type continuation (next line starts with `|`)", () => {
		expect(
			isTypeOnlyModule("n.ts", 'type X =\n  | "a"\n  | "b";\n'),
		).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with a keyword (`typeof`)", () => {
		expect(isTypeOnlyModule("o.ts", "type X =\n  typeof Foo;\n")).toBe(true);
	});
});

describe("findEnclosingScope", () => {
	it("returns null for a line at top level with no enclosing declaration", () => {
		expect(findEnclosingScope("export const x = 1;\n", 1)).toBeNull();
	});

	it("finds the enclosing named function for a line inside its body", () => {
		const content = "function outer() {\n  const x = 1;\n  return x;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("outer");
	});

	it("finds the enclosing class for a line inside its body", () => {
		const content = "class Widget {\n  render() {\n    return 1;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("render");
	});

	it("skips a control-keyword false match and finds the real enclosing scope", () => {
		const content = "function outer() {\n  if (true) {\n    return 1;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("outer");
	});

	it("clamps a line number past the end of the file to the last line", () => {
		const content = "function outer() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 9999)).toBe("outer");
	});

	it("clamps a line number below 1 to the first line", () => {
		const content = "function outer() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 0)).toBe("outer");
	});
});

describe("collectElapsedTimeAnchors / isElapsedTimeLine", () => {
	it("collects an identifier assigned from Date.now() that is later subtracted", () => {
		const src = "const t0 = Date.now();\ndoWork();\nconst elapsed = Date.now() - t0;\n";
		const anchors = collectElapsedTimeAnchors(src);
		expect(anchors).toEqual(new Set(["t0"]));
	});

	it("does not collect an anchor that is never subtracted", () => {
		const src = "const t0 = Date.now();\nrecord({ at: t0 });\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set());
	});

	it("isElapsedTimeLine is true for both the anchor line and the delta line", () => {
		const anchors = new Set(["t0"]);
		expect(isElapsedTimeLine("const t0 = Date.now();", anchors)).toBe(true);
		expect(isElapsedTimeLine("const elapsed = Date.now() - t0;", anchors)).toBe(true);
	});

	it("isElapsedTimeLine is false for an unrelated line", () => {
		const anchors = new Set(["t0"]);
		expect(isElapsedTimeLine("const x = 1;", anchors)).toBe(false);
	});

	it("isElapsedTimeLine is false with an empty anchor set", () => {
		expect(isElapsedTimeLine("const elapsed = Date.now() - t0;", new Set())).toBe(false);
	});
});

describe("isTypeOnlyModule — extension anchor", () => {
	it("returns false when the ts extension appears mid-filename, not at the end", () => {
		expect(isTypeOnlyModule("foo.ts.bak", "type X = string;\n")).toBe(false);
	});
});

describe("isTypeOnlyModule — vacuous import-type-only module", () => {
	it("returns false for a module containing only `import type`, no real type/interface declaration", () => {
		expect(isTypeOnlyModule("p.ts", 'import type { A } from "a";\n')).toBe(false);
	});

	it("returns false for empty content (no type declared at all — vacuous)", () => {
		expect(isTypeOnlyModule("empty2.ts", "")).toBe(false);
	});

	it("returns false for whitespace-only content (no type declared at all)", () => {
		expect(isTypeOnlyModule("empty3.ts", "   \n  \n")).toBe(false);
	});
});

describe("isTypeOnlyModule — export default detection boundaries", () => {
	it("returns false when an indented `export default` line is embedded inside an open type body", () => {
		expect(
			isTypeOnlyModule("v1.ts", "type X = {\n  export default 1;\n};\n"),
		).toBe(false);
	});

	it("returns false when `export default` has extra internal whitespace", () => {
		expect(
			isTypeOnlyModule("v2.ts", "type X = {\n  export  default 1;\n};\n"),
		).toBe(false);
	});

	it("returns true when `export default` appears only as a bracketed token, never at a line start", () => {
		expect(
			isTypeOnlyModule("v3.ts", "type X = {\n  foo: [export default];\n};\n"),
		).toBe(true);
	});
});

describe("isTypeOnlyModule — bracket/brace/paren depth floor-guarding", () => {
	it("returns true for a type alias with a stray unmatched closing bracket (floor-guarded, doesn't go negative)", () => {
		expect(isTypeOnlyModule("w1.ts", "type X = string];\n")).toBe(true);
	});

	it("returns true for a type alias with a stray unmatched closing brace (floor-guarded)", () => {
		expect(isTypeOnlyModule("w2.ts", "type X = string};\n")).toBe(true);
	});

	it("returns true for a type alias with a stray unmatched closing paren (floor-guarded)", () => {
		expect(isTypeOnlyModule("w3.ts", "type X = string);\n")).toBe(true);
	});

	it("returns true for a multi-line bracket type — depth must stay open across the newline", () => {
		expect(isTypeOnlyModule("w4.ts", "type X = [\n  1\n];\n")).toBe(true);
	});

	it("returns true for a multi-line paren type — depth must stay open across the newline", () => {
		expect(
			isTypeOnlyModule("w5.ts", "type Fn = (\n  a: string\n) => void;\n"),
		).toBe(true);
	});

	it("returns true for a doubly-nested interface object body — depth must survive an inner close", () => {
		expect(
			isTypeOnlyModule(
				"w6.ts",
				"interface Foo {\n  bar: {\n    a: string;\n  };\n}\n",
			),
		).toBe(true);
	});

	it("returns true for a doubly-nested bracket type — depth must survive an inner close", () => {
		expect(
			isTypeOnlyModule("w7.ts", "type X = [\n  [1, 2],\n  3,\n];\n"),
		).toBe(true);
	});

	it("returns true for a doubly-nested paren type — depth must survive an inner close", () => {
		expect(
			isTypeOnlyModule(
				"w8.ts",
				"type Fn = (\n  a: (b: string) => void,\n) => void;\n",
			),
		).toBe(true);
	});
});

describe("isTypeOnlyModule — interface with no body never terminates", () => {
	it("returns false for an interface name with trailing whitespace and no brace at all", () => {
		expect(isTypeOnlyModule("x1.ts", "interface Foo   ")).toBe(false);
	});
});

describe("isTypeOnlyModule — semicolon vs newline statement termination", () => {
	it("returns true for a type alias whose terminating semicolon is followed by trailing spaces then EOF", () => {
		expect(isTypeOnlyModule("y1.ts", "type X = string;   ")).toBe(true);
	});

	it("returns true when consumeOptionalSemicolon must skip tabs before the semicolon", () => {
		expect(isTypeOnlyModule("y2.ts", "interface Foo {}\t\t;\n")).toBe(true);
	});

	it("returns true when consumeOptionalSemicolon must skip a carriage return before the semicolon", () => {
		expect(isTypeOnlyModule("y3.ts", "interface Foo {}\r;\n")).toBe(true);
	});

	it("returns true for interface with no trailing semicolon at all after the closing brace", () => {
		expect(isTypeOnlyModule("y4.ts", "interface Foo {}\n")).toBe(true);
	});
});

describe("isTypeOnlyModule — multi-line continuation edge cases", () => {
	it("returns false for a multi-line import type where the next line is NOT a `from` clause", () => {
		expect(
			isTypeOnlyModule("z1.ts", 'import type Foo\nnotFrom("foo");\ntype X = Foo;\n'),
		).toBe(false);
	});

	it("returns true for a multi-line type continuation starting with `&`", () => {
		expect(isTypeOnlyModule("z2.ts", "type X = A\n  & B;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with `=`", () => {
		expect(isTypeOnlyModule("z3.ts", "type X<T\n  = string> = T;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with `?`", () => {
		expect(isTypeOnlyModule("z4.ts", "type X = A extends B\n  ? C\n  : D;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with `:`", () => {
		expect(isTypeOnlyModule("z5.ts", "type X = A extends B ? C\n  : D;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with `,`", () => {
		expect(isTypeOnlyModule("z6.ts", "type X = Pick<A\n  , 'b'>;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with `>`", () => {
		expect(isTypeOnlyModule("z7.ts", "type X = Array<A\n  >;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with the `keyof` keyword", () => {
		expect(isTypeOnlyModule("z8.ts", "type X =\n  keyof A;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with the `readonly` keyword", () => {
		expect(isTypeOnlyModule("z9.ts", "type X =\n  readonly string[];\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with the `infer` keyword", () => {
		expect(isTypeOnlyModule("z10.ts", "type X<T> = T extends (infer U)[]\n  ? infer U\n  : never;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with the `unique` keyword", () => {
		expect(isTypeOnlyModule("z11.ts", "type X =\n  unique symbol;\n")).toBe(true);
	});

	it("returns true for a multi-line type continuation starting with the `this` keyword", () => {
		expect(isTypeOnlyModule("z12.ts", "type X =\n  this;\n")).toBe(true);
	});
});

describe("findEnclosingScope — line clamping and undefined-guarded scan", () => {
	it("clamps a very large out-of-range line number without throwing (upper bound)", () => {
		const content = "function outer() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 1_000_000)).toBe("outer");
	});

	it("clamps a negative line number to the first line", () => {
		const content = "function outer() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, -50)).toBe("outer");
	});

	it("returns null when there is truly no enclosing declaration anywhere above the target", () => {
		const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		expect(findEnclosingScope(content, 3)).toBeNull();
	});
});

describe("findEnclosingScope — declaration regex precision", () => {
	it("finds a generator function by name", () => {
		const content = "function* gen() {\n  yield 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("gen");
	});

	it("finds an async function by name", () => {
		const content = "async function loadData() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("loadData");
	});

	it("finds an exported function by name", () => {
		const content = "export function build() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("build");
	});

	it("does not match a function declaration missing the parenthesis", () => {
		const content = "function build\n  return 1;\n";
		expect(findEnclosingScope(content, 2)).toBeNull();
	});

	it("finds an abstract exported class by name", () => {
		const content = "export abstract class Base {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("Base");
	});

	it("finds a plain class with no export/abstract keyword", () => {
		const content = "class Plain {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("Plain");
	});

	it("does not match `classy` as a class declaration (word boundary)", () => {
		const content = "classy Thing {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBeNull();
	});

	it("finds an exported const arrow function", () => {
		const content = "export const handler = (req) => {\n  return req;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("handler");
	});

	it("finds a let arrow function with an async keyword and a bare-identifier parameter", () => {
		const content = "let run = async x => {\n  return x;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("run");
	});

	it("finds a var-declared function expression", () => {
		const content = "var legacy = function () {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("legacy");
	});

	it("finds a const async function expression", () => {
		const content = "const task = async function () {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("task");
	});

	it("does not match a const whose value is a plain number, not a function", () => {
		const content = "const notAFn = 1;\nconst x = 2;\n";
		expect(findEnclosingScope(content, 2)).toBeNull();
	});

	it("finds an indented class method by name", () => {
		const content = "class Widget {\n  compute(a, b) {\n    return a + b;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("compute");
	});

	it("finds an indented static method by name", () => {
		const content = "class Widget {\n  static load(id) {\n    return id;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("load");
	});

	it("finds an indented private method by name", () => {
		const content = "class Widget {\n  private helper(x) {\n    return x;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("helper");
	});

	it("finds an indented protected method by name", () => {
		const content = "class Widget {\n  protected guard(x) {\n    return x;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("guard");
	});

	it("finds an indented public method by name", () => {
		const content = "class Widget {\n  public expose(x) {\n    return x;\n  }\n}\n";
		expect(findEnclosingScope(content, 3)).toBe("expose");
	});

	it("does not match an un-indented top-level call-like line as a method", () => {
		const content = "helper(1, 2) {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBeNull();
	});
});

describe("findEnclosingScope — keyword blacklist, one case per blacklisted word", () => {
	const blacklisted = [
		"if",
		"for",
		"while",
		"switch",
		"catch",
		"return",
		"do",
		"with",
		"throw",
		"typeof",
		"new",
		"in",
		"of",
		"as",
	];

	it.each(blacklisted)("does not report a top-level '%s (...)' block as an enclosing scope", (word) => {
		const content = `  ${word} (x) {\n    const y = 1;\n  }\n`;
		expect(findEnclosingScope(content, 2)).toBeNull();
	});
});

describe("collectElapsedTimeAnchors / isElapsedTimeLine — regex precision", () => {
	it("collects a performance.now() anchor, not just Date.now()", () => {
		const src = "let start = performance.now();\nconst d = performance.now() - start;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["start"]));
	});

	it("collects a var-declared anchor", () => {
		const src = "var t0 = Date.now();\nconst d = Date.now() - t0;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["t0"]));
	});

	it("does not collect an identifier assigned from something other than Date/performance.now()", () => {
		const src = "const t0 = Math.random();\nconst d = Date.now() - t0;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set());
	});

	it("does not collect when the subtraction has no Date/performance.now() on the left", () => {
		const src = "const t0 = Date.now();\nconst d = someOther() - t0;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set());
	});

	it("escapes a `$`-containing identifier safely in both anchor collection and line matching", () => {
		const src = "const t$0 = Date.now();\nconst d = Date.now() - t$0;\n";
		const anchors = collectElapsedTimeAnchors(src);
		expect(anchors).toEqual(new Set(["t$0"]));
		expect(isElapsedTimeLine("const t$0 = Date.now();", anchors)).toBe(true);
		expect(isElapsedTimeLine("const d = Date.now() - t$0;", anchors)).toBe(true);
	});

	it("isElapsedTimeLine does not treat a similarly-named-but-different identifier as a match", () => {
		const anchors = new Set(["t0"]);
		expect(isElapsedTimeLine("const t01 = Date.now();", anchors)).toBe(false);
	});

	it("collects multiple independent anchors from the same file", () => {
		const src =
			"const a = Date.now();\nconst b = Date.now();\ndoWork();\nconst da = Date.now() - a;\nconst db = Date.now() - b;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["a", "b"]));
	});
});
