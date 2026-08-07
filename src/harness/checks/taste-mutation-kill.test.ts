// Precision tests targeting taste.ts mutation survivors: exact-array assertions
// (line + text) for extension gates, message construction (trim/slice/join),
// nested-bracket depth tracking, and the shared signature-parsing helpers.
// Companion to taste.test.ts and generic-checks-extended-taste.test.ts — this
// file exists specifically to close mutation-testing gaps those left open
// (loose `toBeGreaterThan`/`toContain` assertions don't observe an exact line
// number, exact truncation point, or exact rejected/accepted boundary).
import { describe, expect, it } from "vitest";
import {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkFunctionArity,
	checkManyOptionalParams,
	checkPositionalOptionalBoolean,
} from "./taste.js";

describe("checkBooleanTrap — extension gate, exact match content", () => {
	it("P: recognizes every listed extension with an exact match", () => {
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
			expect(checkBooleanTrap("call(true, false);", `f${ext}`)).toEqual([
				{ line: 1, text: "call(true, false);" },
			]);
		}
	});

	it("N: does not fire on an unlisted extension", () => {
		expect(checkBooleanTrap("call(true, false);", "f.py")).toEqual([]);
		expect(checkBooleanTrap("call(true, false);", "f.go")).toEqual([]);
	});

	it("P: reports the trimmed original line (not the comment/string-stripped one) at the correct 1-indexed line", () => {
		const code = "const x = 1;\n   call(true, false);   \nconst y = 2;";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 2, text: "call(true, false);" }]);
	});

	it("P: truncates the reported text to exactly 150 characters", () => {
		const filler = "a".repeat(200);
		const code = `call(true, false, "${filler}");`;
		const matches = checkBooleanTrap(code, "f.ts");
		expect(matches).toEqual([{ line: 1, text: code.trim().slice(0, 150) }]);
		expect(matches[0]?.text.length).toBe(150);
	});

	it("P: matches a call with no space before the parenthesis (kills a widened call-start regex)", () => {
		// The gate regex (line 48) is intentionally loose (`\w\s*\(`); this fixture
		// pins the no-space case specifically since it's the minimal form.
		expect(checkBooleanTrap("call(true, false);", "f.ts")).toEqual([
			{ line: 1, text: "call(true, false);" },
		]);
	});

	it("N: a call with a space before the parenthesis is not counted by the inner scanner", () => {
		// countTopLevelBooleanArgs's own call-start regex requires `\w\s*\(` with
		// no interior boundary; a mutant narrowing it to require a NON-whitespace
		// character between the identifier and `(` fails to match "call (" and
		// undercounts to 0 — still below the 2-boolean threshold either way, but
		// this fixture is paired with the next one to bracket the boundary.
		expect(checkBooleanTrap("call (true, false);", "f.ts")).toEqual([
			{ line: 1, text: "call (true, false);" },
		]);
	});
});

describe("checkBooleanTrap — nested-structure depth tracking", () => {
	it("N: a nested array argument is not split into top-level booleans", () => {
		// Only "real" (not "true"/"false") remains after the array collapses to
		// one non-boolean top-level arg — total top-level bool count is 0.
		expect(checkBooleanTrap("configure([true, false], real);", "f.ts")).toEqual([]);
	});

	it("N: a nested object argument is not split into top-level booleans", () => {
		expect(checkBooleanTrap("configure({ a: true, b: false }, real);", "f.ts")).toEqual([]);
	});

	it("P: two top-level booleans alongside a nested array/object argument still trip the trap", () => {
		const code = "configure([1, 2], { a: 1 }, true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});

	it("N: a partial identifier containing 'true'/'false' as a substring is not counted", () => {
		expect(checkBooleanTrap("configure(trueValue, falseValue);", "f.ts")).toEqual([]);
	});

	it("P: three top-level booleans in one call all count toward the threshold", () => {
		const code = "configure(true, false, true);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
});

describe("checkFunctionArity — extension gate and param-count boundary", () => {
	it("P: recognizes every JS/TS-family extension with the 5-param threshold", () => {
		const code = "function f(a,b,c,d,e) { return a; }";
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]) {
			expect(checkFunctionArity(code, `f${ext}`)).toEqual([
				{ line: 1, text: "[5 params → consider options object] function f(a,b,c,d,e) { return a; }" },
			]);
		}
	});

	it("N: does not fire on an unlisted extension", () => {
		const code = "function f(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.py")).toEqual([]);
	});

	it("P: recognizes .rs at the non-Go 5-param threshold", () => {
		const code = "fn f(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		const matches = checkFunctionArity(code, "f.rs");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("N: exactly 4 params is under the threshold", () => {
		const code = "function f(a,b,c,d) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});

	it("P: exactly 5 params is the threshold boundary and fires", () => {
		const code = "function f(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] function f(a,b,c,d,e) { return a; }" },
		]);
	});

	it("N: Go at exactly 5 params is under its own 6-param threshold", () => {
		const code = "func F(a int, b int, c int, d int, e int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([]);
	});

	it("P: Go at exactly 6 params meets its own threshold", () => {
		const code = "func F(a int, b int, c int, d int, e int, f int) {}";
		const matches = checkFunctionArity(code, "f.go");
		expect(matches).toHaveLength(1);
	});

	it("N: an arrow function head with no space before the identifier does not match a mutated identifier-boundary pattern", () => {
		const code = "export const build = (a,b,c,d,e) => a;";
		const matches = checkFunctionArity(code, "f.ts");
		expect(matches).toEqual([
			{ line: 1, text: "[5 params → consider options object] export const build = (a,b,c,d,e) => a;" },
		]);
	});

	it("N: a generic function `function f<T>(...)` is still recognized (angle-bracket block skipped)", () => {
		const code = "function f<T>(a,b,c,d,e) { return a; }";
		const matches = checkFunctionArity(code, "f.ts");
		expect(matches).toHaveLength(1);
	});

	it("truncates the reported text to exactly 100 characters after the prefix", () => {
		const params = Array.from({ length: 6 }, (_, i) => `param${i}: string`).join(", ");
		const code = `function f(${params}) { return 1; }`;
		const matches = checkFunctionArity(code, "f.ts");
		expect(matches).toEqual([
			{
				line: 1,
				text: `[6 params → consider options object] ${code.trim().slice(0, 100)}`,
			},
		]);
	});
});

