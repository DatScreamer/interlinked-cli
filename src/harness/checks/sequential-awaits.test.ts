import { describe, expect, it } from "vitest";
import { checkSequentialAwaits } from "./sequential-awaits.js";

const TS = "src/lib/orders.ts";

describe("checkSequentialAwaits — extension and test-file gating", () => {
	it("returns no matches for non-JS/TS extensions even with independent awaits", () => {
		const code = ["const a = await fetchA();", "const b = await fetchB();"].join("\n");
		// .py is not in JS_TS_EXTS, so the extension gate (line 17) returns [].
		expect(checkSequentialAwaits(code, "src/lib/orders.py")).toEqual([]);
		expect(checkSequentialAwaits(code, "src/lib/orders.go")).toEqual([]);
		expect(checkSequentialAwaits(code, "README")).toEqual([]);
	});

	it("returns no matches for test files even with independent awaits", () => {
		const code = ["const a = await fetchA();", "const b = await fetchB();"].join("\n");
		// isTestFile gate (line 18) short-circuits genuine test paths.
		expect(checkSequentialAwaits(code, "src/lib/orders.test.ts")).toEqual([]);
		expect(checkSequentialAwaits(code, "src/lib/orders.spec.ts")).toEqual([]);
		expect(checkSequentialAwaits(code, "src/__tests__/orders.ts")).toEqual([]);
	});

	it("runs on each JS/TS extension variant (sanity that the set is honored)", () => {
		const code = ["const a = await fetchA();", "const b = await fetchB();"].join("\n");
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]) {
			const out = checkSequentialAwaits(code, `src/lib/orders${ext}`);
			expect(out).toHaveLength(1);
		}
	});
});

describe("checkSequentialAwaits — independent sequential awaits (positive)", () => {
	it("flags two consecutive independent awaits and reports the FIRST line", () => {
		const code = ["const a = await fetchA();", "const b = await fetchB();"].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		// Reported line is the previous (first) await's 1-based line number.
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toContain("sequential independent awaits — consider Promise.all");
		expect(out[0]?.text).toContain("const a = await fetchA();");
	});

	it("flags a chain of three independent awaits as two matches (lines 1 and 2)", () => {
		const code = [
			"const a = await fetchA();",
			"const b = await fetchB();",
			"const c = await fetchC();",
		].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.line)).toEqual([1, 2]);
	});

	it("recognizes let and var declarations, not just const", () => {
		const letCode = ["let a = await fetchA();", "let b = await fetchB();"].join("\n");
		const varCode = ["var a = await fetchA();", "var b = await fetchB();"].join("\n");
		expect(checkSequentialAwaits(letCode, TS)).toHaveLength(1);
		expect(checkSequentialAwaits(varCode, TS)).toHaveLength(1);
	});

	it("flags indented awaits and reports the un-trimmed line position", () => {
		const code = [
			"async function load() {",
			"  const a = await fetchA();",
			"  const b = await fetchB();",
			"}",
		].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		// The two awaits are on source lines 2 and 3; the first is reported.
		expect(out[0]?.line).toBe(2);
		// Reported text is trimmed even though the source line was indented.
		expect(out[0]?.text).toContain("const a = await fetchA();");
		expect(out[0]?.text).not.toContain("  const a");
	});

	it("truncates the reported snippet to 100 chars of the trimmed line", () => {
		const longExpr = `fetchWith(${"x".repeat(200)})`;
		const code = [`const a = await ${longExpr};`, "const b = await fetchB();"].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		const text = out[0]?.text ?? "";
		const prefix = "[sequential independent awaits — consider Promise.all] ";
		// Everything after the prefix is the line snippet, capped at 100 chars.
		const snippet = text.slice(prefix.length);
		expect(snippet.length).toBe(100);
	});
});

