// Tests for `ubs_sql_string_concat` (Plan 04 D.1 partial).
// Detects SQL keywords inside a quoted string immediately followed by
// JS/Py concatenation or template-literal interpolation — the canonical
// SQL-injection shape.

import { describe, expect, it } from "vitest";
import { checkSqlStringConcat } from "../checks/ubs-language-specific.js";

describe("checkSqlStringConcat", () => {
	it("flags template-literal SQL with `${...}` interpolation", () => {
		const code =
			"const sql = `SELECT * FROM users WHERE id = ${" + "userId}`;";
		const matches = checkSqlStringConcat(code, "src/db.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags string-+ concatenation: `\"SELECT \" + col`", () => {
		const code = 'const sql = "SELECT " + col + " FROM users";';
		const matches = checkSqlStringConcat(code, "src/db.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Python f-string-style concatenation", () => {
		const code = 'sql = "DELETE FROM users WHERE id = " + str(user_id)';
		const matches = checkSqlStringConcat(code, "src/db.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag parameterized queries", () => {
		// Parameter placeholders like $1 / ? / :name don't trigger because no
		// `+` or template interpolation appears next to the SQL string.
		const code = 'db.query("SELECT * FROM users WHERE id = $1", [id]);';
		expect(checkSqlStringConcat(code, "src/db.ts")).toEqual([]);
	});

	it("does NOT flag a plain SQL constant", () => {
		const code = 'const PING_QUERY = "SELECT 1";';
		expect(checkSqlStringConcat(code, "src/db.ts")).toEqual([]);
	});

	// FP regression: a comma INSIDE the SQL string literal (column list) must
	// not be read as JS concatenation. The concat/interp token must be adjacent
	// to the string DELIMITER, not buried in the literal.
	it("does NOT flag a column list with a comma inside the literal", () => {
		const code =
			'const rows = await db.query("SELECT id, name FROM users");';
		expect(checkSqlStringConcat(code, "src/db.ts")).toEqual([]);
	});

	it("does NOT flag a multi-column SELECT with placeholder", () => {
		const code = 'db.query("SELECT a, b, c FROM t WHERE x = ?", [x]);';
		expect(checkSqlStringConcat(code, "src/db.ts")).toEqual([]);
	});

	it("does NOT flag aggregate columns with a comma in the literal", () => {
		const code = 'const q = "SELECT COUNT(*), MAX(id) FROM t";';
		expect(checkSqlStringConcat(code, "src/db.ts")).toEqual([]);
	});

	it("flags string-+ injection with quote adjacent to +", () => {
		const code = 'const sql = "SELECT * FROM users WHERE id = " + userId;';
		expect(checkSqlStringConcat(code, "src/db.ts").length).toBeGreaterThan(0);
	});

	it("flags split-literal injection: `'\" + name + \"'`", () => {
		const code =
			'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";';
		expect(checkSqlStringConcat(code, "src/db.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire on `.md` documentation files", () => {
		const code = "Example: `SELECT * FROM users WHERE id = ${id}`";
		expect(checkSqlStringConcat(code, "docs/sql.md")).toEqual([]);
	});

	it("skips test files", () => {
		const code =
			'const sql = "SELECT * FROM t WHERE id = " + id;';
		expect(checkSqlStringConcat(code, "src/db.test.ts")).toEqual([]);
	});
});
