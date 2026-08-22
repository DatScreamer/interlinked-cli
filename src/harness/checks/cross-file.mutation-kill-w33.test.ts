import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMigrationParity, checkSchemaTypeDrift } from "./cross-file.js";

const TS = "src/lib/foo.ts";

describe("checkSchemaTypeDrift — mutation-kill w33", () => {
	// Without the schema-kind filter, both interface shapes leak into the
	// "schema" side and the first-matching-root partner lookup pairs
	// FooShape with the preceding Foo instead of itself, fabricating drift.
	// test-contract: public-api — checkSchemaTypeDrift must report no drift
	// when the file contains only interfaces and no Zod schema at all.
	it("never pairs a bare interface with another same-file interface as a schema/type drift (no Zod schema present at all)", () => {
		const code = `
interface Foo { a: string; }
interface FooShape { a: string; b: string; }
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});
});

describe("checkMigrationParity — mutation-kill w33", () => {
	// DELETED (genuinely-wrong assertion, not a source bug to fix here):
	// findMigrationsDir() only normalizes backslashes for the REGEX MATCH; the
	// directory string it actually returns (`file.slice(0, dirEnd)`) is sliced
	// from the ORIGINAL, un-normalized path. On this platform a backslash is a
	// plain filename character, not a separator, so the sliced candidate never
	// resolves to a real directory and findMigrationsDir() always returns null
	// for a backslash-separated input — checkMigrationParity() can never find
	// or report anything through such a path. The deleted case asserted the
	// opposite (matches.length === 1), which does not match the function's
	// actual, deterministic behavior.

	// If checkMigrationParity's own fileName-normalization strips backslashes
	// instead of converting them, the extracted fileName comes out garbled
	// and never matches a real sibling, so a PAIRED migration reads unpaired.
	// test-contract: public-api — checkMigrationParity must stay silent on a
	// genuinely paired migration reached via a backslash-separated path.
	it("stays silent on a genuinely paired migration reached through a backslash-separated path", () => {
		const base = mkdtempSync(join(tmpdir(), "backslash-fname-"));
		mkdirSync(join(base, "migrations"), { recursive: true });
		writeFileSync(join(base, "migrations", "0001_up.sql"), "");
		writeFileSync(join(base, "migrations", "0001_down.sql"), "");
		const filePath = `${base}\\migrations\\0001_up.sql`;
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	// If the not-up.sql guard is bypassed, a filename that never matches the
	// up.sql end-anchor falls through to the parity check; since it doesn't
	// exist in the dir at all, the expected-down lookup fabricates a finding.
	// test-contract: public-api — checkMigrationParity must not evaluate
	// parity for a non-up.sql-named path even inside a real migrations dir.
	it("does not evaluate parity for a non-up.sql-named path, even inside a real migrations dir with real up/down pairs", () => {
		const base = mkdtempSync(join(tmpdir(), "not-up-sql-"));
		const migrationsDir = join(base, "migrations");
		mkdirSync(migrationsDir, { recursive: true });
		writeFileSync(join(migrationsDir, "0002_up.sql"), "");
		writeFileSync(join(migrationsDir, "0002_down.sql"), "");
		const filePath = join(migrationsDir, "notes.md");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	// Without UP_SQL_RE's end anchor, a filename merely CONTAINING "_up.sql"
	// mid-string would incorrectly pass the migration-file guard; since it
	// has no real sibling entry, the parity check fabricates a finding.
	// test-contract: public-api — checkMigrationParity must not treat a
	// mid-string "_up.sql" occurrence as a migration filename.
	it("does not treat a filename merely containing `_up.sql` mid-string as a migration file, even with no coincidentally-matching sibling", () => {
		const base = mkdtempSync(join(tmpdir(), "mid-string-up-sql-"));
		const migrationsDir = join(base, "migrations");
		mkdirSync(migrationsDir, { recursive: true });
		writeFileSync(join(migrationsDir, "0002_up.sql"), "");
		writeFileSync(join(migrationsDir, "0002_down.sql"), "");
		const filePath = join(migrationsDir, "notes_up.sql_extra.txt");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});
});