describe("checkPositionalOptionalBoolean — exact shapes and boundaries", () => {
	it("P: `flag?: boolean` produces the exact offender-tagged text", () => {
		const code = "export function setUser(name: string, force?: boolean) { return name; }";
		expect(checkPositionalOptionalBoolean(code, "user.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: force] ${code.slice(0, 120)}` },
		]);
	});

	it("P: `flag: boolean = false` (typed default) produces the exact offender-tagged text", () => {
		const code = "export function configure(host: string, verbose: boolean = false) { return host; }";
		expect(checkPositionalOptionalBoolean(code, "cfg.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: verbose] ${code.slice(0, 120)}` },
		]);
	});

	it("P: `flag = false` (inferred default) produces the exact offender-tagged text", () => {
		const code = "function send(msg: string, retry = true) { return msg; }";
		expect(checkPositionalOptionalBoolean(code, "send.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: retry] ${code.slice(0, 120)}` },
		]);
	});

	it("N: `flag: boolean = maybe()` (non-literal default) does not fire", () => {
		const code = "function send(msg: string, retry: boolean = maybe()) { return msg; }";
		expect(checkPositionalOptionalBoolean(code, "send.ts")).toEqual([]);
	});

	it("N: `flag = maybe()` (non-literal, no annotation) does not fire", () => {
		const code = "function send(msg: string, retry = maybe()) { return msg; }";
		expect(checkPositionalOptionalBoolean(code, "send.ts")).toEqual([]);
	});

	it("N: `flag ?: boolean` with a space before the colon still fires (optional whitespace is allowed)", () => {
		const code = "function g(flag ?: boolean) { return flag; }";
		const matches = checkPositionalOptionalBoolean(code, "g.ts");
		expect(matches).toHaveLength(1);
	});
});

describe("checkManyOptionalParams — exact 3-optional boundary", () => {
	it("N: exactly 2 optional params is under the threshold", () => {
		const code = "function h(a?: number, b?: number, c: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	it("P: exactly 3 optional params meets the threshold with the exact reported count", () => {
		const code = "function h(a?: number, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: `[3 optional params → consider options object] ${code}`,
			},
		]);
	});

	it("N: a rest param does not count toward optionality even with a default-looking sibling", () => {
		const code = "function h(a?: number, b?: number, ...rest: number[]) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	it("P: a mix of `?:` and `=` defaults both count toward the 3 threshold", () => {
		const code = "function h(a?: number, b = 1, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: `[3 optional params → consider options object] ${code}`,
			},
		]);
	});

	it("N: an arrow-type-annotated required param (`cb: () => void`) is not miscounted as optional via its `=>`", () => {
		const code = "function h(a?: number, b?: number, cb: () => void) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	it("truncates the reported text to exactly 100 characters after the prefix", () => {
		const params = Array.from({ length: 4 }, (_, i) => `p${i}?: string`).join(", ") + ", extra: string";
		const code = `function h(${params}) {}`;
		const matches = checkManyOptionalParams(code, "f.ts");
		expect(matches).toEqual([
			{
				line: 1,
				text: `[4 optional params → consider options object] ${code.trim().slice(0, 100)}`,
			},
		]);
	});
});

