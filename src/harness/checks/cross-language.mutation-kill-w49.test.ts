// Mutation-kill suite for src/harness/checks/cross-language.ts (wave pass1_w49).
// Each test isolates one regex/conditional mutation listed in the w49 brief by
// constructing a line whose classification (safe vs SQL-injection sink) flips
// under that exact mutation but not under the unmutated source.

import { describe, expect, it } from "vitest";
import { checkSqlInjection } from "./cross-language.js";

function flagged(content: string, filePath: string): boolean {
	return checkSqlInjection(content, filePath).length > 0;
}

describe("checkSqlInjection — JS/TS safe-interpolation guards (isSafeJsTemplateInterpolation)", () => {
	// test-contract: bug — mutant d2b68fb350db88a9/38a35945db49ee81 would classify
	// this PRAGMA introspection call as a SQL-injection sink (false positive).
	it("PRAGMA guard: recognizes PRAGMA followed by whitespace as safe (d2b68fb350db88a9, 38a35945db49ee81)", () => {
		const line = "conn.query(`PRAGMA foo ${x}`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 567c12834bddbeef loosens \s+ to \s, which would
	// falsely require exactly one whitespace char and misclassify this DDL as unsafe.
	it("DDL guard requires one-or-more whitespace between ALTER/DROP/CREATE and TABLE/INDEX/TRIGGER (567c12834bddbeef)", () => {
		// Two spaces: \s+ matches, a bare \s would leave a stray space unconsumed.
		const line = "conn.query(`ALTER  TABLE foo ${x}`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 36b06fa11cd972b4 swaps \s* for \S* after ${,
	// which would reject this code-controlled SQL-fragment helper call as unsafe.
	it("SQL-fragment function-call guard allows whitespace right after ${ (36b06fa11cd972b4)", () => {
		const line = "conn.query(`SELECT ${ FILTER_FUNC()} FROM t`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 498507e0d9dbe328 swaps \s* for \S* before the
	// call paren, which would reject this SQL-fragment helper call as unsafe.
	it("SQL-fragment function-call guard allows whitespace before the opening paren (498507e0d9dbe328)", () => {
		const line = "conn.query(`SELECT ${FILTER_FUNC ()} FROM t`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant f3ca98189e517ade swaps \s* for \S* before the
	// .join() call paren, which would reject this code-controlled column list as unsafe.
	it("dynamic-column .join() guard allows whitespace before the opening paren (f3ca98189e517ade)", () => {
		const line = "conn.query(`SELECT ${cols.join ()} FROM t`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 94c1badad1941069 swaps \s* for \S* between VALUES
	// and (, which would reject this FTS-rebuild pattern as unsafe.
	it("FTS rebuild guard allows whitespace between VALUES and the opening paren (94c1badad1941069)", () => {
		const line = "conn.query(`INSERT INTO t ${x} VALUES ('rebuild')`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 7b6b4b694ffd47dd swaps \s* for \S* between ( and
	// 'rebuild', which would reject this FTS-rebuild pattern as unsafe.
	it("FTS rebuild guard allows whitespace between the opening paren and 'rebuild' (7b6b4b694ffd47dd)", () => {
		const line = "conn.query(`INSERT INTO t ${x} VALUES( 'rebuild')`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 899747ffdfbf80f4 swaps \s* for \S* between
	// 'rebuild' and ), which would reject this FTS-rebuild pattern as unsafe.
	it("FTS rebuild guard allows whitespace between 'rebuild' and the closing paren (899747ffdfbf80f4)", () => {
		const line = "conn.query(`INSERT INTO t ${x} VALUES('rebuild' )`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant 2d35bbde258a8d57 swaps \w* for \W* before the
	// table/column alternation, which would reject this code-controlled identifier as unsafe.
	it("table/column identifier guard: \\w* before the alternation must consume word chars (2d35bbde258a8d57)", () => {
		const line = "conn.query(`SELECT ${my_table} FROM t`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant a0adc56458f2de3e swaps \s* for \S* after ${,
	// which would reject this code-controlled identifier as unsafe.
	it("table/column identifier guard allows whitespace right after ${ (a0adc56458f2de3e)", () => {
		const line = "conn.query(`SELECT ${ tableName} FROM t`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});

	// test-contract: bug — mutant d1bf0234c0c226ff swaps \s* for \S* before },
	// which would reject this code-controlled identifier as unsafe.
	it("table/column identifier guard allows trailing whitespace before } (d1bf0234c0c226ff)", () => {
		const line = "conn.query(`SELECT ${tbl } FROM t`)";
		expect(flagged(line, "db.ts")).toBe(false);
	});
});

describe("checkSqlInjection — Swift interpolation sink (isSwiftInterpolationSink)", () => {
	// test-contract: bug — mutant 0a074f1a375b60b8 swaps \s* for \S* after the
	// execute() call paren, which would miss this genuine Swift interpolation sink.
	it("execute-family regex allows whitespace after the opening paren (0a074f1a375b60b8)", () => {
		const line = 'db.execute( "SELECT * FROM t WHERE id = \\(userId)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant 209a29db5469bd40 swaps \s* for \S* before the
	// execute() call paren, which would miss this genuine Swift interpolation sink.
	it("execute-family regex allows whitespace before the opening paren (209a29db5469bd40)", () => {
		const line = 'db.execute ("SELECT * FROM t WHERE id = \\(userId)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant 961e974c2c6f9c61 swaps \s* for \S* between sql
	// and : in the named-arg form, which would miss this genuine interpolation sink.
	it("execute-family regex allows whitespace between sql and : in the named arg (961e974c2c6f9c61)", () => {
		const line = 'db.execute(sql : "SELECT * FROM t WHERE id = \\(userId)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant 2747c4a31c8289f2 tightens \s* to a mandatory \s
	// after :, which would miss this genuine interpolation sink with zero spaces.
	it("execute-family regex allows zero-or-more whitespace between : and the quote (2747c4a31c8289f2)", () => {
		const line = 'db.execute(sql:"SELECT * FROM t WHERE id = \\(userId)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant 0d339556ad46261f swaps \s* for \S* after the
	// NSPredicate call paren, which would miss this genuine interpolation sink.
	it("NSPredicate regex allows whitespace after the opening paren (0d339556ad46261f)", () => {
		const line = 'NSPredicate( format: "name == \\(name)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant 23c0f5e10d11852a swaps \s* for \S* before the
	// NSPredicate call paren, which would miss this genuine interpolation sink.
	it("NSPredicate regex allows whitespace before the opening paren (23c0f5e10d11852a)", () => {
		const line = 'NSPredicate (format: "name == \\(name)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant 683cf574b8158525 tightens \s* to a mandatory \s
	// after :, which would miss this genuine interpolation sink with zero spaces.
	it("NSPredicate regex allows zero-or-more whitespace between : and the quote (683cf574b8158525)", () => {
		const line = 'NSPredicate(format:"name == \\(name)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});

	// test-contract: bug — mutant bc96aadad9b5867a swaps \s* for \S* between format
	// and :, which would miss this genuine interpolation sink.
	it("NSPredicate regex allows whitespace between format and : (bc96aadad9b5867a)", () => {
		const line = 'NSPredicate(format : "name == \\(name)")';
		expect(flagged(line, "db.swift")).toBe(true);
	});
});

describe("checkSqlInjection — outer dispatch (isSqlInjectionLine)", () => {
	// test-contract: bug — mutant 57931b5806507033 swaps \s* for \S* before the
	// call paren, which would miss this genuine JS/TS template-interpolation sink.
	it("JS-family sink regex allows whitespace before the opening paren (57931b5806507033)", () => {
		const line = "conn.query (`SELECT * FROM t WHERE id = ${userInput}`)";
		expect(flagged(line, "db.ts")).toBe(true);
	});

	// test-contract: bug — mutant 37048781c203a1c6 swaps \s* for \S* after the
	// call paren, which would miss this genuine JS/TS template-interpolation sink.
	it("JS-family sink regex allows whitespace after the opening paren, before the backtick (37048781c203a1c6)", () => {
		const line = "conn.query( `SELECT * FROM t WHERE id = ${userInput}`)";
		expect(flagged(line, "db.ts")).toBe(true);
	});

	// test-contract: boundary — mutant e92b8763d37861d8 replaces `ext === ".py"`
	// with `true`, which would make a non-.py file with this shape a false positive.
	it("python branch is gated on ext === '.py', not on any other extension (e92b8763d37861d8)", () => {
		// Matches the python f-string sink pattern but the file is NOT .py —
		// the unmutated code must not take the python branch for this file.
		const line = 'cursor.execute(f"SELECT * FROM t WHERE id={x}")';
		expect(flagged(line, "db.java")).toBe(false);
	});

	// test-contract: bug — mutant 6587d260ec31748d swaps \s* for \S* before the
	// call paren, which would miss this genuine Python f-string SQL sink.
	it("python f-string regex allows whitespace before the opening paren (6587d260ec31748d)", () => {
		const line = 'cursor.execute (f"SELECT * FROM t WHERE id={x}")';
		expect(flagged(line, "db.py")).toBe(true);
	});

	// test-contract: bug — mutant d9647327b191ffdf swaps \s* for \S* between the
	// call paren and the f-prefix, which would miss this genuine Python f-string sink.
	it("python f-string regex allows whitespace between the opening paren and the f-prefix (d9647327b191ffdf)", () => {
		const line = 'cursor.execute( f"SELECT * FROM t WHERE id={x}")';
		expect(flagged(line, "db.py")).toBe(true);
	});

	// test-contract: boundary — mutant 69a8c6bfdd9845ce replaces `ext === ".swift"`
	// with `true`, which would make a non-.swift file with this shape a false positive.
	it("swift branch is gated on ext === '.swift', not on any other extension (69a8c6bfdd9845ce)", () => {
		// Matches the swift interpolation sink pattern but the file is NOT .swift —
		// the unmutated code must not take the swift branch for this file, and the
		// line has no '+' concatenation so the generic fallback doesn't fire either.
		const line = 'db.execute("SELECT * FROM t WHERE id = \\(userId)")';
		expect(flagged(line, "db.java")).toBe(false);
	});

	// test-contract: bug — mutant 93afa7aa5551532a swaps \s* for \S* before the
	// call paren, which would miss this genuine string-concatenation SQL sink.
	it("generic concatenation regex allows whitespace before the opening paren (93afa7aa5551532a)", () => {
		const line = 'db.execute ("SELECT * FROM users WHERE id=" + userId)';
		expect(flagged(line, "db.java")).toBe(true);
	});

	// test-contract: bug — mutant b35c7bd661c5294c swaps \s* for \S* after the
	// call paren, which would miss this genuine string-concatenation SQL sink.
	it("generic concatenation regex allows whitespace after the opening paren (b35c7bd661c5294c)", () => {
		const line = 'db.execute( "SELECT * FROM users WHERE id=" + userId)';
		expect(flagged(line, "db.java")).toBe(true);
	});

	// test-contract: bug — mutant 519c97bc25a6f951 tightens \s* to a mandatory \s
	// before +, which would miss this genuine sink with zero spaces before the +.
	it("generic concatenation regex allows zero-or-more whitespace before the + (519c97bc25a6f951)", () => {
		const line = 'db.execute("SELECT * FROM users WHERE id="+userId)';
		expect(flagged(line, "db.java")).toBe(true);
	});
});
