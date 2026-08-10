// Evidence suite for the three SQL schema checks (sql-migrations.ts), written
// before the implementation per the red/green gate. Labeled per the Check
// Evidence Contract (P = must fire, N = must not fire).
//
// N1–N4 for checkMigrationOrdering are absorbed verbatim from
// compat-stubs.test.ts (authored 2026-08-09 by the evidence-backfill fleet
// while the detector was still a stub); that file is deleted with the stubs.

import { describe, expect, it } from "vitest";
import {
	checkMigrationOrdering,
	checkSqlSchemaConsistency,
	checkVisibilityFilterMissing,
} from "./sql-migrations.js";

const FILE = "src/do/migrations.ts";

describe("checkMigrationOrdering — positive (must fire)", () => {
	it("P1: CREATE INDEX on a column missing from the same-block CREATE TABLE", () => {
		const content = [
			"sql.exec(`",
			"  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);",
			"`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([
			{ line: 3, text: "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);" },
		]);
	});

	it("P2: composite UNIQUE index where one referenced column is undeclared", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT, state TEXT)`);",
			"sql.exec(`CREATE UNIQUE INDEX idx_jobs ON jobs(state, priority)`);",
		].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P3: fires in a raw .sql migration file too", () => {
		const content = [
			"CREATE TABLE widgets (id TEXT PRIMARY KEY);",
			"CREATE INDEX idx_widgets_owner ON widgets(owner);",
		].join("\n");
		const res = checkMigrationOrdering(content, "migrations/0002_widgets.sql");
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});
});

describe("checkMigrationOrdering — negative (must NOT fire)", () => {
	it("N1: CREATE INDEX on a column already declared in the same-block CREATE TABLE", () => {
		const content = `
sql.exec(\`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
\`);
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N2: addColumnIfNotExists() runs BEFORE CREATE INDEX in a separate sql.exec() call (the recommended fix pattern)", () => {
		const content = `
sql.exec(\`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)\`);
addColumnIfNotExists("users", "email", "TEXT");
sql.exec(\`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)\`);
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N3: CREATE TABLE / CREATE INDEX text appears only inside a comment, not executable migration code", () => {
		const content = `
// Example migration shape (do not copy verbatim):
// CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY);
// CREATE INDEX IF NOT EXISTS idx_widgets_owner ON widgets(owner);
export function noop(): void {}
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N4: file with no SQL migration content at all", () => {
		const content = `
export function add(a: number, b: number): number {
  return a + b;
}
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N5: expression index (parens in the column list) is skipped, never guessed at", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(lower(email))`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N6: index on a table whose CREATE TABLE lives in another file stays silent", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS local_only (id TEXT)`);",
			"sql.exec(`CREATE INDEX idx_remote ON remote_table(anything)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N7: ALTER TABLE ADD COLUMN before the index declares the column", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			"sql.exec(`ALTER TABLE users ADD COLUMN email TEXT`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});
});

describe("checkSqlSchemaConsistency — positive (must fire)", () => {
	it("P1: INSERT column list names a column the same-file CREATE TABLE lacks", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			'sql.exec(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);',
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P2: UPDATE SET targets a column the same-file schema does not declare", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT, name TEXT)`);",
			"sql.exec(`UPDATE users SET nickname = ? WHERE id = ?`, [nick, id]);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P3: fires in a raw .sql file with an undeclared INSERT column", () => {
		const content = [
			"CREATE TABLE logs (id TEXT, at TEXT);",
			"INSERT INTO logs (id, level) VALUES ('a', 'info');",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, "migrations/0003_logs.sql");
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});
});

describe("checkSqlSchemaConsistency — negative (must NOT fire)", () => {
	it("N1: INSERT whose column list matches the declared schema exactly", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT, email TEXT)`);",
			"sql.exec(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N2: UPDATE SET on declared columns only", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT, name TEXT)`);",
			"sql.exec(`UPDATE users SET name = ? WHERE id = ?`, [name, id]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N3: INSERT into a table with no same-file CREATE TABLE stays silent", () => {
		const content = 'sql.exec(`INSERT INTO external_table (whatever) VALUES (1)`);';
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N4: INSERT without a column list carries no checkable reference", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			"sql.exec(`INSERT INTO users VALUES (?)`, [id]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N5: a column declared via addColumnIfNotExists counts as declared", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			'addColumnIfNotExists("users", "email", "TEXT");',
			"sql.exec(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("checkVisibilityFilterMissing — positive (must fire)", () => {
	it("P1: SELECT from a soft-delete table with no deleted_at mention in the statement", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, deleted_at TEXT)`);",
			"const rows = sql.exec(`SELECT id FROM docs WHERE owner = ?`, [owner]);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P2: COUNT query on a soft-delete table without the filter", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, archived_at TEXT)`);",
			"const n = sql.exec(`SELECT COUNT(*) AS n FROM docs`);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P3: is_deleted flag column counts as a soft-delete marker", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT, is_deleted INTEGER)`);",
			"const rows = sql.exec(`SELECT id FROM notes ORDER BY id`);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});
});

describe("checkVisibilityFilterMissing — negative (must NOT fire)", () => {
	it("N1: the statement filters on deleted_at", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, deleted_at TEXT)`);",
			"const rows = sql.exec(`SELECT id FROM docs WHERE deleted_at IS NULL`);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("N2: table without any soft-delete column is out of scope", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, title TEXT)`);",
			"const rows = sql.exec(`SELECT id FROM docs`);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("N3: SELECT from a table with no same-file CREATE TABLE stays silent", () => {
		const content = "const rows = sql.exec(`SELECT id FROM remote_docs`);";
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("N4: DELETE statements are out of scope — only SELECT is judged", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, deleted_at TEXT)`);",
			"sql.exec(`DELETE FROM docs WHERE id = ?`, [id]);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});
});