describe("checkCatchAndIgnore — exact return-value alternation and handled-body detection", () => {
	for (const [label, ret] of [
		["null", "null"],
		["undefined", "undefined"],
		["false", "false"],
		["true", "true"],
		["single-quoted empty string", "''"],
		["double-quoted empty string", '""'],
		["template empty string", "``"],
		["empty array", "[]"],
		["empty object", "{}"],
		["zero", "0"],
		["negative one", "-1"],
		["void 0", "void 0"],
	] as const) {
		it(`P: flags a bare 'return ${label}' default-swallow`, () => {
			const code = `try { doWork(); } catch (e) { return ${ret}; }`;
			expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
		});
	}

	it("N: a non-listed return value (e.g. a string with content) does not fire", () => {
		const code = 'try { doWork(); } catch (e) { return "fallback"; }';
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});

	it("N: a numeric return value other than 0/-1 does not fire", () => {
		const code = "try { doWork(); } catch (e) { return 42; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});

	for (const keyword of [
		"console.error(e)",
		"logWarning(e)",
		"logger.warn(e)",
		"throw e",
		"emit(e)",
		"warnAbout(e)",
		"reportError(e)",
		"notify(e)",
	] as const) {
		it(`N: a catch body containing '${keyword}' is treated as handled and not flagged`, () => {
			const code = `try { doWork(); } catch (e) { ${keyword}; return null; }`;
			expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
		});
	}

	it("N: a bare 'error' identifier anywhere in the body is treated as handled", () => {
		const code = "try { doWork(); } catch (e) { const error = e; return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});

	it("P: does not treat an unrelated word containing 'error' as a substring match false-negative pathway differently — sanity double check", () => {
		// 'error' is matched with \b...\b so a real identifier boundary is required;
		// this just re-confirms the positive path with an explicit non-matching body.
		const code = "try { doWork(); } catch (e) { doOther(); return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});

	it("recognizes every listed extension with an exact match", () => {
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
			const code = "try { doWork(); } catch (e) { return null; }";
			expect(checkCatchAndIgnore(code, `f${ext}`)).toEqual([{ line: 1, text: code }]);
		}
	});

	it("N: does not fire on an unlisted extension", () => {
		const code = "try { doWork(); } catch (e) { return null; }";
		expect(checkCatchAndIgnore(code, "f.py")).toEqual([]);
	});

	it("P: multi-line catch bodies are collected up to the matching closing brace", () => {
		const code = ["try {", "  doWork();", "} catch (e) {", "  const x = 1;", "  return null;", "}"].join(
			"\n",
		);
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});

	it("N: an explanatory comment in the original source suppresses the flag even with a bare default return", () => {
		const code = [
			"try {",
			"  doWork();",
			"} catch (e) {",
			"  // intentional: caller treats null as absent",
			"  return null;",
			"}",
		].join("\n");
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
});

describe("checkPositionalOptionalBoolean / checkManyOptionalParams — extension gate", () => {
	it("checkPositionalOptionalBoolean recognizes every listed extension", () => {
		for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
			const code = "function g(flag?: boolean) {}";
			expect(checkPositionalOptionalBoolean(code, `f${ext}`)).toEqual([
				{ line: 1, text: `[positional optional boolean: flag] ${code}` },
			]);
		}
	});

	it("checkPositionalOptionalBoolean does not fire on an unlisted extension", () => {
		expect(checkPositionalOptionalBoolean("function g(flag?: boolean) {}", "f.rs")).toEqual([]);
	});

	it("checkManyOptionalParams recognizes every listed extension", () => {
		for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
			const code = "function h(a?: number, b?: number, c?: number) {}";
			expect(checkManyOptionalParams(code, `f${ext}`)).toEqual([
				{ line: 1, text: `[3 optional params → consider options object] ${code}` },
			]);
		}
	});

	it("checkManyOptionalParams does not fire on an unlisted extension", () => {
		const code = "function h(a?: number, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.rs")).toEqual([]);
	});
});

describe("shared signature-parsing helpers — function-start pattern precision", () => {
	// These fixtures exercise JS_TS_FUNC_PATTERNS (used by checkPositionalOptionalBoolean
	// / checkManyOptionalParams) via a multi-char function name (kills `\w+`→`\w`
	// single-char-capture mutants, since a 1-char name can't distinguish them),
	// a doubled interior space (kills `\s+`→`\s` exact-one-whitespace mutants),
	// and a multi-char generic parameter (kills `[^>]*`→`[^>]` single-char mutants).

	it("P: a multi-char function name with a double space before it still matches", () => {
		const code = "function  createWidget(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: flag] ${code}` },
		]);
	});

	it("P: a multi-char generic parameter is fully consumed before the params", () => {
		const code = "function createWidget<KV>(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: flag] ${code}` },
		]);
	});

	it("P: an arrow-assigned const with a double space before the identifier still matches", () => {
		const code = "const  createWidget = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: flag] ${code}` },
		]);
	});

	it("P: an arrow-assigned const with a type annotation containing a double space still matches", () => {
		const code = "const createWidget:  Handler = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: flag] ${code}` },
		]);
	});

	it("P: an arrow-assigned const with a double space before '=' still matches", () => {
		const code = "const createWidget  = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: flag] ${code}` },
		]);
	});

	it("P: an async arrow-assigned const with a double space after 'async' still matches", () => {
		const code = "const createWidget = async  (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: `[positional optional boolean: flag] ${code}` },
		]);
	});
});