describe("checkSequentialAwaits — dependent awaits (negative)", () => {
	it("does NOT flag when the second await references the first's variable", () => {
		const code = ["const user = await getUser();", "const orders = await getOrders(user);"].join(
			"\n",
		);
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does NOT flag a chain where each await depends on the prior variable", () => {
		const code = [
			"const a = await getA();",
			"const b = await getB(a);",
			"const c = await getC(b);",
		].join("\n");
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("flags only the independent pair in a mixed chain", () => {
		const code = [
			"const a = await getA();", // line 1 — independent vs nothing before
			"const b = await getB();", // line 2 — independent of a -> flag at line 1
			"const c = await getC(b);", // line 3 — depends on b -> no flag at line 2
		].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
	});

	it("treats any literal substring occurrence of the variable as a dependency", () => {
		// The dependency test is a raw `expr.includes(prevVarName)` — case-
		// sensitive, not token-aware. Here `id` appears literally inside
		// `getByid(...)`, so the pair is treated as dependent and NOT flagged.
		const code = ["const id = await getId();", "const row = await getByid();"].join("\n");
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does flag when a same-cased-but-distinct token is not a substring", () => {
		// `getById` (capital I) does NOT contain lowercase `id`, so includes()
		// is false and the pair is correctly flagged as independent — the mirror
		// of the case-sensitive behavior above.
		const code = ["const id = await getId();", "const row = await getById();"].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
	});
});

describe("checkSequentialAwaits — non-consecutive / state reset", () => {
	it("does NOT flag two independent awaits separated by a blank line", () => {
		const code = ["const a = await fetchA();", "", "const b = await fetchB();"].join("\n");
		// The blank line is a non-match -> resets prevVarName (else branch),
		// and prevLineIdx !== i-1, so no pairing happens.
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does NOT flag two independent awaits separated by a non-await statement", () => {
		const code = [
			"const a = await fetchA();",
			"doSomethingSync();",
			"const b = await fetchB();",
		].join("\n");
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("resumes flagging after a reset when two new awaits become adjacent", () => {
		const code = [
			"const a = await fetchA();", // line 1
			"sideEffect();", // line 2 — reset
			"const b = await fetchB();", // line 3
			"const c = await fetchC();", // line 4 — adjacent to b, independent -> flag at line 3
		].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(3);
	});

	it("does not flag a single lone await", () => {
		expect(checkSequentialAwaits("const a = await fetchA();", TS)).toEqual([]);
	});

	it("does not flag an empty file", () => {
		expect(checkSequentialAwaits("", TS)).toEqual([]);
	});

	it("does not flag lines that are not await-assignments", () => {
		const code = [
			"function noop() {}",
			"const x = compute();",
			"return x + 1;",
		].join("\n");
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});
});

describe("checkSequentialAwaits — interactive I/O exemption", () => {
	it("does NOT flag when the PREVIOUS await is an interactive prompt()", () => {
		const code = ["const name = await prompt('Name?');", "const age = await fetchAge();"].join(
			"\n",
		);
		// prevExpr matches the prompt() guard (line 38) -> continue, no push.
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does NOT flag when the CURRENT await is an interactive prompt()", () => {
		const code = ["const cfg = await loadConfig();", "const name = await prompt('Name?');"].join(
			"\n",
		);
		// currentExpr matches the prompt() guard (line 39) -> continue, no push.
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does NOT flag readline-based reads (previous line)", () => {
		const code = ["const line = await readline.question('> ');", "const data = await load();"].join(
			"\n",
		);
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does NOT flag question()-based reads on the current line", () => {
		const code = ["const data = await load();", "const ans = await rl.question('ok? ');"].join(
			"\n",
		);
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("DOES flag two independent non-interactive awaits (guard is specific)", () => {
		// Control: confirms the interactive guard isn't suppressing ordinary
		// network/db awaits. "promptly" would falsely match a naive substring,
		// so use plainly-named calls.
		const code = ["const a = await fetchA();", "const b = await fetchB();"].join("\n");
		expect(checkSequentialAwaits(code, TS)).toHaveLength(1);
	});
});

describe("checkSequentialAwaits — regex edge cases", () => {
	it("matches an await statement without a trailing semicolon", () => {
		// The `;?` in the pattern makes the semicolon optional.
		const code = ["const a = await fetchA()", "const b = await fetchB()"].join("\n");
		const out = checkSequentialAwaits(code, TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
	});

	it("does not match assignments that are not awaits", () => {
		const code = ["const a = fetchA();", "const b = fetchB();"].join("\n");
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});

	it("does not match await expression statements lacking a binding", () => {
		// `await foo();` (no const/let/var) does not match the pattern.
		const code = ["await fetchA();", "await fetchB();"].join("\n");
		expect(checkSequentialAwaits(code, TS)).toEqual([]);
	});
});
