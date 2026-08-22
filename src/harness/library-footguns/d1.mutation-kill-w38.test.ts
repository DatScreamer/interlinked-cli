// Mutation-kill suite for src/harness/library-footguns/d1.ts (wave 38).
// Targets 33 survivor mutants across shouldSkip(), detectExecStringConcat(),
// the D1_EXEC_INTERPOLATED_RE regex, and the D1_FOOTGUNS module metadata.

import { describe, expect, it } from "vitest";
import { D1_FOOTGUNS } from "./d1.js";

function find(id: string) {
	const f = D1_FOOTGUNS.find((g) => g.id === id);
	if (!f) throw new Error(`footgun ${id} not registered`);
	return f;
}

const fg = find("d1_exec_string_concat");

describe("d1_exec_string_concat — shouldSkip gating (positive: must skip)", () => {
	// test-contract: boundary — non-JS/TS extension must be skipped even
	// when the content contains a matching D1 pattern; kills the
	// BlockStatement/ConditionalExpression/BooleanLiteral mutants on the
	// extension-check branch and the shouldSkip-call-site conditional.
	it("does NOT fire on a non-JS/TS file even with matching content", () => {
		const content = 'await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);';
		expect(fg.detect(content, "notes/query.txt")).toEqual([]);
	});

	// test-contract: boundary — test files are skipped even with matching content;
	// kills the isTestFile ConditionalExpression/BooleanLiteral mutants.
	it("does NOT fire on a *.test.ts file even with matching content", () => {
		const content = 'await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);';
		expect(fg.detect(content, "src/q.test.ts")).toEqual([]);
	});

	// test-contract: boundary — generated files are skipped even with matching
	// content; kills the isGeneratedFile ConditionalExpression/BooleanLiteral mutants.
	it("does NOT fire on a file carrying a generator marker even with matching content", () => {
		const content =
			"// This file was generated. Do not edit.\nawait env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);";
		expect(fg.detect(content, "src/q.ts")).toEqual([]);
	});
});

describe("d1_exec_string_concat — line/text computation (positive: must fire, exact shape)", () => {
	// test-contract: invariant — pins line number and text extraction exactly.
	// Kills: "\n" -> "" (both split occurrences), content.slice(0,m.index)->content,
	// {line,text}->{}, lineNo-1->lineNo+1, and "||"->"&&" fallback mutants —
	// each of these changes either `line` or `text` (or both) for this input.
	it("reports the exact line number and trimmed/sliced text of the match", () => {
		const content =
			"const a = 1;\nconst b = 2;\nawait env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);\nconst c = 3;";
		const result = fg.detect(content, "src/q.ts");
		expect(result).toEqual([
			{
				line: 3,
				text: "await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);",
			},
		]);
	});

	// test-contract: boundary — text longer than 150 chars must be truncated.
	// Kills the ".slice(0, 150)" removal mutant.
	it("truncates the reported text to 150 characters", () => {
		const longSuffix = "x".repeat(200);
		const line =
			"await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`); // " + longSuffix;
		const result = fg.detect(line, "src/q.ts");
		expect(result).toHaveLength(1);
		const match = result.at(0);
		expect(match?.text).toBe(line.trim().slice(0, 150));
		expect(match?.text.length).toBe(150);
	});

	// test-contract: boundary — leading whitespace on the matched line must be
	// trimmed. Kills the ".trim()" removal mutant.
	it("trims leading whitespace from the reported text", () => {
		const content =
			"if (x) {\n  await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);\n}";
		const result = fg.detect(content, "src/q.ts");
		expect(result).toEqual([
			{
				line: 2,
				text: "await env.DB.exec(`SELECT * FROM u WHERE id = ${userId}`);",
			},
		]);
	});
});