describe("checkFunctionArity — local funcPatterns precision (function/arrow/func/fn)", () => {
	it("P: a multi-char function name with a double space before it still matches", () => {
		const code = "function  createWidget(a,b,c,d,e) { return a; }";
		const matches = checkFunctionArity(code, "f.ts");
		expect(matches).toHaveLength(1);
	});

	it("P: a multi-char generic parameter is fully consumed before the params", () => {
		const code = "function createWidget<KV>(a,b,c,d,e) { return a; }";
		const matches = checkFunctionArity(code, "f.ts");
		expect(matches).toHaveLength(1);
	});

	it("P: an arrow-assigned const with a double space before the identifier still matches", () => {
		const code = "const  createWidget = (a,b,c,d,e) => a;";
		const matches = checkFunctionArity(code, "f.ts");
		expect(matches).toHaveLength(1);
	});

	it("P: a Go function with a double space before the name still matches", () => {
		const code = "func  CreateWidget(a int, b int, c int, d int, e int, f int) {}";
		const matches = checkFunctionArity(code, "f.go");
		expect(matches).toHaveLength(1);
	});

	it("P: a Rust fn with a multi-char name and a double space before it still matches", () => {
		const code = "fn  create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		const matches = checkFunctionArity(code, "f.rs");
		expect(matches).toHaveLength(1);
	});

	it("P: a Rust fn with a multi-char generic parameter still matches", () => {
		const code = "fn create_widget<KV>(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		const matches = checkFunctionArity(code, "f.rs");
		expect(matches).toHaveLength(1);
	});

	it("P: a pub async Rust fn still matches", () => {
		const code = "pub async fn create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		const matches = checkFunctionArity(code, "f.rs");
		expect(matches).toHaveLength(1);
	});
});

describe("shared signature-parsing helpers — bracket depth tracking", () => {
	// extractParamStr / splitTopLevelParams / isOptionalParam all track
	// <>(){}[] depth with the same shape; these fixtures exercise each bracket
	// type independently, via observable output from the public checks.

	it("N: a generic type argument containing a comma is not split into extra params", () => {
		const code = "function h(a: Map<string, number>, b?: number, c?: number) {}";
		// Only "b" and "c" are optional (2 total) — below the 3-optional threshold.
		// If the comma inside <...> were treated as a top-level separator, "number>"
		// would become a spurious 3rd param and neither shape is optional, OR the
		// count would otherwise shift — either way this pins the correct split.
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	it("P: three real optional params alongside a comma-bearing generic all count correctly", () => {
		const code = "function h(a: Map<string, number>, b?: number, c?: number, d?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: `[3 optional params → consider options object] ${code}`,
			},
		]);
	});

	it("P: an object-literal default (itself optional via its own top-level '=') alongside two more optionals reaches the threshold", () => {
		// "a = {...}" is itself optional (top-level '='), so this is 3 total:
		// a, b, c — d is intentionally omitted to keep the count exactly at 3.
		const code = "function h(a = { x: 1, y: 2 }, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: `[3 optional params → consider options object] ${code}`,
			},
		]);
	});

	it("N: an array-literal default's internal comma does not fragment the param, but the default itself still counts (2 below threshold with one non-optional sibling)", () => {
		const code = "function h(a = [1, 2, 3], b: number, c: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	it("P: an array-literal default's internal comma does not fragment the param — its own '=' still counts toward the threshold", () => {
		const code = "function h(a = [1, 2, 3], b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: `[3 optional params → consider options object] ${code}`,
			},
		]);
	});

	it("N: a call-expression default value's internal comma does not fragment the param", () => {
		const code = "function h(a = compute(1, 2), b: number, c: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	it("P: a call-expression default value's internal comma does not fragment the param — its own '=' still counts", () => {
		const code = "function h(a = compute(1, 2), b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: `[3 optional params → consider options object] ${code}`,
			},
		]);
	});
});