describe("D1_EXEC_INTERPOLATED_RE — regex boundary mutants (positive: must fire)", () => {
	// Kills: env\.\w+ -> env\.\w (single char) and env\.\w+ -> env\.\W+ (non-word).
	// "MYDATABASE" avoids the literal "DB"/"D1" alternatives so only the
	// env\.\w+ branch can produce a match.
	// test-contract: security — D1_EXEC_INTERPOLATED_RE must match arbitrary
	// env.<binding> names, not just the literal "DB"/"D1" aliases.
	it("fires on a multi-char env.<binding> name via the env\\.\\w+ branch", () => {
		const content = 'await env.MYDATABASE.exec("X" + y);';
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: env\[[^\]]+\] -> env\[[^\]]\] (single char) and
	// env\[[^\]]+\] -> env\[[\]]+\] (bracket-content-must-be-"]"). The
	// multi-char, non-"]" bracket key can only match the unmutated class.
	// test-contract: security — the env['KEY'] bracket-access binding form
	// must be detected, not just dotted access.
	it("fires on a bracket-style env['KEY'] binding with a multi-char key", () => {
		const content = "await env['MYKEY'].exec(\"X\" + y);";
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: the \s* immediately after the alternation group (before the
	// literal ".") mutated \s*->\S*. Only a space right there breaks it.
	// test-contract: boundary — whitespace around the binding/dot is
	// cosmetic and must not defeat detection.
	it("fires with whitespace between the binding and the dot", () => {
		const content = 'await env.DB .exec("X" + y);';
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: the \s* between "." and "exec" mutated \s*->\S*.
	// test-contract: boundary — whitespace between the dot and "exec" is
	// cosmetic and must not defeat detection.
	it("fires with whitespace between the dot and exec", () => {
		const content = 'await env.DB. exec("X" + y);';
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: the \s* between "exec" and "(" mutated \s*->\S*.
	// test-contract: boundary — whitespace between "exec" and "(" is
	// cosmetic and must not defeat detection.
	it("fires with whitespace between exec and the opening paren", () => {
		const content = 'await env.DB.exec ("X" + y);';
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: the \s* between "(" and the capture group mutated \s*->\S*.
	// test-contract: boundary — whitespace between "(" and the string arg is
	// cosmetic and must not defeat detection.
	it("fires with whitespace between the opening paren and the string arg", () => {
		const content = 'await env.DB.exec( "X" + y);';
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: the double-quote branch's trailing \s*->\s (exactly one space
	// required). Zero spaces before "+" must still match.
	// test-contract: security — "..."+expr concat with no space is a common
	// injection shape and must still be caught.
	it("fires on a double-quoted concat with zero spaces before the plus", () => {
		const content = 'await env.DB.exec("X"+y);';
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills three single-quote-branch mutants at once: content-class star
	// removed (exactly-one-char), content-class negation removed (only "'"
	// chars), and trailing \s*->\S* (space breaks it). A multi-char,
	// non-quote-character single-quoted string with one space before "+"
	// only matches the unmutated regex on all three counts.
	// test-contract: security — 'literal' + expr concat with realistic
	// multi-word content must still be caught.
	it("fires on a single-quoted concat with multi-char content and a space before the plus", () => {
		const content = "await env.DB.exec('SELECT * FROM u' + y);";
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});

	// Kills: the single-quote branch's trailing \s*->\s (exactly one space
	// required). Zero spaces before "+" must still match.
	// test-contract: security — 'literal'+expr concat with no space is a
	// common injection shape and must still be caught.
	it("fires on a single-quoted concat with zero spaces before the plus", () => {
		const content = "await env.DB.exec('SELECT * FROM u'+y);";
		expect(fg.detect(content, "src/q.ts").length).toBe(1);
	});
});

describe("D1_FOOTGUNS module metadata (positive: must be registered correctly)", () => {
	// test-contract: public-api — pins the registry array shape and its
	// string fields exactly. Kills the ArrayDeclaration->[] mutant and the
	// four StringLiteral->"" mutants on id/name/library/fixInstruction.
	it("registers exactly one D1 footgun with the expected metadata", () => {
		expect(D1_FOOTGUNS).toHaveLength(1);
		const entry = D1_FOOTGUNS.at(0);
		expect(entry?.id).toBe("d1_exec_string_concat");
		expect(entry?.name).toBe("D1 exec() with interpolated SQL");
		expect(entry?.library).toBe("d1");
		expect(entry?.fixInstruction).toContain("prepared-statement form");
		expect(entry?.fixInstruction.length).toBeGreaterThan(50);
	});
});
